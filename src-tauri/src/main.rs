#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod export;

use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::net::TcpListener;
use tower_http::services::{ServeDir, ServeFile};

const SESSION_COOKIE: &str = "mdtodocx_session";
const SESSION_TTL_SECONDS: i64 = 60 * 60 * 24 * 14;
const PBKDF2_ROUNDS: u32 = 310_000;

#[tauri::command]
fn save_export_file(path: String, contents: Vec<u8>) -> Result<serde_json::Value, String> {
    if contents.is_empty() {
        return Err("The exported document is empty.".into());
    }
    let mut output_path = PathBuf::from(path);
    if output_path.extension().is_none() {
        output_path.set_extension("docx");
    }
    fs::write(&output_path, &contents).map_err(|error| {
        format!(
            "Could not save document to {}: {error}",
            output_path.display()
        )
    })?;
    let metadata = fs::metadata(&output_path)
        .map_err(|error| format!("Could not verify saved document: {error}"))?;
    if metadata.len() != contents.len() as u64 {
        return Err(format!(
            "Saved document size mismatch at {}: expected {} bytes, found {} bytes.",
            output_path.display(),
            contents.len(),
            metadata.len()
        ));
    }
    Ok(serde_json::json!({
        "path": output_path.to_string_lossy(),
        "bytesWritten": metadata.len()
    }))
}

#[derive(Clone)]
struct AppState {
    database: Arc<PathBuf>,
    references: Arc<PathBuf>,
    frontend: Arc<PathBuf>,
    tools: Arc<export::ToolPaths>,
    puppeteer_config: Arc<PathBuf>,
    origin: Arc<String>,
}

#[derive(Deserialize)]
struct EmailLookup {
    email: String,
}

#[derive(Deserialize)]
struct Credentials {
    email: String,
    password: String,
}

#[derive(Deserialize)]
struct NoteRequest {
    title: Option<String>,
    markdown: Option<String>,
}

#[derive(Deserialize)]
struct UserAction {
    blocked: bool,
}

#[derive(Deserialize)]
struct ExportRequest {
    markdown: String,
    #[serde(default = "default_filename")]
    filename: String,
    #[serde(default = "default_reference")]
    reference: String,
}

#[derive(Deserialize)]
struct TikzPreviewRequest {
    source: String,
}

fn default_filename() -> String {
    "document.md".to_owned()
}

fn default_reference() -> String {
    "Default".to_owned()
}

#[derive(Serialize)]
struct ApiError {
    detail: String,
}

#[derive(Serialize)]
struct User {
    id: i64,
    email: String,
    username: String,
    is_admin: bool,
}

#[derive(Serialize)]
struct Note {
    id: i64,
    user_id: i64,
    title: String,
    markdown: String,
    created_at: String,
    updated_at: String,
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn database(path: &FsPath) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA journal_mode = WAL;
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
             user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
             title TEXT NOT NULL,
             markdown TEXT NOT NULL DEFAULT '',
             created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
             updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
         );",
    )?;
    Ok(connection)
}

fn open_connection(path: &FsPath) -> rusqlite::Result<Connection> {
    let connection = Connection::open(path)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(connection)
}

fn json_error(status: StatusCode, detail: impl Into<String>) -> Response {
    (
        status,
        Json(ApiError {
            detail: detail.into(),
        }),
    )
        .into_response()
}

fn normalize_email(email: &str) -> Result<String, Response> {
    let email = email.trim().to_lowercase();
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or_default();
    let domain = parts.next().unwrap_or_default();
    let valid_local = !local.is_empty()
        && local.chars().all(|character| {
            character.is_ascii_alphanumeric() || ".!#$%&'*+/=?^_`{|}~-".contains(character)
        });
    let labels = domain.split('.').collect::<Vec<_>>();
    let valid_domain = labels.len() >= 2
        && labels.iter().all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                && label
                    .chars()
                    .last()
                    .is_some_and(|c| c.is_ascii_alphanumeric())
                && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        });
    if local.is_empty()
        || domain.is_empty()
        || parts.next().is_some()
        || !valid_local
        || !valid_domain
        || email.len() > 320
    {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "Enter a valid email address",
        ));
    }
    Ok(email)
}

