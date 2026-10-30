# AGENTS.md

## What this is

Markdown editor (React) + FastAPI backend that exports Markdown to DOCX via Pandoc. The entire backend is `main.py`; the entire SPA is `frontend/src/main.jsx` (plus `frontend/src/eqShortcuts.js` for the equation shortcut DSL). No tests, lint, or CI exist — verification means running the app and exercising the feature.

## Commands

```powershell
uv run uvicorn main:app --reload          # backend on 127.0.0.1:8000 (= run.bat / run.sh)
cd frontend; npm run dev                  # frontend on 5173, proxies /api to 127.0.0.1:8000
cd frontend; npm run build                # bundles frontend/dist; FastAPI serves it when present, so backend alone then serves the whole app on 8000
docker build -t mdtodocx . ; docker run -d -p 6789:6789 --name mdtodocx mdtodocx   # full app on port 6789
```

- The Docker image bakes in both `main.py` and `frontend/dist`: after any code change you must **rebuild the image**, not just restart the container.
- Dockerfile quirk: `EXPOSE 8000` but `CMD` serves on `--port 6789`. Port 6789 is the real one.
- Dockerfile installs all external binaries: pandoc, graphviz, mermaid-cli 12 (needs Node 22.12+), texlive (incl. `texlive-pictures` = TikZ/pgfplots), poppler-utils (`pdftoppm`), chromium for puppeteer. Local Windows dev relies on Pandoc, Graphviz, and MiKTeX (`xelatex`, `pdftoppm`) being on PATH.
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
- **Preview pipeline order** (`main.jsx`): `normalizeIndentedCode` → `renderGraphviz` → `renderMermaid` → `renderTikz` → `renderMath` → `marked.parse`. Diagram fences must be converted before math runs.
- **TikZ fences** (```` ```tikz ```` / `pgfplots` / `latex-diagram`) must be self-contained: `\input`/`\include` are rejected with a friendly error. Fence-level `\usepackage`/`\usetikzlibrary` lines are hoisted into the preamble by `TIKZ_DIRECTIVE_RE` (they're invalid in the body) and inserted **before** the auto-generated `standalone` preamble's `\begin{document}`. Per-fence compile: xelatex in an isolated dir, pdftoppm at 300 dpi. Live preview uses `POST /api/render-tikz` (login required; all API routes need a session cookie except `/api/health` and the auth routes), debounced in the frontend with a per-source cache (`tikzCacheRef`).
- **LaTeX subprocess lesson**: never pass a Windows path containing backslashes as a file argument to xelatex — TeX misparses them as control sequences. Run the compiler with `cwd=<workdir>` and the bare filename `diagram.tex`.

## Auth model

SQLite DB at `.tmp/markdown.db` (created on demand): idempotent email-based register/login, PBKDF2 password hashes, HttpOnly session cookies (`samesite=lax`). First registered account becomes admin. `MDTODOCX_COOKIE_SECURE=1` for TLS deployments.
