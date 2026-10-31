# AGENTS.md

## What this is

Markdown editor (React) + FastAPI backend that exports Markdown to DOCX via Pandoc. The web backend is `main.py`; the SPA is `frontend/src/main.jsx` (plus `frontend/src/eqShortcuts.js` for the equation shortcut DSL). The Windows Tauri/Rust desktop backend under `src-tauri/` serves the existing frontend unchanged over loopback and implements the same API for a single local account. Do not modify the frontend for desktop integration. The Rust export pipeline is implemented; staged Windows runtime binaries are build inputs and are not checked into Git.

## Commands

```powershell
uv run uvicorn main:app --reload          # backend on 127.0.0.1:8000 (= run.bat / run.sh)
cd frontend; npm run dev                  # frontend on 5173, proxies /api to 127.0.0.1:8000
cd frontend; npm run build                # bundles frontend/dist; FastAPI serves it when present, so backend alone then serves the whole app on 8000
cargo tauri dev                           # Windows desktop app (Rust backend, existing frontend)
cargo tauri build --bundles nsis,msi       # Windows NSIS and MSI installers; reference templates are installer resources
docker build -t mdtodocx . ; docker run -d -p 6789:6789 --name mdtodocx mdtodocx   # full app on port 6789
```

Rust desktop checks (run from the repository root; the shell must have the Visual Studio C++ linker/SDK environment — in this checkout the Build Tools live under `D:\Visual Studio build tools`, so wrap builds with `cmd /c "call "D:\Visual Studio build tools\VC\Auxiliary\Build\vcvars64.bat" && cargo tauri build"`):

```powershell
cargo fmt --manifest-path src-tauri\Cargo.toml -- --check
cargo test --manifest-path src-tauri\Cargo.toml
```

- Desktop runtime code is in `src-tauri/src/`; it serves the production frontend and implements the existing `/api/...` contract locally. Release builds keep all data next to the installed executable (portable: install to `D:\Markdoc` → database, export scratch and MiKTeX user config live under `D:\Markdoc`); when the install directory is unwritable (e.g. Program Files), or in `cargo tauri dev` builds, they fall back to Tauri's per-user app-data directory (`%APPDATA%\com.markdoc.desktop`). A release startup migrates an existing `%APPDATA%\com.markdoc.desktop\markdown.db` into the install directory once. The desktop database is never shared with Docker or the Python server. `src-tauri/icons/icon.ico` is generated from `frontend/public/favicon.svg`.
- `src-tauri/tauri.conf.json` packages only the frontend, references, and setup script for both NSIS and MSI. The NSIS post-install hook and WiX post-`InstallFiles` custom action run `src-tauri/resources/install-dependencies.ps1`: it reuses Pandoc and TeX tools found on `PATH` or in standard Windows install locations, or downloads Pandoc, portable MiKTeX, Graphviz, Node.js, Mermaid CLI, and Chromium into the install's `tools/` directory when missing. MiKTeX is a basic install and can download additional packages for TikZ on first use. WebView2 uses its download bootstrapper; setup needs internet when a required runtime is absent. The setup script log is `install-dependencies.log` beside the installed executable.
- Release-mode Rust tool lookup prefers app-local tools and then searches `PATH`. Mermaid can use an existing Chromium/Chrome/Edge browser. The NSIS install flow and clean-machine behavior have not yet been verified.

- The Docker image bakes in both `main.py` and `frontend/dist`: after any code change you must **rebuild the image**, not just restart the container.
- Dockerfile quirk: `EXPOSE 8000` but `CMD` serves on `--port 6789`. Port 6789 is the real one.
- Dockerfile installs all external binaries: pandoc, graphviz, mermaid-cli 12 (needs Node 22.13+), texlive (incl. `texlive-pictures` = TikZ/pgfplots), poppler-utils (`pdftoppm`), chromium for puppeteer. Local Windows dev relies on Pandoc, Graphviz, and MiKTeX (`xelatex`, `pdftoppm`) being on PATH.
- `.tmp/` under the repo root is backend scratch (uploads/output job dirs + `markdown.db`), safe to delete when running locally.

## Export pipeline (`main.py`) — order matters