fn password_hash(password: &str) -> String {
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut digest = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, PBKDF2_ROUNDS, &mut digest);
    format!(
        "pbkdf2_sha256${}${}${}",
        PBKDF2_ROUNDS,
        hex::encode(salt),
        hex::encode(digest)
    )
}

fn password_matches(password: &str, encoded: &str) -> bool {
    let mut fields = encoded.split('$');
    let (Some("pbkdf2_sha256"), Some(rounds), Some(salt), Some(expected), None) = (
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
        fields.next(),
    ) else {
        return false;
    };
    let (Ok(rounds), Ok(salt), Ok(expected)) = (
        rounds.parse::<u32>(),
        hex::decode(salt),
        hex::decode(expected),
    ) else {
        return false;
    };
    let mut actual = vec![0_u8; expected.len()];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, rounds, &mut actual);
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected.iter())
            .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
            == 0
}

fn session_hash(session: &str) -> String {
    hex::encode(Sha256::digest(session.as_bytes()))
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(name, value)| (name == SESSION_COOKIE).then(|| value.to_owned()))
}

fn create_session(connection: &Connection, user_id: i64) -> rusqlite::Result<String> {
    let mut bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = URL_SAFE_NO_PAD.encode(bytes);
    connection.execute(
        "INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
        params![
            session_hash(&token),
            user_id,
            now(),
            now() + SESSION_TTL_SECONDS
        ],
    )?;
    Ok(token)
}

fn set_session_cookie(response: &mut Response, token: &str) {
    let value = format!(
        "{SESSION_COOKIE}={token}; Max-Age={SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax"
    );
    if let Ok(value) = HeaderValue::from_str(&value) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
}

