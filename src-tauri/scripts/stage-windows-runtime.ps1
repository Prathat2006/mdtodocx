param(
    [string]$PandocRoot = "C:\Program Files\Pandoc",
    [string]$GraphvizRoot = "C:\Program Files\Graphviz",
    [string]$MermaidCliRoot = "$env:APPDATA\npm\node_modules\@mermaid-js\mermaid-cli",
    [string]$NodeExe = "C:\Program Files\nodejs\node.exe",
    [string]$ChromiumRoot = "$env:USERPROFILE\.cache\puppeteer\chrome\win64-156.0.8078.47\chrome-win64",
    [Parameter(Mandatory = $true)]
    [string]$MiKTeXPortableRoot
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot "resources"
$toolsRoot = Join-Path $resourceRoot "tools"

function Assert-Path {
    param([string]$Path, [string]$Description)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description was not found: $Path"
    }
}

Assert-Path (Join-Path $PandocRoot "pandoc.exe") "Pandoc executable"
Assert-Path (Join-Path $PandocRoot "COPYRIGHT.txt") "Pandoc copyright notice"
Assert-Path (Join-Path $GraphvizRoot "bin\dot.exe") "Graphviz executable"
Assert-Path (Join-Path $GraphvizRoot "bin") "Graphviz runtime directory"
Assert-Path (Join-Path $MermaidCliRoot "package.json") "Mermaid CLI package"
Assert-Path (Join-Path $MermaidCliRoot "node_modules\puppeteer\package.json") "Puppeteer package"
Assert-Path (Join-Path $MermaidCliRoot "node_modules\puppeteer-core\lib\puppeteer\revisions.js") "Puppeteer browser revision"
Assert-Path $NodeExe "Node.js executable"
Assert-Path (Join-Path $ChromiumRoot "chrome.exe") "Chromium executable"
$miktexBin = Join-Path $MiKTeXPortableRoot "texmfs\install\miktex\bin\x64"
Assert-Path (Join-Path $miktexBin "xelatex.exe") "Portable MiKTeX XeLaTeX"
Assert-Path (Join-Path $miktexBin "pdflatex.exe") "Portable MiKTeX pdfLaTeX"
Assert-Path (Join-Path $miktexBin "pdftoppm.exe") "Portable MiKTeX Poppler renderer"
Assert-Path (Join-Path $miktexBin "initexmf.exe") "Portable MiKTeX configuration tool"
Assert-Path (Join-Path $MiKTeXPortableRoot "texmfs\install\tex") "Portable MiKTeX package tree"

$mermaidPackage = Get-Content -LiteralPath (Join-Path $MermaidCliRoot "package.json") -Raw | ConvertFrom-Json
if ($mermaidPackage.version -ne "12.0.0") {
    throw "Expected Mermaid CLI 12.0.0, found $($mermaidPackage.version)."
}
$nodeVersion = (& $NodeExe --version).Trim().TrimStart("v")
if ([version]$nodeVersion -lt [version]"22.13.0") {
    throw "Mermaid CLI 12 requires Node.js 22.13.0 or later; found $nodeVersion."
}
$revisionsFile = Join-Path $MermaidCliRoot "node_modules\puppeteer-core\lib\puppeteer\revisions.js"
$revisions = Get-Content -LiteralPath $revisionsFile -Raw
$expectedBrowser = [regex]::Match($revisions, "chrome:\s*'([^']+)'").Groups[1].Value
$browserCacheVersion = Split-Path (Split-Path $ChromiumRoot -Parent) -Leaf
if (-not $expectedBrowser -or $browserCacheVersion -ne "win64-$expectedBrowser") {
    throw "Chromium $browserCacheVersion does not match the Puppeteer revision $expectedBrowser."
}

New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
Get-ChildItem -LiteralPath $toolsRoot -Force |
    Where-Object Name -ne ".gitkeep" |
    Remove-Item -Recurse -Force

$pandocDestination = Join-Path $toolsRoot "pandoc"
New-Item -ItemType Directory -Path $pandocDestination | Out-Null
Copy-Item -LiteralPath (Join-Path $PandocRoot "pandoc.exe") -Destination $pandocDestination
Copy-Item -LiteralPath (Join-Path $PandocRoot "COPYRIGHT.txt") -Destination $pandocDestination
if (Test-Path -LiteralPath (Join-Path $PandocRoot "COPYING.rtf")) {
    Copy-Item -LiteralPath (Join-Path $PandocRoot "COPYING.rtf") -Destination $pandocDestination
}

Copy-Item -LiteralPath $GraphvizRoot -Destination (Join-Path $toolsRoot "graphviz") -Recurse

$mermaidDestination = Join-Path $toolsRoot "mermaid"
$packageDestination = Join-Path $mermaidDestination "cli"
New-Item -ItemType Directory -Path $mermaidDestination -Force | Out-Null
Copy-Item -LiteralPath $MermaidCliRoot -Destination $packageDestination -Recurse
Copy-Item -LiteralPath $NodeExe -Destination (Join-Path $mermaidDestination "node.exe")
@'
@echo off
setlocal
"%~dp0node.exe" "%~dp0cli\src\cli.js" %*
exit /b %ERRORLEVEL%
'@ | Set-Content -LiteralPath (Join-Path $mermaidDestination "mmdc.cmd") -Encoding ASCII

$chromiumDestination = Join-Path $toolsRoot "chromium"
New-Item -ItemType Directory -Path $chromiumDestination | Out-Null
Copy-Item -LiteralPath $ChromiumRoot -Destination (Join-Path $chromiumDestination "chrome-win64") -Recurse

Copy-Item -LiteralPath $MiKTeXPortableRoot -Destination (Join-Path $toolsRoot "miktex") -Recurse

Write-Output "Staged the Windows runtime at $toolsRoot"
Write-Output "MiKTeX and its bundled packages must be a self-contained portable installation."
