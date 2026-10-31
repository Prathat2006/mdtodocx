use regex::Regex;
use std::{
    env,
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};
use wait_timeout::ChildExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const MARKDOWN_FORMAT: &str =
    "markdown+pipe_tables+grid_tables+multiline_tables+tex_math_dollars+tex_math_single_backslash+strikeout";
const TIKZ_PREAMBLE: &str = concat!(
    "\\documentclass[tikz,border=8pt]{standalone}\n",
    "\\usepackage{pgfplots,pgfplotstable}\n",
    "\\pgfplotsset{compat=newest}\n",
    "\\usetikzlibrary{arrows.meta,calc,chains,decorations.pathmorphing,",
    "decorations.pathreplacing,fit,matrix,positioning,patterns,quotes,angles,",
    "backgrounds,shapes.geometric,shapes.misc}\n"
);

pub struct ToolPaths {
    pub resource_dir: PathBuf,
    pub data_dir: PathBuf,
    pub development: bool,
}

pub struct ExportOptions<'a> {
    pub markdown: &'a str,
    pub filename: &'a str,
    pub reference: &'a str,
    pub references: &'a Path,
    pub tools: &'a ToolPaths,
    pub puppeteer_config: &'a Path,
}

fn app_tools_roots(tools: &ToolPaths) -> Vec<PathBuf> {
    let mut roots = vec![tools.resource_dir.join("tools")];
    if !tools.development {
        if let Some(executable_dir) = env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            let install_tools = executable_dir.join("tools");
            if !roots.contains(&install_tools) {
                roots.push(install_tools);
            }
        }
    }
    roots
}

fn app_local_miktex_bin(tools: &ToolPaths) -> PathBuf {
    for root in app_tools_roots(tools) {
        let legacy = root
            .join("miktex")
            .join("texmfs")
            .join("install")
            .join("miktex")
            .join("bin")
            .join("x64");
        if legacy.is_dir() {
            return legacy;
        }
        let current = root
            .join("miktex")
            .join("texmfs")
            .join("install")
            .join("bin")
            .join("x64");
        if current.is_dir() {
            return current;
        }
    }
    app_tools_roots(tools)
        .into_iter()
        .next()
        .unwrap_or_else(|| tools.resource_dir.join("tools"))
        .join("miktex")
        .join("texmfs")
        .join("install")
        .join("bin")
        .join("x64")
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH").unwrap_or_default();
    let path_directories = env::split_paths(&path);
    find_on_path_in(name, path_directories.chain(known_tool_directories()))
}

#[cfg(windows)]
fn known_tool_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(root) = env::var_os(variable).map(PathBuf::from) {
            directories.push(root.join("Pandoc"));
            directories.push(root.join("Graphviz").join("bin"));
            directories.push(root.join("MiKTeX").join("miktex").join("bin").join("x64"));
            directories.push(root.join("nodejs"));
        }
    }
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        if let Some(root) = env::var_os(variable).map(PathBuf::from) {
            directories.push(
                root.join("Programs")
                    .join("MiKTeX")
                    .join("miktex")
                    .join("bin")
                    .join("x64"),
            );
            directories.push(root.join("npm"));
        }
    }
    directories
}

#[cfg(not(windows))]
fn known_tool_directories() -> Vec<PathBuf> {
    Vec::new()
}

fn find_on_path_in(name: &str, directories: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    directories
        .into_iter()
        .flat_map(|directory| {
            let mut candidates = Vec::new();
            #[cfg(windows)]
            if Path::new(name).extension().is_none() {
                let extensions =
                    env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
                candidates.extend(
                    extensions
                        .split(';')
                        .map(|extension| directory.join(format!("{name}{extension}"))),
                );
            }
            candidates.push(directory.join(name));
            candidates
        })
        .find(|path| path.is_file())
}