fn current_user(connection: &Connection, headers: &HeaderMap) -> Result<User, Response> {
    let Some(token) = session_cookie(headers) else {
        return Err(json_error(StatusCode::UNAUTHORIZED, "Please log in"));
    };
    let user = connection
        .query_row(
            "SELECT u.id, COALESCE(u.email, u.username), u.is_admin, u.is_blocked
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.id_hash = ?1 AND s.expires_at > ?2",
            params![session_hash(&token), now()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    match user {
        Some((_, _, _, true)) | None => Err(json_error(
            StatusCode::UNAUTHORIZED,
            "Session is invalid or the account is blocked",
        )),
        Some((id, email, is_admin, false)) => Ok(User {
            id,
            username: email.clone(),
            email,
            is_admin,
        }),
    }
}

fn open_database(state: &AppState) -> Result<Connection, Response> {
    open_connection(&state.database)
        .map_err(|error| json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn set_cookie_on_json(value: impl Serialize, token: &str) -> Response {
    let mut response = Json(value).into_response();
    set_session_cookie(&mut response, token);
    response
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn auth_me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    match current_user(&connection, &headers) {
        Ok(user) => Json(user).into_response(),
        Err(response) => response,
    }
}

async fn check_email(State(state): State<AppState>, Json(payload): Json<EmailLookup>) -> Response {
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(response) => return response,
    };
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let exists = match connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM users WHERE email = ?1 OR username = ?1)",
        [&email],
        |row| row.get::<_, bool>(0),
    ) {
        Ok(exists) => exists,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    Json(serde_json::json!({ "email": email, "exists": exists })).into_response()
}

async fn register(State(state): State<AppState>, Json(payload): Json<Credentials>) -> Response {
    if payload.password.len() < 8 || payload.password.len() > 200 {
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Password must be between 8 and 200 characters",
        );
    }
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(response) => return response,
    };
    let mut connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let existing = transaction
        .query_row(
            "SELECT id, password_hash, is_admin, is_blocked FROM users WHERE email = ?1 OR username = ?1",
            [&email],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional();
    let (id, is_admin) = match existing {
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        Ok(Some((_, _, _, true))) => {
            return json_error(StatusCode::FORBIDDEN, "This account has been blocked")
        }
        Ok(Some((_, hash, _, false))) if !password_matches(&payload.password, &hash) => {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "This email is already registered. Enter its password to log in.",
            )
        }
        Ok(Some((id, _, is_admin, false))) => (id, is_admin),
        Ok(None) => {
            let count = match transaction
                .query_row("SELECT COUNT(*) FROM users", [], |row| row.get::<_, i64>(0))
            {
                Ok(count) => count,
                Err(error) => {
                    return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                }
            };
            if count > 0 {
                return json_error(
                    StatusCode::CONFLICT,
                    "This desktop app supports one local account",
                );
            }
            let is_admin = count == 0;
            if let Err(error) = transaction.execute(
                "INSERT INTO users (username, email, password_hash, is_admin) VALUES (?1, ?1, ?2, ?3)",
                params![email, password_hash(&payload.password), is_admin],
            ) {
                return json_error(StatusCode::CONFLICT, error.to_string());
            }
            (transaction.last_insert_rowid(), is_admin)
        }
    };
    let token = match create_session(&transaction, id) {
        Ok(token) => token,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if let Err(error) = transaction.commit() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    set_cookie_on_json(
        User {
            id,
            email: email.clone(),
            username: email,
            is_admin,
        },
        &token,
    )
}

async fn login(State(state): State<AppState>, Json(payload): Json<Credentials>) -> Response {
    let email = match normalize_email(&payload.email) {
        Ok(email) => email,
        Err(response) => return response,
    };
    let mut connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = connection
        .query_row(
            "SELECT id, COALESCE(email, username), password_hash, is_admin, is_blocked
             FROM users WHERE email = ?1 OR username = ?1",
            [&email],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional();
    let (id, account_email, hash, is_admin, is_blocked) = match user {
        Ok(Some(user)) => user,
        Ok(None) => return json_error(StatusCode::UNAUTHORIZED, "Invalid email or password"),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if !password_matches(&payload.password, &hash) {
        return json_error(StatusCode::UNAUTHORIZED, "Invalid email or password");
    }
    if is_blocked {
        return json_error(StatusCode::FORBIDDEN, "This account has been blocked");
    }
    let transaction = match connection.transaction() {
        Ok(transaction) => transaction,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let token = match create_session(&transaction, id) {
        Ok(token) => token,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if let Err(error) = transaction.commit() {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    set_cookie_on_json(
        User {
            id,
            email: account_email.clone(),
            username: account_email,
            is_admin,
        },
        &token,
    )
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Some(token) = session_cookie(&headers) {
        if let Err(error) = connection.execute(
            "DELETE FROM sessions WHERE id_hash = ?1",
            [session_hash(&token)],
        ) {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    let mut response = Json(serde_json::json!({ "status": "logged_out" })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("mdtodocx_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax"),
    );
    response
}

async fn list_notes(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = match current_user(&connection, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let mut statement = match connection.prepare(
        "SELECT id, user_id, title, markdown, created_at, updated_at
         FROM notes WHERE user_id = ?1 ORDER BY updated_at DESC, id DESC",
    ) {
        Ok(statement) => statement,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let notes = match statement.query_map([user.id], |row| {
        Ok(Note {
            id: row.get(0)?,
            user_id: row.get(1)?,
            title: row.get(2)?,
            markdown: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    }) {
        Ok(rows) => rows,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let mut result = Vec::new();
    for note in notes {
        match note {
            Ok(note) => result.push(note),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    }
    Json(result).into_response()
}

async fn create_note(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<NoteRequest>,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = match current_user(&connection, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let title = payload.title.unwrap_or_default();
    let title = if title.trim().is_empty() {
        "Untitled note".to_owned()
    } else {
        title.trim().to_owned()
    };
    if title.chars().count() > 120
        || payload
            .markdown
            .as_ref()
            .is_some_and(|text| text.len() > 2_000_000)
    {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, "Note is too large");
    }
    let markdown = payload.markdown.unwrap_or_default();
    if let Err(error) = connection.execute(
        "INSERT INTO notes (user_id, title, markdown) VALUES (?1, ?2, ?3)",
        params![user.id, title, markdown],
    ) {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    note_by_id(&connection, connection.last_insert_rowid(), user.id)
}

async fn update_note(
    State(state): State<AppState>,
    Path(note_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<NoteRequest>,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = match current_user(&connection, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let title = payload.title.unwrap_or_default();
    let title = if title.trim().is_empty() {
        "Untitled note".to_owned()
    } else {
        title.trim().to_owned()
    };
    let markdown = payload.markdown.unwrap_or_default();
    if title.chars().count() > 120 || markdown.len() > 2_000_000 {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, "Note is too large");
    }
    match connection.execute(
        "UPDATE notes SET title = ?1, markdown = ?2, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?3 AND user_id = ?4",
        params![title, markdown, note_id, user.id],
    ) {
        Ok(0) => json_error(StatusCode::NOT_FOUND, "Note not found"),
        Ok(_) => note_by_id(&connection, note_id, user.id),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

fn note_by_id(connection: &Connection, note_id: i64, user_id: i64) -> Response {
    match connection.query_row(
        "SELECT id, user_id, title, markdown, created_at, updated_at FROM notes WHERE id = ?1 AND user_id = ?2",
        params![note_id, user_id],
        |row| {
            Ok(Note {
                id: row.get(0)?,
                user_id: row.get(1)?,
                title: row.get(2)?,
                markdown: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        },
    ) {
        Ok(note) => Json(note).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn delete_note(
    State(state): State<AppState>,
    Path(note_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = match current_user(&connection, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    match connection.execute(
        "DELETE FROM notes WHERE id = ?1 AND user_id = ?2",
        params![note_id, user.id],
    ) {
        Ok(0) => json_error(StatusCode::NOT_FOUND, "Note not found"),
        Ok(_) => Json(serde_json::json!({ "status": "deleted" })).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn reference_styles(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = current_user(&connection, &headers) {
        return response;
    }
    let mut styles = match fs::read_dir(state.references.as_ref()) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                (path.is_file()
                    && path.extension().is_some_and(|extension| {
                        extension.to_string_lossy().eq_ignore_ascii_case("docx")
                    }))
                .then(|| path.file_stem()?.to_str().map(str::to_owned))
                .flatten()
            })
            .collect::<Vec<_>>(),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    styles.sort();
    Json(serde_json::json!({
        "styles": styles.iter().map(|id| serde_json::json!({ "id": id, "name": id })).collect::<Vec<_>>()
    }))
    .into_response()
}

async fn admin_users(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let user = match current_user(&connection, &headers) {
        Ok(user) => user,
        Err(response) => return response,
    };
    if !user.is_admin {
        return json_error(StatusCode::FORBIDDEN, "Admin access required");
    }
    match connection.query_row(
        "SELECT id, username, email, is_admin, is_blocked, created_at FROM users WHERE id = ?1",
        [user.id],
        |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, i64>(0)?,
                "username": row.get::<_, String>(1)?,
                "email": row.get::<_, Option<String>>(2)?,
                "is_admin": row.get::<_, bool>(3)?,
                "is_blocked": row.get::<_, bool>(4)?,
                "created_at": row.get::<_, String>(5)?
            }))
        },
    ) {
        Ok(user) => Json(vec![user]).into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn set_user_blocked(
    State(state): State<AppState>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
    Json(payload): Json<UserAction>,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let admin = match current_user(&connection, &headers) {
        Ok(user) if user.is_admin => user,
        Ok(_) => return json_error(StatusCode::FORBIDDEN, "Admin access required"),
        Err(response) => return response,
    };
    if user_id == admin.id {
        return json_error(StatusCode::BAD_REQUEST, "You cannot block your own account");
    }
    let _ = payload.blocked;
    json_error(StatusCode::NOT_FOUND, "User not found")
}

async fn delete_user(
    State(state): State<AppState>,
    Path(user_id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    let admin = match current_user(&connection, &headers) {
        Ok(user) if user.is_admin => user,
        Ok(_) => return json_error(StatusCode::FORBIDDEN, "Admin access required"),
        Err(response) => return response,
    };
    if user_id == admin.id {
        return json_error(
            StatusCode::BAD_REQUEST,
            "You cannot delete your own account",
        );
    }
    json_error(StatusCode::NOT_FOUND, "User not found")
}

async fn export_document(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ExportRequest>,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = current_user(&connection, &headers) {
        return response;
    }
    if payload.markdown.is_empty() || payload.markdown.len() > 2_000_000 {
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Markdown must contain between 1 and 2000000 bytes",
        );
    }
    let style_ids = match fs::read_dir(state.references.as_ref()) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let path = entry.path();
                (path.is_file()
                    && path.extension().is_some_and(|extension| {
                        extension.to_string_lossy().eq_ignore_ascii_case("docx")
                    }))
                .then(|| path.file_stem()?.to_str().map(str::to_owned))
                .flatten()
            })
            .collect::<Vec<_>>(),
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    if !style_ids.iter().any(|style| style == &payload.reference) {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "Unknown reference style. Available: {}",
                style_ids.join(", ")
            ),
        );
    }
    let references = state.references.clone();
    let tools = state.tools.clone();
    let puppeteer_config = state.puppeteer_config.clone();
    let result = tokio::task::spawn_blocking(move || {
        export::convert(export::ExportOptions {
            markdown: &payload.markdown,
            filename: &payload.filename,
            reference: &payload.reference,
            references: &references,
            tools: &tools,
            puppeteer_config: &puppeteer_config,
        })
    })
    .await;
    match result {
        Ok(Ok((bytes, filename))) => {
            let mut response = Response::new(axum::body::Body::from(bytes));
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                ),
            );
            let safe_name = filename
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ' ') {
                        character
                    } else {
                        '_'
                    }
                })
                .collect::<String>();
            if let Ok(value) =
                HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}.docx\""))
            {
                response
                    .headers_mut()
                    .insert(header::CONTENT_DISPOSITION, value);
            }
            response
        }
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, error),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Document export failed: {error}"),
        ),
    }
}

async fn render_tikz_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TikzPreviewRequest>,
) -> Response {
    let connection = match open_database(&state) {
        Ok(connection) => connection,
        Err(response) => return response,
    };
    if let Err(response) = current_user(&connection, &headers) {
        return response;
    }
    if payload.source.is_empty() || payload.source.len() > 20_000 {
        return json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "TikZ source must contain between 1 and 20000 bytes",
        );
    }
    let tools = state.tools.clone();
    let result = tokio::task::spawn_blocking(move || {
        let job = tempfile::Builder::new()
            .prefix("mdtodocx-tikz-")
            .tempdir()
            .map_err(|error| error.to_string())?;
        export::render_tikz_preview(&payload.source, &tools, job.path())
    })
    .await;
    match result {
        Ok(Ok(image)) => Json(serde_json::json!({
            "image": format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(image))
        }))
        .into_response(),
        Ok(Err(error)) => json_error(StatusCode::BAD_REQUEST, error),
        Err(error) => json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("TikZ rendering failed: {error}"),
        ),
    }
}

async fn guard_local_origin(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let expected_host = state.origin.trim_start_matches("http://");
    if host != Some(expected_host) || origin.is_some_and(|value| value != state.origin.as_str()) {
        return json_error(StatusCode::FORBIDDEN, "Invalid desktop app origin");
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response.headers_mut().insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("same-origin"),
    );
    response
}

fn api_router(state: AppState) -> Router {
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/me", get(auth_me))
        .route("/api/auth/check-email", post(check_email))
        .route("/api/auth/register", post(register))
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/admin/users", get(admin_users))
        .route(
            "/api/admin/users/{user_id}",
            patch(set_user_blocked).delete(delete_user),
        )
        .route("/api/notes", get(list_notes).post(create_note))
        .route("/api/notes/{note_id}", put(update_note).delete(delete_note))
        .route("/api/reference-styles", get(reference_styles))
        .route("/api/render-tikz", post(render_tikz_preview))
        .route("/api/export", post(export_document))
        .with_state(state.clone());
    let static_files = ServeDir::new(state.frontend.as_ref())
        .not_found_service(ServeFile::new(state.frontend.join("index.html")));
    Router::new()
        .merge(api)
        .fallback_service(static_files)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            guard_local_origin,
        ))
        .with_state(state)
}

fn app_paths(
    app: &tauri::AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), Box<dyn std::error::Error>> {
    // Release installs keep all data in the installation directory so the app is
    // portable: installing to `D:\Markdoc` means the database, export scratch and
    // MiKTeX user config all live under `D:\Markdoc`. If the install directory is
    // not writable (e.g. Program Files), fall back to per-user app data. In dev
    // builds the executable lives under `target/debug`, so keep the per-user dir.
    #[cfg(debug_assertions)]
    let data_dir = app.path().app_data_dir()?;
    #[cfg(not(debug_assertions))]
    let data_dir = {
        let install_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(|parent| parent.to_path_buf()));
        let writable = install_dir.as_ref().filter(|dir| {
            let probe = dir.join(".mdtodocx-write-probe");
            fs::write(&probe, b"ok").is_ok_and(|()| fs::remove_file(&probe).is_ok())
        });
        match writable {
            Some(dir) => {
                // One-time migration: preserve notes created while this (or an
                // earlier) build still stored the database under app data.
                let legacy = app
                    .path()
                    .app_data_dir()
                    .ok()
                    .map(|dir| dir.join("markdown.db"));
                let target = dir.join("markdown.db");
                if let Some(legacy) = legacy {
                    if legacy.is_file() && !target.exists() {
                        let _ = fs::copy(&legacy, &target);
                    }
                }
                dir.clone()
            }
            None => app.path().app_data_dir()?,
        }
    };
    fs::create_dir_all(&data_dir)?;

    #[cfg(debug_assertions)]
    let (frontend, references) = {
        let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        (
            project_root.join("frontend").join("dist"),
            project_root.join("references"),
        )
    };

    #[cfg(not(debug_assertions))]
    let (frontend, references) = {
        let resource_dir = app.path().resource_dir()?;
        (
            resource_dir.join("frontend-dist"),
            resource_dir.join("references"),
        )
    };

    if !frontend.join("index.html").is_file() {
        return Err(format!("Frontend build is missing: {}", frontend.display()).into());
    }
    if !references.is_dir() {
        return Err(format!("Reference templates are missing: {}", references.display()).into());
    }
    let puppeteer_config = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("puppeteer-config.json")
    } else {
        app.path().resource_dir()?.join("puppeteer-config.json")
    };
    Ok((
        data_dir.join("markdown.db"),
        references,
        frontend,
        puppeteer_config,
    ))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![save_export_file])
        .setup(|app| {
            let (database_path, references, frontend, puppeteer_config) = app_paths(app.handle())?;
            if let Some(parent) = database_path.parent() {
                fs::create_dir_all(parent)?;
            }
            database(&database_path)?;

            let listener = tauri::async_runtime::block_on(async {
                TcpListener::bind(("127.0.0.1", 0)).await
            })?;
            let address = listener.local_addr()?;
            let origin = format!("http://{address}");
            let data_dir = database_path
                .parent()
                .expect("database path has an app data parent")
                .to_path_buf();
            let state = AppState {
                database: Arc::new(database_path),
                references: Arc::new(references),
                frontend: Arc::new(frontend),
                tools: Arc::new(export::ToolPaths {
                    resource_dir: app.path().resource_dir()?,
                    data_dir,
                    development: cfg!(debug_assertions),
                }),
                puppeteer_config: Arc::new(puppeteer_config),
                origin: Arc::new(origin.clone()),
            };
            let router = api_router(state);
            println!("MarkDoc API listening on {origin}");
            tauri::async_runtime::spawn(async move {
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("Desktop API server failed: {error}");
                }
            });

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(origin.parse()?))
                .title("MarkDoc — Markdown to Word")
                .inner_size(1440.0, 960.0)
                .min_inner_size(800.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MarkDoc");
}

