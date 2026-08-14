# Mark→Word

A small Markdown editor that converts your writing to an editable `.docx` file with FastAPI, React, and Pandoc. It supports inline/display LaTeX (`$x^2$`, `\\(x^2\\)`, `$$x^2$$`, `\\[x^2\\]`), pipe tables, raw HTML tables, Mermaid diagrams, and Graphviz diagrams.

## Requirements

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Node.js 18+
- [Pandoc](https://pandoc.org/installing.html) installed and available on your PATH
- Mermaid CLI installed and available on your PATH: `npm install --global @mermaid-js/mermaid-cli`
- Graphviz installed with the `dot` command available on your PATH

## Run in development

In one terminal:

```powershell
uv sync
uv run uvicorn main:app --reload
```

In another terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The Vite server proxies `/api` requests to FastAPI.

## Run as one production app

```powershell
cd frontend
npm install
npm run build
cd ..
uv run uvicorn main:app
```

Open http://127.0.0.1:8000. The FastAPI app serves `frontend/dist` when it exists.

The supplied `reference.docx` is used automatically when it is present. Temporary Markdown and DOCX files are created under `.tmp` and the generated DOCX is removed after download.

Use a fenced Mermaid block in the editor:

````markdown
```mermaid
flowchart LR
  A[Markdown] --> B[Mermaid PNG] --> C[DOCX]
```
````

The browser shows the live SVG diagram, while the DOCX contains the generated PNG image.

Use a fenced `dot` or `graphviz` block for Graphviz diagrams:

````markdown
```dot
digraph G {
  Markdown -> Preview -> DOCX
}
```
````

The browser renders Graphviz as an SVG image, while the DOCX contains a generated PNG image.

## Accounts and security

The app requires an account. Enter an email address first; the app checks whether it is already registered in the local database. Existing users are asked for their password, while new users can create an account. Registration is idempotent: an existing email is never duplicated, and submitting its correct password signs the user in.

Registering the first account makes it the administrator; later accounts are regular users. Each user has a separate notes list. The administrator can open the Admin panel to list, block/unblock, or delete other users and their notes.

Sessions use random HttpOnly cookies and server-side expiry records. Passwords are stored using PBKDF2-SHA256 hashes. For HTTPS deployments set `MDTODOCX_COOKIE_SECURE=1` and terminate TLS at your reverse proxy.