fn available_tool(tools: &ToolPaths, name: &str) -> Result<PathBuf, String> {
    let candidates: &[&str] = match name {
        "pandoc" => &["tools/pandoc/pandoc.exe", "tools/pandoc/pandoc"],
        "mmdc" => &["tools/mermaid/mmdc.cmd", "tools/mermaid/mmdc"],
        "dot" => &["tools/graphviz/bin/dot.exe", "tools/graphviz/bin/dot"],
        "xelatex" => &[
            "tools/miktex/texmfs/install/miktex/bin/x64/xelatex.exe",
            "tools/miktex/texmfs/install/bin/x64/xelatex.exe",
        ],
        "pdflatex" => &[
            "tools/miktex/texmfs/install/miktex/bin/x64/pdflatex.exe",
            "tools/miktex/texmfs/install/bin/x64/pdflatex.exe",
        ],
        "pdftoppm" => &[
            "tools/miktex/texmfs/install/miktex/bin/x64/pdftoppm.exe",
            "tools/miktex/texmfs/install/bin/x64/pdftoppm.exe",
        ],
        "initexmf" => &[
            "tools/miktex/texmfs/install/miktex/bin/x64/initexmf.exe",
            "tools/miktex/texmfs/install/bin/x64/initexmf.exe",
        ],
        _ => return Err(format!("Unknown tool: {name}")),
    };
    for root in app_tools_roots(tools) {
        for candidate in candidates {
            let relative = candidate.strip_prefix("tools/").unwrap_or(candidate);
            let path = root.join(relative);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    if let Some(path) = find_on_path(name) {
        return Ok(path);
    }
    Err(format!(
        "The {name} executable was not found in MarkDoc's tools folder or on PATH."
    ))
}

fn find_app_browser(tool_root: &Path) -> Option<PathBuf> {
    let standard_browser = tool_root
        .join("chromium")
        .join("chrome-win64")
        .join("chrome.exe");
    let mut browser_directories = vec![tool_root.join("chromium").join("chrome").join("win64")];
    if let Some(cache_dir) = env::var_os("PUPPETEER_CACHE_DIR") {
        browser_directories.push(PathBuf::from(cache_dir).join("chrome").join("win64"));
    }
    if let Some(user_profile) = env::var_os("USERPROFILE") {
        browser_directories.push(
            PathBuf::from(user_profile)
                .join(".cache")
                .join("puppeteer")
                .join("chrome")
                .join("win64"),
        );
    }
    browser_directories.push(
        tool_root
            .join("mermaid")
            .join("cli")
            .join("node_modules")
            .join("puppeteer")
            .join(".local-chromium"),
    );
    for candidate in browser_directories {
        if candidate.is_dir() {
            if let Ok(versions) = candidate.read_dir() {
                for version in versions.flatten().map(|version| version.path()) {
                    let browser = version.join("chrome-win64").join("chrome.exe");
                    if browser.is_file() {
                        return Some(browser);
                    }
                }
            }
        }
    }
    if standard_browser.is_file() {
        return Some(standard_browser);
    }

    for variable in ["PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"] {
        if let Some(path) = env::var_os(variable)
            .map(PathBuf::from)
            .filter(|path| path.is_file())
        {
            return Some(path);
        }
    }
    let roots = ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"];
    for root in roots {
        if let Some(root) = env::var_os(root) {
            for relative in [
                "Google/Chrome/Application/chrome.exe",
                "Microsoft/Edge/Application/msedge.exe",
            ] {
                let path = PathBuf::from(&root).join(relative);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    find_on_path("chrome")
}

fn command_for(executable: &Path) -> Command {
    #[cfg(windows)]
    {
        if executable
            .extension()
            .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("cmd"))
        {
            let mut command = Command::new("cmd.exe");
            command
                .arg("/D")
                .arg("/S")
                .arg("/C")
                .arg("call")
                .arg(executable);
            return command;
        }
    }
    Command::new(executable)
}

fn configure_runtime(
    command: &mut Command,
    executable: &Path,
    tools: &ToolPaths,
) -> Result<(), String> {
    if tools.development {
        return Ok(());
    }

    let tool_roots = app_tools_roots(tools);
    let mut app_paths = tool_roots
        .iter()
        .flat_map(|tool_root| {
            [
                tool_root.join("pandoc"),
                tool_root.join("mermaid"),
                tool_root.join("graphviz").join("bin"),
            ]
        })
        .collect::<Vec<_>>();
    app_paths.push(app_local_miktex_bin(tools));
    app_paths.retain(|path| path.is_dir());
    if let Some(system_root) = env::var_os("SystemRoot") {
        app_paths.push(PathBuf::from(system_root).join("System32"));
    }
    let path = env::join_paths(
        app_paths
            .into_iter()
            .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default())),
    )
    .map_err(|error| error.to_string())?;
    command.env("PATH", path);

    if let Some(browser) = tool_roots.iter().find_map(|root| find_app_browser(root)) {
        command.env("PUPPETEER_EXECUTABLE_PATH", browser);
    } else if executable
        .file_stem()
        .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("mmdc"))
    {
        return Err("No Chromium, Chrome, or Edge executable was found for Mermaid.".into());
    }

    let miktex = app_local_miktex_bin(tools);
    if miktex.is_dir() {
        let config = tools.data_dir.join("miktex").join("config");
        let data = tools.data_dir.join("miktex").join("data");
        let install = tools.data_dir.join("miktex").join("install");
        fs::create_dir_all(&config).map_err(|error| error.to_string())?;
        fs::create_dir_all(&data).map_err(|error| error.to_string())?;
        fs::create_dir_all(&install).map_err(|error| error.to_string())?;
        command
            .env("MIKTEX_USERCONFIG", config)
            .env("MIKTEX_USERDATA", data)
            .env("MIKTEX_USERINSTALL", install);
    }
    Ok(())
}

fn run(
    tools: &ToolPaths,
    executable: &Path,
    args: &[String],
    cwd: Option<&Path>,
    stdin: Option<&[u8]>,
    logs: &Path,
) -> Result<Vec<u8>, String> {
    let stdout_path = logs.join("process.stdout");
    let stderr_path = logs.join("process.stderr");
    let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
    let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
    let mut command = command_for(executable);
    configure_runtime(&mut command, executable, tools)?;
    command
        .args(args)
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let mut child = command.spawn().map_err(|error| {
        let working_directory = cwd
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "inherited working directory".to_owned());
        format!(
            "Could not start {} with working directory {working_directory}: {error}",
            executable.display()
        )
    })?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input).map_err(|error| error.to_string())?;
        }
    }
    match child.wait_timeout(Duration::from_secs(120)) {
        Ok(Some(status)) if status.success() => {
            fs::read(stdout_path).map_err(|error| error.to_string())
        }
        Ok(Some(_)) => {
            let stderr = fs::read_to_string(stderr_path).unwrap_or_default();
            let stdout = fs::read_to_string(stdout_path).unwrap_or_default();
            let detail = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            Err(if detail.trim().is_empty() {
                format!("{} returned an error.", executable.display())
            } else {
                detail.trim().to_owned()
            })
        }
        Ok(None) => {
            child.kill().map_err(|error| error.to_string())?;
            let _ = child.wait();
            Err(format!(
                "{} timed out after 120 seconds.",
                executable.display()
            ))
        }
        Err(error) => Err(format!("Could not wait for export process: {error}")),
    }
}

