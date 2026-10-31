param(
    [Parameter(Mandatory = $true)]
    [string]$InstallRoot
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$toolsRoot = Join-Path $InstallRoot "tools"
$logPath = Join-Path $InstallRoot "install-dependencies.log"
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
$transcriptStarted = $false
try {
    Start-Transcript -LiteralPath $logPath -Force | Out-Null
    $transcriptStarted = $true
}
catch {
    "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] Could not start setup transcript: $_" |
        Add-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
}

function Write-Status {
    param([string]$Message)
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

function Find-AppTool {
    param([string]$RelativePath)
    $path = Join-Path $toolsRoot $RelativePath
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        return $path
    }
    return $null
}

function Find-PathTool {
    param([string]$Name)
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command) {
        return $command.Source
    }

    $directories = @()
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ }) {
        $directories += @(
            (Join-Path $root "Pandoc"),
            (Join-Path $root "Graphviz\bin"),
            (Join-Path $root "MiKTeX\miktex\bin\x64"),
            (Join-Path $root "nodejs")
        )
    }
    foreach ($root in @($env:LOCALAPPDATA, $env:APPDATA) | Where-Object { $_ }) {
        $directories += @(
            (Join-Path $root "Programs\MiKTeX\miktex\bin\x64"),
            (Join-Path $root "npm")
        )
    }
    $extensions = if ([System.IO.Path]::GetExtension($Name)) {
        @("")
    }
    else {
        @(".exe", ".cmd", ".bat")
    }
    foreach ($directory in $directories) {
        foreach ($extension in $extensions) {
            $path = Join-Path $directory "$Name$extension"
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                return $path
            }
        }
    }
    return $null
}

function Get-NativeCommandOutput {
    param(
        [string]$Executable,
        [string]$Argument
    )

    # Windows PowerShell 5.1 surfaces native stderr as an ErrorRecord. Some
    # tools (notably pdftoppm -v) print a successful version banner to stderr.
    # Temporarily relax the preference so that banner can be captured and the
    # caller can validate the real process exit code.
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $Executable $Argument 2>&1 | Out-String
        $exitCode = $LASTEXITCODE
        return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Invoke-CheckedProcess {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$Description,
        [string]$OutputPath
    )

    $quotedArguments = $Arguments | ForEach-Object {
        '"' + $_.Replace('"', '\"') + '"'
    }
    $process = Start-Process -FilePath $Executable `
        -ArgumentList ($quotedArguments -join " ") `
        -Wait -PassThru -NoNewWindow `
        -RedirectStandardOutput $OutputPath `
        -RedirectStandardError "$OutputPath.err"
    if ($process.ExitCode -ne 0) {
        $details = Get-Content -LiteralPath $OutputPath -Raw -ErrorAction SilentlyContinue
        $errors = Get-Content -LiteralPath "$OutputPath.err" -Raw -ErrorAction SilentlyContinue
        throw "$Description failed with exit code $($process.ExitCode). $errors $details"
    }
}