#[cfg(test)]
mod tests {
    use super::{api_router, database, password_hash, password_matches, AppState};
    use crate::export;
    use axum::{
        body::Body,
        http::{header, Method, Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::{fs, path::PathBuf, sync::Arc};
    use tempfile::tempdir;
    use tower::ServiceExt;

    fn request(method: Method, uri: &str, body: &str, cookie: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:8123")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            builder = builder.header(header::COOKIE, cookie);
        }
        builder.body(Body::from(body.to_owned())).unwrap()
    }

    async fn json(response: axum::response::Response) -> serde_json::Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn password_hash_round_trips() {
        let hash = password_hash("correct horse battery staple");
        assert!(password_matches("correct horse battery staple", &hash));
        assert!(!password_matches("wrong password", &hash));
    }

    #[tokio::test]
    async fn local_api_preserves_auth_and_notes_contract_for_one_user() {
        let temp = tempdir().unwrap();
        let database_path = temp.path().join("markdown.db");
        database(&database_path).unwrap();
        let references = temp.path().join("references");
        fs::create_dir_all(&references).unwrap();
        fs::write(references.join("Default.docx"), b"template").unwrap();
        let frontend = temp.path().join("frontend");
        fs::create_dir_all(&frontend).unwrap();
        fs::write(frontend.join("index.html"), "<h1>MarkDoc</h1>").unwrap();
        let origin = "http://127.0.0.1:8123".to_owned();
        let app = api_router(AppState {
            database: Arc::new(database_path),
            references: Arc::new(references),
            frontend: Arc::new(frontend),
            tools: Arc::new(export::ToolPaths {
                resource_dir: PathBuf::from(""),
                data_dir: temp.path().to_path_buf(),
                development: false,
            }),
            puppeteer_config: Arc::new(PathBuf::from("puppeteer-config.json")),
            origin: Arc::new(origin),
        });

        let check = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/auth/check-email",
                r#"{"email":"writer@example.com"}"#,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(check.status(), StatusCode::OK);
        assert_eq!(json(check).await["exists"], false);

        let register = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/auth/register",
                r#"{"email":"writer@example.com","password":"long password"}"#,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(register.status(), StatusCode::OK);
        let cookie = register
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        let user = json(register).await;
        assert_eq!(user["email"], "writer@example.com");
        assert_eq!(user["is_admin"], true);

        let me = app
            .clone()
            .oneshot(request(Method::GET, "/api/auth/me", "", Some(&cookie)))
            .await
            .unwrap();
        assert_eq!(me.status(), StatusCode::OK);

        let note = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/notes",
                r#"{"title":"Draft","markdown":"Hello"}"#,
                Some(&cookie),
            ))
            .await
            .unwrap();
        assert_eq!(note.status(), StatusCode::OK);
        let note = json(note).await;
        assert_eq!(note["title"], "Draft");
        assert_eq!(note["markdown"], "Hello");

        let notes = app
            .clone()
            .oneshot(request(Method::GET, "/api/notes", "", Some(&cookie)))
            .await
            .unwrap();
        assert_eq!(json(notes).await.as_array().unwrap().len(), 1);

        let second_user = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/auth/register",
                r#"{"email":"another@example.com","password":"long password"}"#,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(second_user.status(), StatusCode::CONFLICT);

        let references = app
            .clone()
            .oneshot(request(
                Method::GET,
                "/api/reference-styles",
                "",
                Some(&cookie),
            ))
            .await
            .unwrap();
        assert_eq!(json(references).await["styles"][0]["id"], "Default");

        let hostile_origin = Request::builder()
            .method(Method::GET)
            .uri("/api/health")
            .header(header::HOST, "127.0.0.1:8123")
            .header(header::ORIGIN, "https://example.com")
            .body(Body::empty())
            .unwrap();
        let blocked = app.oneshot(hostile_origin).await.unwrap();
        assert_eq!(blocked.status(), StatusCode::FORBIDDEN);
    }
}