fn replace_matches(
    source: &str,
    pattern: &Regex,
    mut render: impl FnMut(&str, usize) -> Result<String, String>,
) -> Result<String, String> {
    let matches = pattern
        .captures_iter(source)
        .filter_map(|capture| {
            let whole = capture.get(0)?;
            let body = capture.get(1)?;
            Some((whole.start(), whole.end(), body.as_str().to_owned()))
        })
        .collect::<Vec<_>>();
    let mut result = source.to_owned();
    for (index, (start, end, body)) in matches.into_iter().enumerate().rev() {
        let image = render(&body, index + 1)?;
        result.replace_range(start..end, &image);
    }
    Ok(result)
}

fn preprocess(markdown: &str) -> Result<String, String> {
    let markdown = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let table_regex =
        Regex::new(r"(?is)<table\b[\s\S]*?</table>").map_err(|error| error.to_string())?;
    let mut tables = Vec::new();
    let protected = table_regex.replace_all(&markdown, |capture: &regex::Captures<'_>| {
        tables.push(capture[0].to_owned());
        format!("\0RAWTABLE{}\0", tables.len() - 1)
    });
    let mut in_fence: Option<char> = None;
    let mut lines = Vec::new();
    for line in protected.split('\n') {
        let trimmed = line.trim_start();
        let fence = trimmed
            .chars()
            .take_while(|character| *character == '`' || *character == '~')
            .collect::<String>();
        if let Some(marker) = in_fence {
            lines.push(line.to_owned());
            if fence.len() >= 3 && fence.starts_with(marker) {
                in_fence = None;
            }
            continue;
        }
        if fence.len() >= 3 {
            in_fence = fence.chars().next();
            lines.push(line.to_owned());
            continue;
        }
        let leading = line.len() - line.trim_start_matches([' ', '\t']).len();
        if leading == 0 {
            lines.push(line.to_owned());
            continue;
        }
        let rest = &line[leading..];
        if rest.is_empty()
            || rest.starts_with('<')
            || rest.starts_with("- ")
            || rest.starts_with("+ ")
            || rest.starts_with("* ")
            || rest.starts_with("> ")
            || rest
                .find(". ")
                .is_some_and(|index| index > 0 && rest[..index].chars().all(|c| c.is_ascii_digit()))
        {
            lines.push(line.to_owned());
            continue;
        }
        let columns = line[..leading].chars().fold(0, |columns, character| {
            if character == '\t' {
                columns + (4 - columns % 4)
            } else {
                columns + 1
            }
        });
        if columns < 4 {
            lines.push(line.to_owned());
        } else {
            lines.push(format!("{}{}", "\u{00a0}".repeat(columns), rest));
        }
    }
    let protected = lines.join("\n");
    let placeholder = Regex::new(r"\x00RAWTABLE(\d+)\x00").map_err(|error| error.to_string())?;
    Ok(placeholder
        .replace_all(&protected, |capture: &regex::Captures<'_>| {
            tables[capture[1].parse::<usize>().unwrap()].clone()
        })
        .into_owned())
}