function Install-Pandoc {
    $destination = Join-Path $toolsRoot "pandoc"
    $downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("MarkDoc-pandoc-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    try {
        Write-Status "Pandoc was not found. Downloading the latest official Windows release."
        $headers = @{ "User-Agent" = "MarkDoc-Desktop-Installer" }
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/jgm/pandoc/releases/latest" -Headers $headers
        $asset = $release.assets |
            Where-Object { $_.name -match '^pandoc-[\d.]+-windows-x86_64\.zip$' } |
            Select-Object -First 1
        if (-not $asset -or $asset.digest -notmatch '^sha256:[0-9a-fA-F]{64}$') {
            throw "The latest Pandoc release did not provide a Windows x64 archive with a SHA-256 digest."
        }

        $archive = Join-Path $downloadDirectory $asset.name
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $archive
        $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        $expectedDigest = $asset.digest.Substring("sha256:".Length)
        if ($actualDigest -ne $expectedDigest) {
            throw "The downloaded Pandoc archive failed its SHA-256 verification."
        }

        $unpacked = Join-Path $downloadDirectory "unpacked"
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        $pandocExecutable = Get-ChildItem -LiteralPath $unpacked -Filter "pandoc.exe" -File -Recurse |
            Select-Object -First 1
        if (-not $pandocExecutable) {
            throw "The downloaded Pandoc archive did not contain pandoc.exe."
        }

        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Get-ChildItem -LiteralPath $pandocExecutable.DirectoryName -Force |
            Copy-Item -Destination $destination -Recurse -Force
        $version = & (Join-Path $destination "pandoc.exe") --version
        if ($LASTEXITCODE -ne 0 -or $version[0] -notmatch '^pandoc ') {
            throw "The app-local Pandoc installation did not pass its version check."
        }
        Write-Status "Installed app-local $($version[0])."
    }
    finally {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-Graphviz {
    $destination = Join-Path $toolsRoot "graphviz"
    $downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("MarkDoc-graphviz-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    try {
        Write-Status "Graphviz was not found. Downloading the latest official Windows x64 archive."
        $page = Invoke-WebRequest -UseBasicParsing -Uri "https://graphviz.org/download/"
        $archiveMatch = [regex]::Match(
            $page.Content,
            'https://gitlab\.com/api/v4/projects/4207231/packages/generic/graphviz-releases/[\d.]+/windows_10_cmake_Release_Graphviz-[\d.]+-win64\.zip'
        )
        if (-not $archiveMatch.Success) {
            throw "The official Graphviz download page did not provide a Windows x64 ZIP archive."
        }

        $archiveUrl = $archiveMatch.Value
        $archiveName = [System.IO.Path]::GetFileName($archiveUrl)
        $archive = Join-Path $downloadDirectory $archiveName
        Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archive
        $checksumResponse = Invoke-WebRequest -UseBasicParsing -Uri "$archiveUrl.sha256"
        $checksum = [regex]::Match($checksumResponse.Content, '(?i)\b[0-9a-f]{64}\b')
        if (-not $checksum.Success) {
            throw "The official Graphviz checksum endpoint returned an invalid SHA-256 digest."
        }
        $actualDigest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        if ($actualDigest -ne $checksum.Value) {
            throw "The downloaded Graphviz archive failed its SHA-256 verification."
        }

        $unpacked = Join-Path $downloadDirectory "unpacked"
        Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
        $dot = Get-ChildItem -LiteralPath $unpacked -Filter "dot.exe" -File -Recurse |
            Where-Object { $_.Directory.Name -eq "bin" } |
            Select-Object -First 1
        if (-not $dot) {
            throw "The downloaded Graphviz archive did not contain bin\dot.exe."
        }

        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Get-ChildItem -LiteralPath $dot.Directory.Parent.FullName -Force |
            Copy-Item -Destination $destination -Recurse -Force
        $probe = Get-NativeCommandOutput -Executable (Join-Path $destination "bin\dot.exe") -Argument "-V"
        if ($probe.ExitCode -ne 0 -or $probe.Output -notmatch 'graphviz version') {
            throw "The app-local Graphviz installation did not pass its version check."
        }
        Write-Status "Installed app-local Graphviz: $($probe.Output.Trim())."
    }
    finally {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-GraphvizRuntime {
    $dot = Find-AppTool "graphviz\bin\dot.exe"
    if (-not $dot) {
        $dot = Find-PathTool "dot"
    }
    if (-not $dot) {
        return $false
    }
    $probe = Get-NativeCommandOutput -Executable $dot -Argument "-V"
    return ($probe.ExitCode -eq 0 -and $probe.Output -match 'graphviz version')
}

function Find-AppBrowser {
    $browserRoots = @(
        (Join-Path $toolsRoot "chromium\chrome\win64"),
        (Join-Path $toolsRoot "chromium\chrome-win64"),
        (Join-Path $env:USERPROFILE ".cache\puppeteer\chrome\win64")
    )
    foreach ($root in $browserRoots) {
        if (Test-Path -LiteralPath $root -PathType Container) {
            $browser = Get-ChildItem -LiteralPath $root -Filter "chrome.exe" -File -Recurse |
                Select-Object -First 1
            if ($browser) {
                return $browser.FullName
            }
        }
    }

    foreach ($variable in @("PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH")) {
        $path = [Environment]::GetEnvironmentVariable($variable)
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) {
            return $path
        }
    }
    foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
        Where-Object { $_ }) {
        foreach ($relative in @(
            "Google\Chrome\Application\chrome.exe",
            "Microsoft\Edge\Application\msedge.exe"
        )) {
            $path = Join-Path $root $relative
            if (Test-Path -LiteralPath $path -PathType Leaf) {
                return $path
            }
        }
    }
    return $null
}

function Test-MermaidRuntime {
    $mmdc = Find-AppTool "mermaid\mmdc.cmd"
    $node = Find-AppTool "mermaid\node.exe"
    if (-not $mmdc) {
        $mmdc = Find-PathTool "mmdc"
    }
    if (-not $node) {
        $node = Find-PathTool "node"
    }
    if (-not $mmdc -or -not $node -or -not (Find-AppBrowser)) {
        return $false
    }
    $nodeVersion = & $node --version 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)') {
        return $false
    }
    return ([version]$Matches[1] -ge [version]"22.13.0")
}

