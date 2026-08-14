import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import markdownLang from 'highlight.js/lib/languages/markdown'
import mermaid from 'mermaid'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import './styles.css'

// Register Markdown language with highlight.js if not already present
if (!hljs.getLanguage('markdown')) {
  hljs.registerLanguage('markdown', markdownLang)
}

const starter = `# Project brief

Write or paste your **Markdown** here, then export it as a polished Word document.

## Highlights

- Clean Markdown editing
- Live preview
- Editable math equations with Pandoc

\`\`\`javascript
function greet(name) {
  console.log("Hello, " + name + "!");
}
\`\`\`

> Your content is converted securely on the server.`

function renderMath(source) {
  const codeBlocks = []
  const protectedSource = source.replace(/```[\s\S]*?```|`[^`]*`/g, (code) => { codeBlocks.push(code); return `\u0000CODE${codeBlocks.length - 1}\u0000` })
  const withMath = protectedSource
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, value) => katex.renderToString(value.trim(), { displayMode: true, throwOnError: false }))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, value) => katex.renderToString(value.trim(), { displayMode: true, throwOnError: false }))
    .replace(/\\\((.+?)\\\)/g, (_, value) => katex.renderToString(value.trim(), { throwOnError: false }))
    .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_, value) => katex.renderToString(value.trim(), { throwOnError: false }))
  return withMath.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => codeBlocks[Number(index)])
}

function escapeHtml(value) { 
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]) 
}

function renderMermaid(source) { 
  return source.replace(/```mermaid\s*\n([\s\S]*?)\n```/gi, (_, diagram) => `<div class="mermaid">${escapeHtml(diagram.trim())}</div>`) 
}

const markdownRenderer = new marked.Renderer()
markdownRenderer.code = ({ text, lang }) => {
  const language = lang && hljs.getLanguage(lang) ? lang : null
  const highlighted = language
    ? hljs.highlight(text, { language }).value
    : hljs.highlightAuto(text).value
  const languageClass = language ? ` language-${escapeHtml(language)}` : ''
  return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`
}

const DRAFT_KEY = 'mdtodocx-draft'
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null }
}

/**
 * VS Code-style syntax-highlighted Markdown Editor
 */
function MarkdownCodeEditor({ value, onChange, onScrollSync, editorRef }) {
  const backdropRef = useRef(null)

  // Highlight markdown syntax using highlight.js
  const highlightedCode = useMemo(() => {
    try {
      const res = hljs.highlight(value || '', { language: 'markdown', ignoreIllegals: true })
      // Append newline to match textarea height trailing behavior
      return res.value + (value.endsWith('\n') ? ' ' : '')
    } catch {
      return escapeHtml(value || '')
    }
  }, [value])

  const handleScroll = (e) => {
    if (backdropRef.current) {
      backdropRef.current.scrollTop = e.currentTarget.scrollTop
      backdropRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
    if (onScrollSync) {
      onScrollSync(e)
    }
  }

  return (
    <div className="syntax-editor-container">
      {/* Visual highlighted layer */}
      <pre ref={backdropRef} className="syntax-backdrop" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: highlightedCode }} />
      </pre>

      {/* Editable input layer */}
      <textarea
        ref={editorRef}
        value={value}
        onChange={onChange}
        onScroll={handleScroll}
        spellCheck="false"
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Markdown editor"
        placeholder="Start writing Markdown…"
      />
    </div>
  )
}

function AuthScreen({ onLogin }) {
  const [registering, setRegistering] = useState(false), [email, setEmail] = useState(''), [password, setPassword] = useState(''), [emailKnown, setEmailKnown] = useState(null), [showPassword, setShowPassword] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function checkEmail(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/check-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Enter a valid email address')
      setEmail(body.email); setEmailKnown(body.exists)
      if (!body.exists) setRegistering(true)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const bodyPayload = { email, password }
      const response = await fetch(registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyPayload) })
      const body = await response.json()
      if (!response.ok) throw new Error(body.detail || 'Authentication failed')
      onLogin(body)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  return <main className="auth-shell"><div className="auth-card"><div className="brand"><span className="brand-mark">M</span><span>Mark<span className="accent">→</span>Word</span></div><p className="eyebrow">PRIVATE MARKDOWN WORKSPACE</p><h1>{registering ? 'Create your account.' : 'Welcome back.'}</h1><p className="auth-copy">{registering ? 'Use your email to create a private workspace password.' : 'Enter your email to continue.'}</p>{emailKnown === null && !registering ? <form onSubmit={checkEmail}><label>EMAIL<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></label>{error && <div className="error">{error}</div>}<button className="export auth-submit" disabled={busy}>{busy ? 'Checking...' : 'Continue'}</button></form> : <form onSubmit={submit}><label>EMAIL<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></label><label>PASSWORD<span className="password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete={registering ? 'new-password' : 'current-password'} minLength="10" required /><button type="button" className="show-password" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></span><small>At least 10 characters</small></label>{error && <div className="error">{error}</div>}<button className="export auth-submit" disabled={busy}>{busy ? 'Working...' : registering ? 'Create account' : 'Log in'}</button></form>}<button className="auth-switch" onClick={() => { setRegistering(v => !v); setEmailKnown(null); setPassword(''); setError('') }}>{registering ? 'Already have an account? Log in' : 'Need an account? Register'}</button></div></main>
}