fn pandoc_html(markdown: &str, tools: &ToolPaths, logs: &Path) -> Result<String, String> {
    if markdown.trim().is_empty() {
        return Ok(String::new());
    }
    let pandoc = available_tool(tools, "pandoc")?;
    let args = vec![
        format!("--from={MARKDOWN_FORMAT}"),
        "--to=html".to_owned(),
        "--mathml".to_owned(),
        "--wrap=none".to_owned(),
    ];
    let output = run(tools, &pandoc, &args, None, Some(markdown.as_bytes()), logs)?;
    String::from_utf8(output).map_err(|error| error.to_string())
}

fn render_mermaid(
    markdown: &str,
    tools: &ToolPaths,
    config: &Path,
    job: &Path,
) -> Result<String, String> {
    let pattern =
        Regex::new(r"(?is)```mermaid\s*\n([\s\S]*?)\n```").map_err(|error| error.to_string())?;
    replace_matches(markdown, &pattern, |source, index| {
        let input = job.join(format!("diagram-{index}.mmd"));
        let image = job.join(format!("diagram-{index}.png"));
        fs::write(&input, format!("{}\n", source.trim())).map_err(|error| error.to_string())?;
        let cli = available_tool(tools, "mmdc")?;
        let args = vec![
            "-p".into(),
            config.to_string_lossy().into_owned(),
            "-i".into(),
            input.to_string_lossy().into_owned(),
            "-o".into(),
            image.to_string_lossy().into_owned(),
            "--backgroundColor".into(),
            "transparent".into(),
        ];
        run(tools, &cli, &args, None, None, job)?;
        if !image.is_file() || image.metadata().map_err(|e| e.to_string())?.len() == 0 {
            return Err(format!(
                "Mermaid diagram {index} did not produce a PNG file."
            ));
        }
        Ok(format!("![Mermaid diagram](diagram-{index}.png)"))
    })
}