function Install-MermaidRuntime {
    $mermaidRoot = Join-Path $toolsRoot "mermaid"
    $downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("MarkDoc-mermaid-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    try {
        Write-Status "A complete Mermaid runtime was not found. Downloading Node.js, Mermaid CLI, and Chromium."
        $nodeReleases = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
        $nodeRelease = $nodeReleases |
            Where-Object {
                $_.version -match '^v22\.' -and $_.files -contains "win-x64"
            } |
            Select-Object -First 1
        if (-not $nodeRelease) {
            throw "The Node.js download index did not contain a supported Windows x64 release."
        }

        $nodeArchiveName = "node-$($nodeRelease.version)-win-x64.zip"
        $nodeBaseUrl = "https://nodejs.org/dist/$($nodeRelease.version)"
        $checksums = Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/SHASUMS256.txt"
        $checksumLine = $checksums.Content -split "`n" |
            Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))\s*$" } |
            Select-Object -First 1
        if (-not $checksumLine) {
            throw "The Node.js release checksum file did not contain $nodeArchiveName."
        }
        $expectedDigest = ($checksumLine.Trim() -split '\s+')[0]
        $nodeArchive = Join-Path $downloadDirectory $nodeArchiveName
        Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchive
        $actualDigest = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash
        if ($actualDigest -ne $expectedDigest) {
            throw "The downloaded Node.js archive failed its SHA-256 verification."
        }

        $nodeUnpacked = Join-Path $downloadDirectory "node"
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeUnpacked
        $nodeExecutable = Get-ChildItem -LiteralPath $nodeUnpacked -Filter "node.exe" -File -Recurse |
            Select-Object -First 1
        if (-not $nodeExecutable) {
            throw "The downloaded Node.js archive did not contain node.exe."
        }
        New-Item -ItemType Directory -Path $mermaidRoot -Force | Out-Null
        Get-ChildItem -LiteralPath $nodeExecutable.DirectoryName -Force |
            Copy-Item -Destination $mermaidRoot -Recurse -Force

        $node = Join-Path $mermaidRoot "node.exe"
        $npmCli = Join-Path $mermaidRoot "node_modules\npm\bin\npm-cli.js"
        if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) {
            throw "The Node.js archive did not contain npm's command-line entry point."
        }
        $previousBrowserCache = $env:PUPPETEER_CACHE_DIR
        $env:PUPPETEER_CACHE_DIR = Join-Path $toolsRoot "chromium"
        try {
            Invoke-CheckedProcess -Executable $node `
                -Arguments @(
                    $npmCli,
                    "install",
                    "--prefix",
                    $mermaidRoot,
                    "--omit=dev",
                    "--no-audit",
                    "--no-fund",
                    "@mermaid-js/mermaid-cli@12.0.0"
                ) `
                -Description "Mermaid CLI and Chromium installation" `
                -OutputPath (Join-Path $downloadDirectory "npm-install.log")
        }
        finally {
            if ($null -eq $previousBrowserCache) {
                Remove-Item Env:PUPPETEER_CACHE_DIR -ErrorAction SilentlyContinue
            }
            else {
                $env:PUPPETEER_CACHE_DIR = $previousBrowserCache
            }
        }

        $cli = Join-Path $mermaidRoot "node_modules\@mermaid-js\mermaid-cli\src\cli.js"
        $browser = Find-AppBrowser
        if (-not (Test-Path -LiteralPath $cli -PathType Leaf) -or -not $browser) {
            throw "Mermaid setup completed, but its CLI or downloaded Chromium executable is missing."
        }
        @'
@echo off
setlocal
"%~dp0node.exe" "%~dp0node_modules\@mermaid-js\mermaid-cli\src\cli.js" %*
exit /b %ERRORLEVEL%
'@ | Set-Content -LiteralPath (Join-Path $mermaidRoot "mmdc.cmd") -Encoding ASCII
        Write-Status "Installed Mermaid CLI, Node.js, and Chromium under the MarkDoc installation directory."
    }
    finally {
        Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-TexRuntime {
    $relativePaths = @{
        "xelatex" = "miktex\texmfs\install\miktex\bin\x64\xelatex.exe"
        "pdflatex" = "miktex\texmfs\install\miktex\bin\x64\pdflatex.exe"
        "pdftoppm" = "miktex\texmfs\install\miktex\bin\x64\pdftoppm.exe"
        "initexmf" = "miktex\texmfs\install\miktex\bin\x64\initexmf.exe"
    }
    foreach ($name in $relativePaths.Keys) {
        $executable = $null
        foreach ($relativePath in @(
            $relativePaths[$name],
            ($relativePaths[$name] -replace '^miktex\\', '')
        )) {
            $executable = Find-AppTool $relativePath
            if ($executable) { break }
        }
        if (-not $executable) {
            $executable = Find-PathTool $name
        }
        if (-not $executable) {
            return $false
        }
        $versionArgument = if ($name -eq "pdftoppm") { "-v" } else { "--version" }
        $probe = Get-NativeCommandOutput -Executable $executable -Argument $versionArgument
        if ($probe.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($probe.Output)) {
            return $false
        }
    }
    return $true
}

function Install-PortableMiKTeX {
    $downloadDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("MarkDoc-miktex-" + [guid]::NewGuid())
    $repository = Join-Path $downloadDirectory "repository"
    $miktexRoot = Join-Path $toolsRoot "miktex"
    New-Item -ItemType Directory -Path $downloadDirectory -Force | Out-Null
    try {
        Write-Status "A complete TeX toolchain was not found. Downloading the official MiKTeX setup utility."
        $setupArchive = Join-Path $downloadDirectory "miktexsetup-x64.zip"
        Invoke-WebRequest -UseBasicParsing -Uri "https://miktex.org/download/win/miktexsetup-x64.zip" -OutFile $setupArchive
        Expand-Archive -LiteralPath $setupArchive -DestinationPath $downloadDirectory
        $setup = Get-ChildItem -LiteralPath $downloadDirectory -Filter "miktexsetup_standalone.exe" -File -Recurse |
            Select-Object -First 1
        if (-not $setup) {
            throw "The MiKTeX setup archive did not contain miktexsetup_standalone.exe."
        }
        $signature = Get-AuthenticodeSignature -FilePath $setup.FullName
        if ($signature.Status -ne "Valid") {
            throw "The downloaded MiKTeX setup utility does not have a valid Authenticode signature."
        }

        New-Item -ItemType Directory -Path $repository -Force | Out-Null
        Invoke-CheckedProcess -Executable $setup.FullName `
            -Arguments @(
                "--quiet",
                "--local-package-repository=$repository",
                "--package-set=basic",
                "download"
            ) `
            -Description "MiKTeX package download" `
            -OutputPath (Join-Path $downloadDirectory "miktex-download.log")

        Invoke-CheckedProcess -Executable $setup.FullName `
            -Arguments @(
                "--quiet",
                "--local-package-repository=$repository",
                "--package-set=basic",
                "--portable=$miktexRoot",
                "--use-registry=no",
                "--modify-path=no",
                "install"
            ) `
            -Description "Portable MiKTeX installation" `
            -OutputPath (Join-Path $downloadDirectory "miktex-install.log")

        if (-not (Test-TexRuntime)) {
            throw "MiKTeX setup completed, but required TeX executables were not found in $miktexRoot."
        }
        Write-Status "Installed portable MiKTeX under the MarkDoc installation directory."
    }
    catch {
        Write-Status "MiKTeX setup failed. Temporary setup files were retained at $downloadDirectory."
        throw
    }
    finally {
        if (Test-TexRuntime) {
            Remove-Item -LiteralPath $downloadDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

try {
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "MarkDoc desktop requires 64-bit Windows."
    }

    $pandoc = Find-AppTool "pandoc\pandoc.exe"
    if (-not $pandoc) {
        $pandoc = Find-PathTool "pandoc"
    }
    if ($pandoc) {
        $version = & $pandoc --version
        if ($LASTEXITCODE -ne 0 -or $version[0] -notmatch '^pandoc ') {
            throw "The detected Pandoc executable failed its version check: $pandoc"
        }
        Write-Status "Using existing $($version[0]) at $pandoc."
    }
    else {
        Install-Pandoc
    }

    if (Test-TexRuntime) {
        Write-Status "Using the existing TeX tools found on PATH, in a standard install location, or in MarkDoc's tools directory."
    }
    else {
        Install-PortableMiKTeX
    }

    if (-not (Test-GraphvizRuntime)) {
        Install-Graphviz
    }
    else {
        Write-Status "Using the existing, verified Graphviz executable."
    }

    if (-not (Test-MermaidRuntime)) {
        Install-MermaidRuntime
    }
    else {
        Write-Status "Using the existing Mermaid, Node.js, and browser runtime."
    }
}
catch {
    Write-Status "Dependency setup failed: $_"
    throw
}
finally {
    if ($transcriptStarted) {
        Stop-Transcript | Out-Null
    }
}