function AdminPanel({ onClose }) {
  const [users, setUsers] = useState([]), [error, setError] = useState('')
  async function load() { const response = await fetch('/api/admin/users'); if (response.ok) setUsers(await response.json()); else setError('Could not load users') }
  useEffect(() => { load() }, [])
  async function toggle(user) { const response = await fetch(`/api/admin/users/${user.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ blocked: !user.is_blocked }) }); if (!response.ok) setError('Could not update user'); await load() }
  async function remove(user) { if (!window.confirm(`Delete ${user.email || user.username} and all their notes?`)) return; const response = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' }); if (!response.ok) setError('Could not delete user'); await load() }
  return <div className="modal-backdrop"><section className="admin-panel"><div className="admin-head"><div><p className="eyebrow">WORKSPACE ADMIN</p><h2>User accounts</h2></div><button className="icon-button" onClick={onClose}>×</button></div>{error && <div className="error">{error}</div>}<div className="user-list">{users.map(user => <div className="user-row" key={user.id}><div><strong>{user.email || user.username}</strong><small>{user.is_admin ? 'Administrator' : user.is_blocked ? 'Blocked' : 'Active'}</small></div>{!user.is_admin && <span className="user-actions"><button className="secondary" onClick={() => toggle(user)}>{user.is_blocked ? 'Unblock' : 'Block'}</button><button className="delete-user" onClick={() => remove(user)}>Delete</button></span>}</div>)}</div></section></div>
}

function App() {
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [markdown, setMarkdown] = useState(() => readDraft()?.markdown ?? starter)
  const [filename, setFilename] = useState(() => readDraft()?.filename ?? 'my-document')
  const [noteId, setNoteId] = useState(() => readDraft()?.noteId ?? null)
  const [notes, setNotes] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(() => readDraft()?.saved ?? false)
  const [maximized, setMaximized] = useState(false)
  const [liveScroll, setLiveScroll] = useState(true)
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('mdtodocx-theme') === 'dark')
  const [adminOpen, setAdminOpen] = useState(false)
  const editorRef = useRef(null)
  const previewRef = useRef(null)
  const preview = useMemo(() => ({ __html: marked.parse(renderMermaid(renderMath(markdown)), { renderer: markdownRenderer }) }), [markdown])

  useEffect(() => { fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(value => { setUser(value); setAuthChecked(true) }).catch(() => setAuthChecked(true)) }, [])
  useEffect(() => { if (user) loadNotes() }, [user])
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ markdown, filename, noteId, saved })) } catch { /* local draft storage is optional */ }
  }, [markdown, filename, noteId, saved])
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
    localStorage.setItem('mdtodocx-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })
    mermaid.run({ nodes: previewRef.current?.querySelectorAll('.mermaid') || [] }).catch(() => setError('One of the Mermaid diagrams could not be rendered.'))
  }, [preview])
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); exportDoc() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveNote() }
      if (event.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [markdown, filename, noteId])

  async function loadNotes() {
    try { const response = await fetch('/api/notes'); if (response.ok) setNotes(await response.json()) } catch { /* offline UI still works */ }
  }
  function newDocument() { setMarkdown(''); setFilename('untitled'); setNoteId(null); setSaved(false); setError('') }
  function openDocument(item) { setMarkdown(item.markdown); setFilename(item.title.replace(/\.md$/i, '')); setNoteId(item.note_id || item.id); setSaved(true); setError('') }
  async function saveNote() {
    setBusy(true); setError('')
    try {
      const response = await fetch(noteId ? `/api/notes/${noteId}` : '/api/notes', { method: noteId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: filename || 'Untitled note', markdown }) })
      if (!response.ok) throw new Error('Could not save note')
      const note = await response.json(); setNoteId(note.id); setSaved(true); await loadNotes()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function deleteNote(event, id) {
    event.stopPropagation()
    if (!window.confirm('Delete this note?')) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/notes/${id}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete note')
      if (noteId === id) newDocument()
      await loadNotes()
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  async function exportDoc() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown, filename: `${filename || 'document'}.md` }) })
      if (!response.ok) { const body = await response.json(); throw new Error(body.detail || 'Export failed') }
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${filename || 'document'}.docx`; link.click(); URL.revokeObjectURL(url)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }
  function syncScroll(event) {
    if (!liveScroll) return
    const source = event.currentTarget
    const target = source === editorRef.current ? previewRef.current : editorRef.current
    if (!target) return
    const sourceMax = source.scrollHeight - source.clientHeight
    const targetMax = target.scrollHeight - target.clientHeight
    target.scrollTop = sourceMax > 0 ? (source.scrollTop / sourceMax) * targetMax : 0
  }

  if (!authChecked) return null
  if (!user) return <AuthScreen onLogin={setUser} />
  async function signOut() { await fetch('/api/auth/logout', { method: 'POST' }); setUser(null); setNotes([]) }

  return <main className={`shell ${maximized ? 'is-maximized' : ''}`}>
    <header className="topbar"><div className="brand"><span className="brand-mark">M</span><span>Mark<span className="accent">→</span>Word</span></div><div className="top-actions"><span className="welcome">{user.email || user.username}</span>{user.is_admin && <button className="secondary" onClick={() => setAdminOpen(true)}>Admin</button>}<span className="status"><i /> {saved ? 'Saved to notes' : 'Unsaved changes'}</span><button className="theme-toggle" onClick={() => setDarkMode(v => !v)} title="Toggle dark mode">{darkMode ? '☀ Light' : '☾ Dark'}</button><button className="secondary" onClick={signOut}>Log out</button><button className="secondary" onClick={saveNote} disabled={busy}>＋ Save note</button><button className="export" onClick={exportDoc} disabled={busy || !markdown.trim()}><span>↓</span>{busy ? 'Working…' : 'Export to Word'}</button></div></header>
    <section className="intro"><div><p className="eyebrow">MARKDOWN DOCUMENT STUDIO</p><h1>From plain text<br /><em>to polished pages.</em></h1><p className="subtitle">A focused writing space for turning Markdown into beautiful, editable Word documents.</p></div><div className="doc-info"><label>DOCUMENT NAME<input value={filename} onChange={e => { setFilename(e.target.value); setSaved(false) }} /><small>.docx</small></label><p>Supports headings, lists, tables, code, links, and LaTeX math.</p></div></section>
    <section className="app-area">
      <aside className="sidebar"><button className="new-doc" onClick={newDocument}>＋ New markdown</button><div className="sidebar-tabs"><span>Notes</span><span>{notes.length}</span></div><div className="side-list">{notes.map(item => <div className="side-item" key={item.id}><button className="side-open" onClick={() => openDocument(item)}><strong>{item.title}</strong><small>{new Date(`${item.updated_at}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></button><button className="delete-note" onClick={e => deleteNote(e, item.id)} title="Delete note" aria-label={`Delete ${item.title}`}>×</button></div>)}{!notes.length && <p className="empty">No notes yet.</p>}</div></aside>
      
      <div className="workspace">
        <div className="panel editor-panel">
          <div className="panel-head">
            <span><b className="dot blue" /> Markdown</span>
            <span className="head-tools">
              <span className="hint">{markdown.length.toLocaleString()} characters</span>
              <button className="icon-button" title="Maximize editor" onClick={() => setMaximized(true)}>⛶</button>
            </span>
          </div>
          
          {/* Syntax-Highlighted Editor */}
          <MarkdownCodeEditor
            editorRef={editorRef}
            value={markdown}
            onChange={e => { setMarkdown(e.target.value); setSaved(false) }}
            onScrollSync={syncScroll}
          />
        </div>

        <div className="divider" />

        <div className="panel preview-panel">
          <div className="panel-head">
            <span><b className="dot green" /> Preview</span>
            <span className="head-tools">
              <label className="toggle-label">
                <input type="checkbox" checked={liveScroll} onChange={e => setLiveScroll(e.target.checked)} />
                <span className="toggle" /> Live scroll
              </label>
              <span className="hint">Live preview</span>
              <button className="mini-export" onClick={exportDoc} disabled={busy || !markdown.trim()} title="Export from preview">↓ Export</button>
              <button className="icon-button" title="Maximize workspace" onClick={() => setMaximized(v => !v)}>⛶</button>
            </span>
          </div>
          <article ref={previewRef} onScroll={syncScroll} className="preview" dangerouslySetInnerHTML={preview} />
        </div>
      </div>
    </section>
    {error && <div className="error">{error}</div>}{adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    <footer><span>⌘ Enter to export · Esc to exit maximize</span><span>Powered by FastAPI + Pandoc + SQLite</span></footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)