fn render_graphviz(markdown: &str, tools: &ToolPaths, job: &Path) -> Result<String, String> {
    let pattern = Regex::new(r"(?is)```(?:dot|graphviz)\s*\n([\s\S]*?)\n```")
        .map_err(|error| error.to_string())?;
    replace_matches(markdown, &pattern, |source, index| {
        let input = job.join(format!("graphviz-{index}.dot"));
        let image = job.join(format!("graphviz-{index}.png"));
        fs::write(&input, format!("{}\n", source.trim())).map_err(|error| error.to_string())?;
        let dot = available_tool(tools, "dot")?;
        let args = vec![
            "-Tpng".into(),
            "-Gdpi=300".into(),
            input.to_string_lossy().into_owned(),
            "-o".into(),
            image.to_string_lossy().into_owned(),
        ];
        run(tools, &dot, &args, None, None, job)?;
        if !image.is_file() || image.metadata().map_err(|e| e.to_string())?.len() == 0 {
            return Err(format!(
                "Graphviz diagram {index} did not produce a PNG file."
            ));
        }
        Ok(format!("![Graphviz diagram](graphviz-{index}.png)"))
    })
}

fn render_tikz(markdown: &str, tools: &ToolPaths, job: &Path) -> Result<String, String> {
    let pattern = Regex::new(r"(?is)```(?:tikz|latex-diagram|pgfplots)\s*\n([\s\S]*?)\n```")
        .map_err(|error| error.to_string())?;
    if !pattern.is_match(markdown) {
        return Ok(markdown.to_owned());
    }
    if !tools.development && app_local_miktex_bin(tools).is_dir() {
        let initexmf = available_tool(tools, "initexmf")?;
        run(
            tools,
            &initexmf,
            &["--set-config-value=[MPM]AutoInstall=1".into()],
            None,
            None,
            job,
        )?;
    }
    let directive = Regex::new(
        r"(?s)\\(?:usepackage(?:\[[^\]]*\])?|usetikzlibrary|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{(?:[^{}]|\{[^{}]*\})*\}",
    )
    .map_err(|error| error.to_string())?;
    replace_matches(markdown, &pattern, |source, index| {
        if Regex::new(r"\\(?:input|include)\b")
            .map_err(|error| error.to_string())?
            .is_match(source)
        {
            return Err(
                "TikZ diagrams must be self-contained: \\input/\\include of external .tex files is not supported."
                    .to_owned(),
            );
        }
        let work = job.join(format!("tikz-work-{index}"));
        fs::create_dir_all(&work).map_err(|error| error.to_string())?;
        let tex = work.join("diagram.tex");
        let body = if source.contains("\\documentclass") {
            source.to_owned()
        } else {
            let additions = directive
                .find_iter(source)
                .map(|found| format!("{}\n", found.as_str()))
                .collect::<String>();
            let body = directive.replace_all(source, "").trim().to_owned();
            format!("{TIKZ_PREAMBLE}{additions}\n\\begin{{document}}\n{body}\n\\end{{document}}\n")
        };
        fs::write(&tex, body).map_err(|error| error.to_string())?;
        let engine =
            available_tool(tools, "xelatex").or_else(|_| available_tool(tools, "pdflatex"))?;
        run(
            tools,
            &engine,
            &[
                "-interaction=nonstopmode".into(),
                "-halt-on-error".into(),
                "-file-line-error".into(),
                "diagram.tex".into(),
            ],
            Some(&work),
            None,
            job,
        )
        .map_err(|error| format!("TikZ diagram {index} could not be compiled: {error}"))?;
        let pdf = work.join("diagram.pdf");
        let image_stem = job.join(format!("tikz-{index}"));
        let rasterizer = available_tool(tools, "pdftoppm")?;
        run(
            tools,
            &rasterizer,
            &[
                "-png".into(),
                "-r".into(),
                "300".into(),
                "-singlefile".into(),
                pdf.to_string_lossy().into_owned(),
                image_stem.to_string_lossy().into_owned(),
            ],
            None,
            None,
            job,
        )?;
        if !image_stem.with_extension("png").is_file() {
            return Err(format!("TikZ diagram {index} did not produce a PNG file."));
        }
        Ok(format!("![TikZ diagram](tikz-{index}.png)"))
    })
}

