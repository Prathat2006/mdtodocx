from __future__ import annotations

import re
import hashlib
import hmac
import os
import secrets
import sqlite3
import shutil
import subprocess
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

import pypandoc
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from starlette.background import BackgroundTask


BASE_DIR = Path(__file__).resolve().parent
UPLOAD_FOLDER = BASE_DIR / ".tmp" / "uploads"
OUTPUT_FOLDER = BASE_DIR / ".tmp" / "outputs"
REFERENCE_DOC = BASE_DIR / "reference.docx"
FRONTEND_DIST = BASE_DIR / "frontend" / "dist"

UPLOAD_FOLDER.mkdir(parents=True, exist_ok=True)
OUTPUT_FOLDER.mkdir(parents=True, exist_ok=True)
DATABASE_PATH = BASE_DIR / ".tmp" / "markdown.db"
SESSION_COOKIE = "mdtodocx_session"
SESSION_TTL = 60 * 60 * 24 * 14
COOKIE_SECURE = os.getenv("MDTODOCX_COOKIE_SECURE", "0") == "1"
app = FastAPI(title="Markdown to DOCX", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

# Markdown reader extensions used for the NON-table chunks of the document
# (raw HTML tables are handled separately -- see convert_md_file).
MARKDOWN_READER_FORMAT = (
    "markdown+pipe_tables+grid_tables+multiline_tables"
    "+tex_math_dollars+tex_math_single_backslash+strikeout"
)

TABLE_BLOCK_RE = re.compile(r"<table\b[\s\S]*?</table>", re.IGNORECASE)


class ExportRequest(BaseModel):
    markdown: str = Field(..., min_length=1, max_length=2_000_000)
    filename: str = Field(default="document.md", max_length=100)


class NoteRequest(BaseModel):
    title: str = Field(default="Untitled note", max_length=120)
    markdown: str = Field(default="", max_length=2_000_000)


class LoginCredentials(BaseModel):
    email: str = Field(..., min_length=5, max_length=320)
    password: str = Field(..., min_length=10, max_length=200)


class RegisterCredentials(BaseModel):
    email: str = Field(..., min_length=5, max_length=320)
    password: str = Field(..., min_length=10, max_length=200)


class EmailLookup(BaseModel):
    email: str = Field(..., min_length=5, max_length=320)


class UserAction(BaseModel):
    blocked: bool


@contextmanager
def get_db():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    with get_db() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                email TEXT COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                is_admin INTEGER NOT NULL DEFAULT 0,
                is_blocked INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id_hash TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                markdown TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        """)
        columns = {row[1] for row in connection.execute("PRAGMA table_info(notes)")}
        if "user_id" not in columns:
            connection.execute("ALTER TABLE notes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE")
        user_columns = {row[1] for row in connection.execute("PRAGMA table_info(users)")}
        if "email" not in user_columns:
            connection.execute("ALTER TABLE users ADD COLUMN email TEXT COLLATE NOCASE")
            connection.execute("UPDATE users SET email = username WHERE email IS NULL")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")


init_db()


def _password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"pbkdf2_sha256$310000${salt.hex()}${digest.hex()}"


def _password_matches(password: str, encoded: str) -> bool:
    try:
        algorithm, rounds, salt, expected = encoded.split("$", 3)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(rounds)).hex()
        return algorithm == "pbkdf2_sha256" and hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _normalize_email(email: str) -> str:
    value = email.strip().lower()
    if not re.match(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$", value):
        raise HTTPException(status_code=400, detail="Enter a valid email address")
    return value


def _session_hash(session_id: str) -> str:
    return hashlib.sha256(session_id.encode()).hexdigest()


def _create_session(response: Response, user_id: int) -> None:
    session_id = secrets.token_urlsafe(32)
    now = int(time.time())
    with get_db() as connection:
        connection.execute("INSERT INTO sessions VALUES (?, ?, ?, ?)", (_session_hash(session_id), user_id, now, now + SESSION_TTL))
    response.set_cookie(SESSION_COOKIE, session_id, max_age=SESSION_TTL, httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/")


def current_user(session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
    if not session_cookie:
        raise HTTPException(status_code=401, detail="Please log in")
    with get_db() as connection:
        row = connection.execute("""
            SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id_hash = ? AND s.expires_at > ?
        """, (_session_hash(session_cookie), int(time.time()))).fetchone()
    if not row or row["is_blocked"]:
        raise HTTPException(status_code=401, detail="Session is invalid or the account is blocked")
    return row


def admin_user(user=Depends(current_user)):
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user


def preprocess_markdown(markdown: str) -> str:
    """
    Preprocess markdown before Pandoc conversion.

    - Normalizes line endings.
    - Tidies whitespace inside raw HTML <table> blocks (does not alter content).
    """

    markdown = markdown.replace("\r\n", "\n").replace("\r", "\n")

    def clean_table(match: re.Match) -> str:
        table = match.group(0)
        lines = [line.rstrip() for line in table.splitlines()]
        return "\n".join(lines)

    markdown = TABLE_BLOCK_RE.sub(clean_table, markdown)

    return markdown


def markdown_chunk_to_html(chunk: str) -> str:
    """Render a non-table markdown chunk to an HTML fragment via Pandoc."""
    if not chunk.strip():
        return ""
    return pypandoc.convert_text(
        chunk,
        "html",
        format=MARKDOWN_READER_FORMAT,
        extra_args=["--mathml", "--wrap=none"],
    )


def markdown_to_html_document(markdown: str) -> str:
    """
    Convert a Markdown document to a single HTML document, preserving raw
    <table> blocks verbatim so Pandoc's HTML reader (not its Markdown
    reader) parses them into real table structures later on.

    Pandoc's Markdown reader treats embedded raw <table>...</table> blocks
    as opaque raw-HTML nodes -- fine for HTML/PDF output, but the DOCX
    writer can only emit real Word tables (w:tbl) from tables it parsed
    into its own Table AST node. Pandoc's HTML reader *does* parse raw
    HTML tables correctly. So: split the doc on table blocks, render the
    surrounding Markdown to HTML normally, splice the raw table HTML back
    in untouched, and convert the whole assembled HTML document to DOCX
    in one pass with `-f html`.
    """
    parts: list[str] = []
    last = 0
    for match in TABLE_BLOCK_RE.finditer(markdown):
        before = markdown[last:match.start()]
        parts.append(markdown_chunk_to_html(before))
        parts.append(match.group(0))
        last = match.end()
    parts.append(markdown_chunk_to_html(markdown[last:]))

    return "\n".join(p for p in parts if p)


def convert_md_file(file_bytes: bytes, filename: str) -> str:
    """
    Save Markdown to a temporary file and convert it to DOCX with Pandoc.

    Supports:
    - Markdown
    - HTML tables (converted to real Word tables, incl. rowspan/colspan)
    - Mermaid diagrams
    - Graphviz diagrams (dot/graphviz fenced blocks)
    - Images
    - Math
    """

    if not filename.lower().endswith(".md"):
        raise ValueError("Only Markdown (.md) files are supported.")

    file_id = str(uuid.uuid4())

    job_dir = UPLOAD_FOLDER / file_id
    job_dir.mkdir(parents=True, exist_ok=True)

    html_path = job_dir / f"{file_id}.html"
    output_path = OUTPUT_FOLDER / f"{file_id}.docx"

    markdown = file_bytes.decode("utf-8")

    # Tidy HTML tables (whitespace only)
    markdown = preprocess_markdown(markdown)

    # Mermaid -> PNG, replaced with standard Markdown image refs
    markdown = render_mermaid_blocks(markdown, job_dir)

    # Graphviz -> PNG, replaced with standard Markdown image refs
    markdown = render_graphviz_blocks(markdown, job_dir)

    # Build one HTML document: Markdown chunks rendered to HTML,
    # raw <table> blocks preserved verbatim for the HTML reader to parse.
    try:
        html_document = markdown_to_html_document(markdown)
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        raise

    html_path.write_text(html_document, encoding="utf-8")

    extra_args = [
        "--standalone",
        "--mathml",
        "--wrap=none",
        f"--resource-path={job_dir}",
        "--highlight-style=tango",
    ]

    if REFERENCE_DOC.exists():
        extra_args.extend(["--reference-doc", str(REFERENCE_DOC)])

    try:
        pypandoc.convert_file(
            str(html_path),
            "docx",
            format="html",
            outputfile=str(output_path),
            extra_args=extra_args,
        )
    except Exception:
        shutil.rmtree(job_dir, ignore_errors=True)
        output_path.unlink(missing_ok=True)
        raise

    shutil.rmtree(job_dir, ignore_errors=True)

    return str(output_path)


def render_mermaid_blocks(markdown: str, job_dir: Path) -> str:
    """Render Mermaid fenced blocks to PNG files and replace them with images."""
    pattern = r"```mermaid\s*\n([\s\S]*?)\n```"
    matches = list(re.finditer(pattern, markdown, flags=re.IGNORECASE))
    if not matches:
        return markdown

    mermaid_cli = shutil.which("mmdc") or shutil.which("mmdc.cmd")
    if not mermaid_cli:
        raise RuntimeError(
            "Mermaid diagrams require Mermaid CLI. Install it with: "
            "npm install --global @mermaid-js/mermaid-cli"
        )

    rendered = markdown
    for index, match in reversed(list(enumerate(matches, start=1))):
        source_path = job_dir / f"diagram-{index}.mmd"
        image_path = job_dir / f"diagram-{index}.png"
        source_path.write_text(match.group(1).strip() + "\n", encoding="utf-8")
        try:
            subprocess.run(
                [mermaid_cli, "-i", str(source_path), "-o", str(image_path), "--backgroundColor", "transparent"],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            renderer_error = (exc.stderr or exc.stdout or "Mermaid CLI returned an unknown error.").strip()
            raise RuntimeError(f"Mermaid diagram {index} could not be rendered: {renderer_error}") from exc
        if not image_path.exists() or image_path.stat().st_size == 0:
            raise RuntimeError(f"Mermaid diagram {index} did not produce a PNG file.")
        image_reference = f"![Mermaid diagram](diagram-{index}.png)"
        rendered = rendered[: match.start()] + image_reference + rendered[match.end() :]
    return rendered


def render_graphviz_blocks(markdown: str, job_dir: Path) -> str:
    """Render Graphviz DOT fenced blocks to PNG files and replace them with images."""
    pattern = r"```(?:dot|graphviz)\s*\n([\s\S]*?)\n```"
    matches = list(re.finditer(pattern, markdown, flags=re.IGNORECASE))
    if not matches:
        return markdown

    graphviz_cli = shutil.which("dot") or shutil.which("dot.exe")
    if not graphviz_cli:
        raise RuntimeError(
            "Graphviz diagrams require the Graphviz 'dot' command. "
            "Install Graphviz and make sure dot is available on PATH."
        )

    rendered = markdown
    for index, match in reversed(list(enumerate(matches, start=1))):
        source_path = job_dir / f"graphviz-{index}.dot"
        image_path = job_dir / f"graphviz-{index}.png"
        source_path.write_text(match.group(1).strip() + "\n", encoding="utf-8")
        try:
            subprocess.run(
                [graphviz_cli, "-Tpng", str(source_path), "-o", str(image_path)],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as exc:
            renderer_error = (exc.stderr or exc.stdout or "Graphviz returned an unknown error.").strip()
            raise RuntimeError(f"Graphviz diagram {index} could not be rendered: {renderer_error}") from exc
        if not image_path.exists() or image_path.stat().st_size == 0:
            raise RuntimeError(f"Graphviz diagram {index} did not produce a PNG file.")
        image_reference = f"![Graphviz diagram](graphviz-{index}.png)"
        rendered = rendered[: match.start()] + image_reference + rendered[match.end() :]
    return rendered


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/auth/me")
def auth_me(user=Depends(current_user)):
    email = user["email"] or user["username"]
    return {"id": user["id"], "email": email, "username": email, "is_admin": bool(user["is_admin"])}


@app.post("/api/auth/check-email")
def check_email(payload: EmailLookup):
    email = _normalize_email(payload.email)
    with get_db() as connection:
        exists = connection.execute("SELECT 1 FROM users WHERE email = ? OR username = ?", (email, email)).fetchone() is not None
    return {"email": email, "exists": exists}


@app.post("/api/auth/register")
def register(payload: RegisterCredentials, response: Response):
    email = _normalize_email(payload.email)
    with get_db() as connection:
        existing = connection.execute("SELECT * FROM users WHERE email = ? OR username = ?", (email, email)).fetchone()
        if existing:
            if existing["is_blocked"]:
                raise HTTPException(status_code=403, detail="This account has been blocked")
            if not _password_matches(payload.password, existing["password_hash"]):
                raise HTTPException(status_code=401, detail="This email is already registered. Enter its password to log in.")
            _create_session(response, existing["id"])
            return {"id": existing["id"], "email": email, "username": email, "is_admin": bool(existing["is_admin"])}
        is_first = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
        try:
            cursor = connection.execute(
                "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?, ?, ?, ?)",
                (email, email, _password_hash(payload.password), int(is_first)),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="This email is already registered") from exc
        user_id = cursor.lastrowid
    _create_session(response, user_id)
    return {"id": user_id, "email": email, "username": email, "is_admin": is_first}


@app.post("/api/auth/login")
def login(payload: LoginCredentials, response: Response):
    email = _normalize_email(payload.email)
    with get_db() as connection:
        user = connection.execute("SELECT * FROM users WHERE email = ? OR username = ?", (email, email)).fetchone()
    if not user or not _password_matches(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user["is_blocked"]:
        raise HTTPException(status_code=403, detail="This account has been blocked")
    _create_session(response, user["id"])
    account_email = user["email"] or user["username"]
    return {"id": user["id"], "email": account_email, "username": account_email, "is_admin": bool(user["is_admin"])}


@app.post("/api/auth/logout")
def logout(response: Response, session_cookie: str | None = Cookie(default=None, alias=SESSION_COOKIE)):
    if session_cookie:
        with get_db() as connection:
            connection.execute("DELETE FROM sessions WHERE id_hash = ?", (_session_hash(session_cookie),))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"status": "logged_out"}


@app.get("/api/admin/users")
def admin_users(_admin=Depends(admin_user)):
    with get_db() as connection:
        return [dict(row) for row in connection.execute("SELECT id, username, email, is_admin, is_blocked, created_at FROM users ORDER BY id").fetchall()]


@app.patch("/api/admin/users/{user_id}")
def set_user_blocked(user_id: int, payload: UserAction, admin=Depends(admin_user)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot block your own account")
    with get_db() as connection:
        result = connection.execute("UPDATE users SET is_blocked = ? WHERE id = ?", (int(payload.blocked), user_id))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")
        if payload.blocked:
            connection.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    return {"status": "updated"}


@app.delete("/api/admin/users/{user_id}")
def delete_user(user_id: int, admin=Depends(admin_user)):
    if user_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    with get_db() as connection:
        result = connection.execute("DELETE FROM users WHERE id = ?", (user_id,))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="User not found")
    return {"status": "deleted"}


@app.get("/api/notes")
def list_notes(user=Depends(current_user)):
    with get_db() as connection:
        return [dict(row) for row in connection.execute(
            "SELECT * FROM notes WHERE user_id = ? ORDER BY updated_at DESC, id DESC", (user["id"],)
        ).fetchall()]


@app.post("/api/notes")
def create_note(payload: NoteRequest, user=Depends(current_user)):
    with get_db() as connection:
        cursor = connection.execute(
            "INSERT INTO notes (user_id, title, markdown) VALUES (?, ?, ?)",
            (user["id"], payload.title.strip() or "Untitled note", payload.markdown),
        )
        note_id = cursor.lastrowid
        row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return dict(row)


@app.put("/api/notes/{note_id}")
def update_note(note_id: int, payload: NoteRequest, user=Depends(current_user)):
    title = payload.title.strip() or "Untitled note"
    with get_db() as connection:
        if not connection.execute("SELECT 1 FROM notes WHERE id = ? AND user_id = ?", (note_id, user["id"])).fetchone():
            raise HTTPException(status_code=404, detail="Note not found")
        connection.execute(
            "UPDATE notes SET title = ?, markdown = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
            (title, payload.markdown, note_id, user["id"]),
        )
        row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return dict(row)


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: int, user=Depends(current_user)):
    with get_db() as connection:
        result = connection.execute("DELETE FROM notes WHERE id = ? AND user_id = ?", (note_id, user["id"]))
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Note not found")
    return {"status": "deleted"}


@app.post("/api/export")
def export_document(payload: ExportRequest, _user=Depends(current_user)):
    filename = Path(payload.filename).name
    if not filename.lower().endswith(".md"):
        filename += ".md"
    try:
        output_path = convert_md_file(payload.markdown.encode("utf-8"), filename)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Could not write the temporary document.") from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        detail = "Pandoc could not convert this Markdown. Make sure Pandoc is installed and available on PATH."
        raise HTTPException(status_code=500, detail=detail) from exc

    download_name = Path(filename).stem or "document"
    return FileResponse(
        output_path,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename=f"{download_name}.docx",
        background=BackgroundTask(_cleanup_files, output_path),
    )


def _cleanup_files(output_path: str) -> None:
    Path(output_path).unlink(missing_ok=True)


if FRONTEND_DIST.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