`/api/export` → `convert_md_file()`:
1. `preprocess_markdown()` — newline normalize + indented-code neutralization (see invariant below).
2. `render_mermaid_blocks()` → `render_graphviz_blocks()` → `render_tikz_blocks()` — each turns a fenced block into a PNG **inside `job_dir`** and replaces the fence with `![...](name-N.png)`. The final Pandoc pass embeds images via `--resource-path={job_dir}`; generated PNGs must live in that directory, which is wiped after conversion.
3. `markdown_to_html_document()` — splits on raw HTML `<table>` blocks (`TABLE_BLOCK_RE`) and splices them *verbatim* into the HTML so Pandoc's **HTML** reader (not its Markdown reader) parses rowspan/colspan. Never reformat in ways that disturb those blocks (e.g., don't touch leading whitespace lines inside them).
4. Final Pandoc pass: HTML → DOCX. Math reaches Word as native OMML via `--mathml`.

DOCX style templates: any `*.docx` filename in `references/` becomes a style id shown in the UI (`--reference-doc`).

## Hard-won invariants — keep both sides in sync

- **Indented code blocks are disabled app-wide.** Pandoc has **no** `-indented_code_blocks` extension (verified: `pandoc --list-extensions=markdown`), so both `frontend/src/main.jsx:normalizeIndentedCode()` and `main.py:_neutralize_indented_code()` rewrite ≥4 leading spaces/tabs (tab stops of 4) into NBSPs — except lines starting with a list marker (`- `, `1. `, `> `) or `<` (raw HTML). Real code must use fenced ``` blocks. If you touch one implementation, mirror the change in the other (including fence and raw-table protection).
- **Preview pipeline order** (`main.jsx`): `normalizeIndentedCode` → `renderMath` → `renderGraphviz` → `renderMermaid` → `renderTikz` → `marked.parse`. Diagram fences must be converted before Markdown parsing; math skips fenced code.
- **Graphviz layout parity:** the browser uses `@viz-js/viz` default `dot` to produce SVG; both Python and Tauri DOCX export must invoke Graphviz's default `dot` engine and produce 300-DPI PNG. Do not force `-Kneato` or another engine in export: it changes node placement. Minor appearance differences remain because SVG preview is vector and DOCX embeds a raster PNG.
- **TikZ fences** (```` ```tikz ```` / `pgfplots` / `latex-diagram`) must be self-contained: `\input`/`\include` are rejected with a friendly error. Fence-level `\usepackage`/`\usetikzlibrary` lines are hoisted into the preamble by `TIKZ_DIRECTIVE_RE` (they're invalid in the body) and inserted **before** the auto-generated `standalone` preamble's `\begin{document}`. Per-fence compile: xelatex in an isolated dir, pdftoppm at 300 dpi. Live preview uses `POST /api/render-tikz` (login required; all API routes need a session cookie except `/api/health` and the auth routes), debounced in the frontend with a per-source cache (`tikzCacheRef`).
- **LaTeX subprocess lesson**: never pass a Windows path containing backslashes as a file argument to xelatex — TeX misparses them as control sequences. Run the compiler with `cwd=<workdir>` and the bare filename `diagram.tex`.

## Web server auth model

The Python web server's SQLite DB at `.tmp/markdown.db` (created on demand) supports idempotent email-based register/login, PBKDF2 password hashes, HttpOnly session cookies (`samesite=lax`), and multiple accounts. First registered account becomes admin. `MDTODOCX_COOKIE_SECURE=1` for TLS deployments.

The Tauri app has its own Rust-managed SQLite database under Tauri's per-user app-data directory and enforces a single local account. Do not share the desktop database with Docker or the Python server.

## Releases

- The current product release is `1.0.0`; the Git tag is `v1.0.0`. Release notes live in `CHANGELOG.md` and GitHub Releases carry the Windows NSIS `.exe` and WiX `.msi` installers.
- Keep the product version synchronized in `pyproject.toml`, `uv.lock`, `frontend/package.json`, `frontend/package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. `main.py` also reports the product version through FastAPI metadata.
- Before tagging: update `CHANGELOG.md`, build the frontend, run `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, and build both installers with `cargo tauri build --bundles nsis,msi` in the Visual Studio C++ build environment. Confirm the two bundle artifacts exist, then commit, create an annotated `vMAJOR.MINOR.PATCH` tag, push the branch and tag, and attach both installers to the matching GitHub Release.