pub fn render_tikz_preview(source: &str, tools: &ToolPaths, job: &Path) -> Result<Vec<u8>, String> {
    let markdown = format!("```tikz\n{source}\n```");
    let rendered = render_tikz(&markdown, tools, job)?;
    if rendered == markdown {
        return Err("TikZ preview could not be rendered.".into());
    }
    let image = job.join("tikz-1.png");
    fs::read(image).map_err(|error| error.to_string())
}

fn markdown_document(markdown: &str, tools: &ToolPaths, job: &Path) -> Result<String, String> {
    let tables = Regex::new(r"(?is)<table\b[\s\S]*?</table>").map_err(|error| error.to_string())?;
    let mut result = String::new();
    let mut last = 0;
    for found in tables.find_iter(markdown) {
        result.push_str(&pandoc_html(&markdown[last..found.start()], tools, job)?);
        result.push('\n');
        result.push_str(found.as_str());
        result.push('\n');
        last = found.end();
    }
    result.push_str(&pandoc_html(&markdown[last..], tools, job)?);
    Ok(result)
}

pub fn convert(options: ExportOptions<'_>) -> Result<(Vec<u8>, String), String> {
    let job = tempfile::Builder::new()
        .prefix("mdtodocx-export-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    let markdown = preprocess(options.markdown)?;
    let markdown = render_mermaid(
        &markdown,
        options.tools,
        options.puppeteer_config,
        job.path(),
    )?;
    let markdown = render_graphviz(&markdown, options.tools, job.path())?;
    let markdown = render_tikz(&markdown, options.tools, job.path())?;
    let html = markdown_document(&markdown, options.tools, job.path())?;
    let html_path = job.path().join("document.html");
    let output_path = job.path().join("document.docx");
    fs::write(&html_path, html).map_err(|error| error.to_string())?;

    let pandoc = available_tool(options.tools, "pandoc")?;
    let mut args = vec![
        "--standalone".into(),
        "--mathml".into(),
        "--wrap=none".into(),
        format!("--resource-path={}", job.path().display()),
        "--highlight-style=tango".into(),
    ];
    if !options.reference.is_empty() {
        let reference = options
            .references
            .join(format!("{}.docx", options.reference));
        if reference.is_file() {
            args.push("--reference-doc".into());
            args.push(reference.to_string_lossy().into_owned());
        }
    }
    args.extend([
        "--from=html".into(),
        "--to=docx".into(),
        format!("--output={}", output_path.display()),
        html_path.to_string_lossy().into_owned(),
    ]);
    run(options.tools, &pandoc, &args, None, None, job.path())?;
    let bytes = fs::read(output_path).map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Err("Pandoc produced an empty DOCX file.".into());
    }
    let filename = Path::new(options.filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("document")
        .to_owned();
    Ok((bytes, filename))
}

#[cfg(test)]
mod tests {
    use super::{
        available_tool, configure_runtime, convert, find_on_path_in, preprocess, ExportOptions,
        ToolPaths,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        process::Command,
    };
    use tempfile::tempdir;

    #[test]
    fn packaged_tool_lookup_prefers_app_resources() {
        let temp = tempdir().unwrap();
        let executable = temp.path().join("tools/pandoc/pandoc.exe");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"").unwrap();
        let tools = ToolPaths {
            resource_dir: temp.path().to_path_buf(),
            data_dir: temp.path().to_path_buf(),
            development: false,
        };

        assert_eq!(available_tool(&tools, "pandoc").unwrap(), executable);
        assert!(available_tool(&tools, "unknown").is_err());
    }

    #[test]
    fn packaged_tool_lookup_can_use_path() {
        let temp = tempdir().unwrap();
        let executable = temp.path().join(if cfg!(windows) {
            "pandoc.exe"
        } else {
            "pandoc"
        });
        fs::write(&executable, b"").unwrap();

        let found = find_on_path_in("pandoc", [temp.path().to_path_buf()]).unwrap();
        assert_eq!(
            found.to_string_lossy().to_ascii_lowercase(),
            executable.to_string_lossy().to_ascii_lowercase()
        );
    }

    #[test]
    fn packaged_runtime_uses_bundled_browser_and_app_data_for_miktex() {
        let temp = tempdir().unwrap();
        let tool_root = temp.path().join("tools");
        let browser = tool_root
            .join("chromium")
            .join("chrome-win64")
            .join("chrome.exe");
        let miktex = tool_root
            .join("miktex")
            .join("texmfs")
            .join("install")
            .join("miktex")
            .join("bin")
            .join("x64");
        fs::create_dir_all(browser.parent().unwrap()).unwrap();
        fs::create_dir_all(&miktex).unwrap();
        fs::write(&browser, b"").unwrap();
        let data_dir = temp.path().join("app-data");
        let tools = ToolPaths {
            resource_dir: temp.path().to_path_buf(),
            data_dir: data_dir.clone(),
            development: false,
        };
        let mut command = Command::new("mmdc.cmd");

        configure_runtime(&mut command, Path::new("mmdc.cmd"), &tools).unwrap();

        let variables = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_os_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(
            variables["PUPPETEER_EXECUTABLE_PATH"].as_ref().unwrap(),
            &browser.into_os_string()
        );
        assert_eq!(
            variables["MIKTEX_USERCONFIG"].as_ref().unwrap(),
            &data_dir.join("miktex").join("config").into_os_string()
        );
        assert!(data_dir.join("miktex").join("config").is_dir());
        assert!(data_dir.join("miktex").join("data").is_dir());
        assert!(data_dir.join("miktex").join("install").is_dir());
    }

    #[test]
    fn disables_indented_code_but_preserves_fenced_code() {
        let output = preprocess("    plain text\n\n```text\n    fenced code\n```\n")
            .expect("preprocessing should succeed");
        assert!(output.contains("\u{00a0}\u{00a0}\u{00a0}\u{00a0}plain text"));
        assert!(output.contains("```text\n    fenced code\n```"));
    }

    #[test]
    fn preserves_raw_html_tables_verbatim() {
        let table = "<table>\n  <tr>\n    <td rowspan=\"2\">x</td>\n  </tr>\n</table>";
        let output = preprocess(&format!("{table}\n\n    regular text"))
            .expect("preprocessing should succeed");
        assert!(output.starts_with(table));
        assert!(output.ends_with("\u{00a0}\u{00a0}\u{00a0}\u{00a0}regular text"));
    }

    #[test]
    #[ignore = "requires Pandoc, Mermaid CLI, Graphviz, and a TeX distribution"]
    fn exports_markdown_with_all_diagram_types() {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let resource_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let bundled_runtime = resource_dir.join("tools/pandoc/pandoc.exe").is_file();
        let data = tempdir().unwrap();
        let tools = ToolPaths {
            resource_dir: if bundled_runtime {
                resource_dir
            } else {
                project_root.clone()
            },
            data_dir: data.path().to_path_buf(),
            development: !bundled_runtime,
        };
        let markdown = r#"# Desktop export

Inline math: $x^2$.

| A | B |
|---|---|
| 1 | 2 |

<table><tr><td rowspan="2">Raw</td></tr><tr><td>HTML</td></tr></table>

```mermaid
flowchart LR
  A --> B
```

```dot
digraph G { A -> B }
```

```tikz
\begin{tikzpicture}
  \draw (0,0) -- (1,1);
\end{tikzpicture}
```
"#;
        let (docx, filename) = convert(ExportOptions {
            markdown,
            filename: "desktop-test.md",
            reference: "Default",
            references: &project_root.join("references"),
            tools: &tools,
            puppeteer_config: &project_root.join("puppeteer-config.json"),
        })
        .expect("all export steps should succeed");
        assert_eq!(filename, "desktop-test");
        assert!(docx.starts_with(b"PK"));
    }
}
