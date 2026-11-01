import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import markdownLang from 'highlight.js/lib/languages/markdown'
import mermaid from 'mermaid'
import { instance as createGraphviz } from '@viz-js/viz'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import './styles.css'
import { dslToLatex, SHORTCUTS, toMarkdownMath } from './eqShortcuts.js'

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
  const mathBlocks = []
  const render = (value, displayMode) => {
    mathBlocks.push(katex.renderToString(value, { displayMode, throwOnError: false }))
    return `\u0000MATH${mathBlocks.length - 1}\u0000`
  }
  // Hide math before Markdown parsing, but leave code fences intact so marked
  // and the diagram renderers can still recognize code and diagram languages.
  const protectedSource = source.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>|```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`/gi, (code) => {
    const index = mathBlocks.push(code) - 1
    return `\u0000CODE${index}\u0000`
  })
  const withMath = protectedSource
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, value) => render(value.trim(), true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, value) => render(value.trim(), true))
    .replace(/\\\((.+?)\\\)/g, (_, value) => render(value.trim(), false))
    .replace(/(?<!\\)\$([^$\n]+?)\$/g, (_, value) => render(value.trim(), false))
  const sourceWithCodeRestored = withMath.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => mathBlocks[Number(index)])
  return { source: sourceWithCodeRestored, mathBlocks }
}

function escapeHtml(value) { 
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]) 
}

// CommonMark renders any line indented 4+ spaces as an indented code block,
// which ambushes nested lists and mid-sentence alignment. All three layers
// (Pandoc export via -indented_code_blocks, this preview, and the editor
// overlay) treat indented text as plain text instead: real code must use
// fenced ``` blocks. To keep the visual indentation the leading spaces become
// non-breaking spaces -- except on list-item, blockquote, and fenced lines so
// nested lists keep their structure.
function normalizeIndentedCode(source) {
  const rawBlocks = []
  const protectedSource = source.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, (block) => {
    rawBlocks.push(block)
    return `\u0000RAW${rawBlocks.length - 1}\u0000`
  })
  const lines = protectedSource.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const run = lines[i].match(/^[\t ]+/)?.[0]
    if (!run) continue
    const rest = lines[i].slice(run.length)
    if (!rest || /^(?:[-+*]\s|\d+[.)]\s|>\s?)/.test(rest) || rest.startsWith('<')) continue
    // tab stops of 4: a tab advances to the next multiple of 4 columns
    let columns = 0
    for (const character of run) columns += character === '\t' ? 4 - (columns % 4) : 1
    if (columns < 4) continue
    lines[i] = '\u00A0'.repeat(columns) + rest
  }
  return lines.join('\n').replace(/\u0000RAW(\d+)\u0000/g, (_, index) => rawBlocks[Number(index)])
}

function renderMermaid(source) { 
  // Newlines (incl. blank lines) are sentineled: marked's raw-HTML block token ends
  // at the first blank line, which would re-parse the diagram's remaining lines as
  // markdown (indented lines become <pre><code> blocks) and pollute mermaid's input.
  // The sentinel is restored after marked.parse in the preview pipeline.
  return source.replace(/```mermaid\s*\n([\s\S]*?)\n```/gi, (_, diagram) => `<div class="mermaid">${escapeHtml(diagram.trim()).replace(/\n/g, '\u0001')}</div>`) 
}

// Cheatsheet: render each shortcut's LaTeX output as visual math (KaTeX) instead of raw text.
// Placeholder "…" entries become \dots; purely word outputs are wrapped in \text so spaces survive.
function renderShortcutOutput(out) {
  if (!out) return ''
  const isPlain = !out.includes('\\')
  const source = isPlain ? `\\text{${out}}` : out.replace(/…/g, '\\dots')
  try {
    return katex.renderToString(source, { throwOnError: false })
  } catch {
    return escapeHtml(out)
  }
}

function renderGraphviz(source, diagrams) {
  let index = 0
  return source.replace(/```(?:dot|graphviz)\s*\n([\s\S]*?)\n```/gi, (_, diagram) => {
    const rendered = diagrams[index++]
    return rendered
      ? `<div class="graphviz-diagram">${rendered}</div>`
      : '```dot\n' + diagram + '\n```'
  })
}

function renderTikz(source, diagrams) {
  let index = 0
  // The separator before the closing fence must be optional: an empty block
  // is written as ```tikz followed immediately by the closing fence on the
  // next line, with no extra blank content line.
  return source.replace(/```(?:tikz|latex-diagram|pgfplots)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```[ \t]*/gi, (_, diagram) => {
    const rendered = diagrams[index++]
    if (!rendered) return `<pre><code class="language-latex">${escapeHtml(diagram)}</code></pre>`
    if (rendered.image) return `<div class="tikz-diagram"><img src="${rendered.image}" alt="TikZ diagram" /></div>`
    return `<div class="tikz-diagram tikz-error"><code>${escapeHtml(rendered.error || 'This TikZ diagram could not be rendered.')}</code></div>`
  })
}

const markdownRenderer = new marked.Renderer()
markdownRenderer.code = ({ text, lang }) => {
  try {
    const language = lang && hljs.getLanguage(lang) ? lang : null
    const highlighted = language
      ? hljs.highlight(text, { language }).value
      : hljs.highlightAuto(text).value
    const languageClass = language ? ` language-${escapeHtml(language)}` : ''
    return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`
  } catch {
    return `<pre><code>${escapeHtml(text)}</code></pre>`
  }
}

// Brand lockup from the SVG assets in frontend/public: logo mark + wordmark.
// Both theme variants are rendered; CSS picks the visible one per data-theme.
function Brand() {
  return (
    <div className="brand">
      <img className="brand-logo visible-light" src="/markdoc-logo-light.svg" alt="" aria-hidden="true" />
      <img className="brand-logo visible-dark" src="/markdoc-logo-dark.svg" alt="" aria-hidden="true" />
      <img className="brand-wordmark visible-light" src="/markdoc-branding-light.svg" alt="MarkDoc" />
      <img className="brand-wordmark visible-dark" src="/markdoc-branding-dark.svg" alt="MarkDoc" />
    </div>
  )
}

const DRAFT_KEY = 'mdtodocx-draft'
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null }
}

// Editor backdrop (syntax layer) highlighting is driven by mdast-util-from-markdown
// (the CommonMark/micromark parser used by remark) instead of hand-rolled text
// matching. It reports exact character offsets for each markdown construct, so the
// overlay always aligns with the textarea, and `_italic_` follows real CommonMark
// rules: `one_book` (intraword), `_ word` / `word _` and unmatched lone underscores
// never italicize, while genuine `_word_` pairs do -- a stray `_` can no longer
// sweep the rest of the document into an italic span.
const MDAST_CLASSES = {
  heading: 'hljs-section',
  code: 'hljs-code',
  inlineCode: 'hljs-code',
  emphasis: 'hljs-emphasis',
  strong: 'hljs-strong',
  blockquote: 'hljs-quote',
  thematicBreak: 'hljs-bullet',
  link: 'hljs-link',
  image: 'hljs-link',
  html: 'hljs-comment',
}
const MATH_SPANS_RE = /(\$\$[\s\S]*?\$\$)|(\\\[([\s\S]*?)\\\])|(\\\((.+?)\\\))|((?<!\\)\$[^\n$]+?\$)/g

function markdownClassMap(source) {
  const classes = new Array(source.length).fill(null)
  const addRange = (start, end, cls) => {
    start = Math.max(0, start)
    end = Math.min(source.length, end)
    for (let i = start; i < end; i++) (classes[i] ||= []).push(cls)
  }
  const collectCodeRanges = (tree) => {
    const codeRanges = []
    const walk = (node) => {
      if (node.position && ((node.type === 'code' && /^\s{0,3}(?:```|~~~)/.test(source.slice(node.position.start.offset, node.position.end.offset))) || node.type === 'inlineCode')) {
        codeRanges.push([node.position.start.offset, node.position.end.offset])
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    return codeRanges
  }
  const codeRanges = collectCodeRanges(fromMarkdown(source))
  const mathRanges = []
  for (const match of source.matchAll(MATH_SPANS_RE)) {
    const start = match.index
    const end = start + match[0].length
    if (!codeRanges.some(([codeStart, codeEnd]) => start < codeEnd && codeStart < end)) {
      mathRanges.push([start, end])
    }
  }
  const markdownSource = source.split('')
  for (const [start, end] of mathRanges) {
    for (let i = start; i < end; i++) {
      if (markdownSource[i] !== '\r' && markdownSource[i] !== '\n') markdownSource[i] = 'x'
    }
  }
  const walk = (node) => {
    if (node.position) {
      const { start, end } = node.position
      let cls = MDAST_CLASSES[node.type]
      // Fenced blocks (```/~~~, optionally indented <=3 spaces) are real code;
      // indented code blocks are disabled app-wide, so leave them plain text.
      if (node.type === 'code' && !/^\s{0,3}(?:```|~~~)/.test(source.slice(start.offset, end.offset))) {
        cls = null
      }
      if (cls) addRange(start.offset, end.offset, cls)
      if (node.type === 'listItem') {
        // color only the bullet / ordered marker (plus its trailing spaces)
        const first = node.children?.[0]
        if (first?.position) addRange(start.offset, first.position.start.offset, 'hljs-bullet')
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  // Mask LaTeX before parsing Markdown so underscores inside formulas cannot
  // open an emphasis span that leaks into later equations or prose. Replacing
  // characters with non-whitespace placeholders also prevents a leading
  // equation from becoming an indented code block; offsets stay unchanged.
  walk(fromMarkdown(markdownSource.join('')))
  for (const [start, end] of mathRanges) {
    addRange(start, end, 'hljs-math')
  }
  return classes
}

function renderBackdropHtml(source) {
  const classes = markdownClassMap(source)
  let html = ''
  let i = 0
  while (i < source.length) {
    const key = classes[i] ? [...classes[i]].sort().join(' ') : null
    let j = i + 1
    while (j < source.length && (classes[j] ? [...classes[j]].sort().join(' ') : null) === key) j++
    const chunk = escapeHtml(source.slice(i, j))
    html += key ? `<span class="${key}">${chunk}</span>` : chunk
    i = j
  }
  return html
}

/**
 * VS Code-style syntax-highlighted Markdown Editor
 */
function MarkdownCodeEditor({ value, onChange, onScrollSync, editorRef }) {
  const backdropRef = useRef(null)

  // Highlight markdown syntax via the CommonMark AST (exact-offset overlay)
  const highlightedCode = useMemo(() => {
    try {
      const raw = value || ''
      return renderBackdropHtml(raw) + (raw.endsWith('\n') ? ' ' : '')
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

  // Tab inserts 4 spaces (safe everywhere: indented code blocks are disabled
  // app-wide). With a multi-line selection, Tab/Shift+Tab indent or outdent
  // every touched line. setRangeText + a synthetic input event keeps React
  // state (and the syntax overlay) in sync.
  const handleTabKey = (event) => {
    if (event.key !== 'Tab') return
    event.preventDefault()
    const ta = event.currentTarget
    const { value, selectionStart, selectionEnd } = ta
    const indent = '    '

    const insertSpaces = () => {
      ta.focus()
      if (!document.execCommand('insertText', false, indent)) {
        ta.setRangeText(indent, selectionStart, selectionEnd, 'end')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }

    const blockMode = event.shiftKey || value.slice(selectionStart, selectionEnd).includes('\n')
    if (!blockMode) {
      insertSpaces()
      return
    }

    const rangeStart = value.lastIndexOf('\n', selectionStart - 1) + 1
    let rangeEnd = value.indexOf('\n', Math.max(selectionEnd - 1, selectionStart))
    if (rangeEnd === -1) rangeEnd = value.length
    const lines = value.slice(rangeStart, rangeEnd).split('\n')
    const deltas = lines.map((line) => (event.shiftKey
      ? -(line.match(/^(?: {1,4}|\t)/)?.[0]?.length ?? 0)
      : indent.length))
    const replacement = (event.shiftKey
      ? lines.map((line) => line.replace(/^(?: {1,4}|\t)/, ''))
      : lines.map((line) => indent + line)
    ).join('\n')

    const lineStarts = []
    let acc = rangeStart
    for (const line of lines) { lineStarts.push(acc); acc += line.length + 1 }
    const mapOffset = (offset) => {
      let corrected = offset
      for (let i = 0; i < lines.length; i++) {
        if (offset >= lineStarts[i]) corrected += deltas[i]
      }
      return Math.max(0, corrected)
    }

    ta.setRangeText(replacement, rangeStart, rangeEnd, 'end')
    ta.setSelectionRange(mapOffset(selectionStart), mapOffset(selectionEnd))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
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
        onKeyDown={handleTabKey}
        spellCheck="false"
        autoCapitalize="off"
        autoComplete="off"
        aria-label="Markdown editor"
        placeholder="Start writing Markdown…"
      />
    </div>
  )
}

function EquationHelper({ onInsert, onClose }) {
  const [shortcut, setShortcut] = useState('frac(1,n) sum(i=1..n, x_i)')
  const [minimized, setMinimized] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [mode, setMode] = useState('inline')
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragOff, setDragOff] = useState({ x: 0, y: 0 })
  const [copied, setCopied] = useState('')
  const cardRef = useRef(null)

  const latex = useMemo(() => {
    try { return dslToLatex(shortcut) } catch { return shortcut }
  }, [shortcut])
  const wrapped = useMemo(() => {
    if (!latex) return ''
    return mode === 'inline' ? `\\(${latex}\\)` : `\\[${latex}\\]`
  }, [latex, mode])
  const markdownBlock = useMemo(() => toMarkdownMath(latex, true), [latex])

  const previewHtml = useMemo(() => {
    if (!latex) return '<span class="eq-empty">Type a shortcut on the left…</span>'
    try { return katex.renderToString(latex, { displayMode: true, throwOnError: false }) } catch { return '<span class="eq-error">Could not render</span>' }
  }, [latex])

  function copy(text, key) {
    navigator.clipboard.writeText(text).then(() => { setCopied(key); setTimeout(() => setCopied(''), 1500) }).catch(() => {})
  }

  function onMouseDown(e) {
    // only drag via header
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    setDragging(true)
    setDragOff({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }
  useEffect(() => {
    if (!dragging) return
    function move(e) { setPos({ x: e.clientX - dragOff.x, y: e.clientY - dragOff.y }) }
    function up() { setDragging(false) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [dragging, dragOff])

  // clamp position if user drags offscreen? keep simple

  return (
    <>
      <div
        ref={cardRef}
        className={`eq-float ${minimized ? 'is-min' : ''} ${dragging ? 'is-dragging' : ''}`}
        style={pos.x || pos.y ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
      >
        <div className="eq-head" onMouseDown={onMouseDown}>
          <span className="eq-title"><span className="eq-logo">∑</span> Equation Studio</span>
          <span className="eq-head-actions">
            <button className="eq-icon" title="Show shortcuts" onClick={() => setShowHelp(v => !v)} aria-label="Shortcuts info">ⓘ</button>
            <button className="eq-icon" title={minimized ? 'Expand' : 'Minimise'} onClick={() => setMinimized(v => !v)}>{minimized ? '▢' : '—'}</button>
            <button className="eq-icon eq-close" title="Hide equation studio" onClick={() => onClose?.()}>✕</button>
          </span>
        </div>

        {!minimized && (
          <div className="eq-body">
            <div className="eq-split">
              <div className="eq-pane eq-input-pane">
                <div className="eq-pane-head">Shortcut <small>ML DSL</small></div>
                <textarea
                  value={shortcut}
                  onChange={e => setShortcut(e.target.value)}
                  placeholder="Try: grad(L,w)  or  norm(x,2)  or  mat[1 2&#10;3 4]"
                  spellCheck={false}
                />
                <div className="eq-hint">Examples: <button onClick={() => setShortcut('partial(L, w)')}>partial(L,w)</button> <button onClick={() => setShortcut('grad(J,w)')}>grad(J,w)</button> <button onClick={() => setShortcut('mat[\n1 2\n3 4\n]')}>mat[...]</button></div>
              </div>
              <div className="eq-pane eq-preview-pane">
                <div className="eq-pane-head">Preview <small>KaTeX</small></div>
                <div className="eq-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
                <div className="eq-raw-wrap">
                  <div className="eq-mode">
                    <button className={`eq-mode-btn ${mode === 'inline' ? 'is-active' : ''}`} onClick={() => setMode('inline')} title="Inline math \(...\)">Inline \( \)</button>
                    <button className={`eq-mode-btn ${mode === 'block' ? 'is-active' : ''}`} onClick={() => setMode('block')} title="Display math \[...\]">Block \[ \]</button>
                    <span className="eq-mode-hint">{mode === 'inline' ? 'inline' : 'display'}</span>
                  </div>
                  <div className="eq-raw-head">
                    <span>LaTeX</span>
                    <span className="eq-raw-actions">
                      <button className="eq-copy" onClick={() => copy(latex, 'latex')}>{copied === 'latex' ? '✓ Copied' : 'Raw'}</button>
                      <button className="eq-copy primary" onClick={() => copy(wrapped, 'wrapped')}>{copied === 'wrapped' ? '✓ Copied' : mode === 'inline' ? 'Copy \\( \\)' : 'Copy \\[ \\]'}</button>
                    </span>
                  </div>
                  <pre className="eq-raw"><code>{wrapped || '—'}</code></pre>
                  {onInsert && <button className="eq-insert" onClick={() => onInsert(wrapped)}>Insert {mode === 'inline' ? 'inline' : 'block'} into editor ↓</button>}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showHelp && (
        <div className="eq-help-backdrop" onClick={() => setShowHelp(false)}>
          <div className="eq-help" onClick={e => e.stopPropagation()}>
            <div className="eq-help-head">
              <h3>Shortcut cheatsheet</h3>
              <button className="eq-icon" onClick={() => setShowHelp(false)}>✕</button>
            </div>
            <p className="eq-help-sub">Type the shortcut on the left, see the rendered result on the right. Hover an output to reveal its raw LaTeX.</p>
            <div className="eq-help-grid">
              {SHORTCUTS.map(s => (
                <div key={s.in} className="eq-help-row">
                  <code>{s.in}</code>
                  <span>→</span>
                  <code className="eq-help-out" title={s.out} dangerouslySetInnerHTML={{ __html: renderShortcutOutput(s.out) }} />
                  <small>{s.desc}</small>
                </div>
              ))}
            </div>
            <div className="eq-help-foot">
              <small>Tip: choose <code>Inline \(...\)</code> for in-text math or <code>Block \[...\]</code> for display. Copied text is ready to paste into Markdown and the Insert button drops it at your cursor.</small>
            </div>
          </div>
        </div>
      )}
    </>
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
  return <main className="auth-shell"><div className="auth-card"><Brand /><p className="eyebrow">PRIVATE MARKDOWN WORKSPACE</p><h1>{registering ? 'Create your account.' : 'Welcome back.'}</h1><p className="auth-copy">{registering ? 'Use your email to create a private workspace password.' : 'Enter your email to continue.'}</p>{emailKnown === null && !registering ? <form onSubmit={checkEmail}><label>EMAIL<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></label>{error && <div className="error">{error}</div>}<button className="export auth-submit" disabled={busy}>{busy ? 'Checking...' : 'Continue'}</button></form> : <form onSubmit={submit}><label>EMAIL<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" inputMode="email" required /></label><label>PASSWORD<span className="password-wrap"><input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)} autoComplete={registering ? 'new-password' : 'current-password'} minLength="8" required /><button type="button" className="show-password" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button></span><small>At least 8 characters</small></label>{error && <div className="error">{error}</div>}<button className="export auth-submit" disabled={busy}>{busy ? 'Working...' : registering ? 'Create account' : 'Log in'}</button></form>}<button className="auth-switch" onClick={() => { setRegistering(v => !v); setEmailKnown(null); setPassword(''); setError('') }}>{registering ? 'Already have an account? Log in' : 'Need an account? Register'}</button></div></main>
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
  const [notice, setNotice] = useState('')
  const [saved, setSaved] = useState(() => readDraft()?.saved ?? false)
  const [maximized, setMaximized] = useState(false)
  const [liveScroll, setLiveScroll] = useState(true)
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('mdtodocx-theme') === 'dark')
  const [adminOpen, setAdminOpen] = useState(false)
  const [graphvizDiagrams, setGraphvizDiagrams] = useState([])
  const [tikzDiagrams, setTikzDiagrams] = useState([])
  const [eqOpen, setEqOpen] = useState(() => {
    try { return localStorage.getItem('mdtodocx-equation-studio-open') !== 'false' } catch { return true }
  })
  const [reference, setReference] = useState(() => readDraft()?.reference ?? 'Default')
  const [referenceStyles, setReferenceStyles] = useState([{ id: 'Default', name: 'Default' }])
  const editorRef = useRef(null)
  const previewRef = useRef(null)
  const tikzCacheRef = useRef(new Map())
  const preview = useMemo(() => {
    try {
      // Process math while every diagram is still a fenced code block. Once a
      // diagram becomes raw HTML/SVG, math delimiters in its source must not be
      // interpreted as equations.
      const math = renderMath(normalizeIndentedCode(markdown))
      const withGraphviz = renderGraphviz(math.source, graphvizDiagrams)
      const withMermaid = renderMermaid(withGraphviz)
      const source = renderTikz(withMermaid, tikzDiagrams)
      let html = marked.parse(source, { renderer: markdownRenderer }).replace(/\u0001/g, '\n')
      html = html.replace(/\u0000MATH(\d+)\u0000/g, (_, index) => math.mathBlocks[Number(index)])
      return { __html: html }
    } catch (renderError) {
      console.error('Markdown preview rendering failed:', renderError)
      try {
        // Keep ordinary Markdown formatting even if an enhancement fails; a
        // failing diagram must not turn the entire document into one code box.
        const fallback = renderTikz(markdown, tikzDiagrams)
        return { __html: marked.parse(fallback, { renderer: markdownRenderer }) }
      } catch (fallbackError) {
        console.error('Markdown fallback rendering failed:', fallbackError)
        return { __html: `<div class="preview-render-error">Preview could not be rendered. Your Markdown is still available in the editor.</div>` }
      }
    }
  }, [markdown, graphvizDiagrams, tikzDiagrams])

  useEffect(() => { fetch('/api/auth/me').then(response => response.ok ? response.json() : null).then(value => { setUser(value); setAuthChecked(true) }).catch(() => setAuthChecked(true)) }, [])
  useEffect(() => { if (user) { loadNotes(); loadStyles() } }, [user])
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ markdown, filename, noteId, saved, reference })) } catch { /* local draft storage is optional */ }
  }, [markdown, filename, noteId, saved, reference])
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
    localStorage.setItem('mdtodocx-theme', darkMode ? 'dark' : 'light')
  }, [darkMode])
  useEffect(() => {
    try { localStorage.setItem('mdtodocx-equation-studio-open', String(eqOpen)) } catch { /* preference storage is optional */ }
  }, [eqOpen])
  useEffect(() => {
    mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' })
    mermaid.run({ nodes: previewRef.current?.querySelectorAll('.mermaid') || [] }).catch(() => setError('One of the Mermaid diagrams could not be rendered.'))
  }, [preview])
  useEffect(() => {
    let cancelled = false
    const blocks = [...markdown.matchAll(/```(?:dot|graphviz)\s*\n([\s\S]*?)\n```/gi)]
    if (!blocks.length) {
      setGraphvizDiagrams([])
      return () => { cancelled = true }
    }
    createGraphviz().then(viz => {
      const diagrams = blocks.map(([, source]) => {
        try {
          return viz.renderString(source.trim(), { format: 'svg' })
        } catch {
          return ''
        }
      })
      if (!cancelled) setGraphvizDiagrams(diagrams)
    }).catch(() => {
      if (!cancelled) setGraphvizDiagrams(blocks.map(() => ''))
    })
    return () => { cancelled = true }
  }, [markdown])
  useEffect(() => {
    let cancelled = false
    const blocks = [...markdown.matchAll(/```(?:tikz|latex-diagram|pgfplots)[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?```[ \t]*/gi)]
    const sources = blocks.map(([, source]) => source.trim())
    // Empty fences never need the server; seed the cache locally.
    const EMPTY_TIKZ = { error: 'This TikZ fence is empty.' }
    sources.forEach(source => { if (!source) tikzCacheRef.current.set(source, EMPTY_TIKZ) })
    const diagrams = sources.map(source => tikzCacheRef.current.get(source) ?? null)
    if (!sources.length) {
      setTikzDiagrams([])
      return () => { cancelled = true }
    }
    if (diagrams.every(Boolean)) {
      setTikzDiagrams(diagrams)
      return () => { cancelled = true }
    }
    // TikZ compiles on the server (slow), so preview fetches are debounced and
    // cached per source until the code changes. Errors are cached too, mapped
    // to the same fence position on every keystroke.
    const timer = setTimeout(() => {
      Promise.all(sources.map(async (source) => {
        const cached = tikzCacheRef.current.get(source)
        if (cached) return cached
        try {
          const response = await fetch('/api/render-tikz', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source }),
          })
          const data = await response.json().catch(() => null)
          const value = response.ok && data?.image
            ? { image: data.image }
            : { error: typeof data?.detail === 'string' && data.detail ? data.detail : 'This TikZ diagram could not be rendered.' }
          tikzCacheRef.current.set(source, value)
          return value
        } catch {
          const value = { error: 'Could not reach the server to render this TikZ diagram.' }
          tikzCacheRef.current.set(source, value)
          return value
        }
      })).then(values => { if (!cancelled) setTikzDiagrams(values) })
    }, 700)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [markdown])
  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); exportDoc() }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveNote() }
      if (event.key === 'Escape') setMaximized(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [markdown, filename, noteId])

  function insertEq(block) {
    const ta = editorRef.current
    const start = ta ? ta.selectionStart : markdown.length
    const end = ta ? ta.selectionEnd : markdown.length
    const before = markdown.slice(0, start)
    const after = markdown.slice(end)
    const needsNl = before && !before.endsWith('\n') ? '\n' : ''
    const next = `${before}${needsNl}${block}\n${after}`
    setMarkdown(next); setSaved(false)
    setTimeout(() => { if (ta) { const p = (before + needsNl + block + '\n').length; ta.focus(); ta.setSelectionRange(p, p) } }, 0)
  }
  async function loadNotes() {
    try { const response = await fetch('/api/notes'); if (response.ok) setNotes(await response.json()) } catch { /* offline UI still works */ }
  }
  async function loadStyles() {
    try {
      const response = await fetch('/api/reference-styles')
      if (!response.ok) return
      const data = await response.json()
      if (data.styles?.length) {
        setReferenceStyles(data.styles)
        setReference(prev => data.styles.some(style => style.id === prev) ? prev : data.styles[0].id)
      }
    } catch { /* offline UI still works */ }
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
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown, filename: `${filename || 'document'}.md`, reference }) })
      if (!response.ok) { const body = await response.json(); throw new Error(body.detail || 'Export failed') }
      const blob = await response.blob()
      const suggestedName = `${filename || 'document'}.docx`
      if (isTauri()) {
        const path = await save({
          defaultPath: suggestedName,
          filters: [{ name: 'Word document', extensions: ['docx'] }],
        })
        if (path) {
          const result = await invoke('save_export_file', {
            path,
            contents: Array.from(new Uint8Array(await blob.arrayBuffer())),
          })
          setNotice(`Saved ${result.bytesWritten.toLocaleString()} bytes to ${result.path}`)
        }
      } else {
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = suggestedName
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setNotice('The document download has started.')
      }
    } catch (e) { setError(e.message || String(e)) } finally { setBusy(false) }
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
    <header className="topbar"><Brand /><div className="top-actions"><span className="welcome">{user.email || user.username}</span>{user.is_admin && <button className="secondary" onClick={() => setAdminOpen(true)}>Admin</button>}<span className="status"><i /> {saved ? 'Saved to notes' : 'Unsaved changes'}</span><button className="secondary" onClick={() => setEqOpen(v => !v)} title="Equation helper">{eqOpen ? '∑ Hide eq' : '∑ Equations'}</button><button className="theme-toggle" onClick={() => setDarkMode(v => !v)} title="Toggle dark mode">{darkMode ? '☀ Light' : '☾ Dark'}</button><button className="secondary" onClick={signOut}>Log out</button><button className="secondary" onClick={saveNote} disabled={busy}>＋ Save note</button><button className="export" onClick={exportDoc} disabled={busy || !markdown.trim()}><span>↓</span>{busy ? 'Working…' : 'Export to Word'}</button></div></header>
    <section className="intro"><div><p className="eyebrow">MARKDOWN DOCUMENT STUDIO</p><h1>From plain text<br /><em>to polished pages.</em></h1><p className="subtitle">A focused writing space for turning Markdown into beautiful, editable Word documents.</p></div><div className="doc-info"><label>DOCUMENT NAME<input value={filename} onChange={e => { setFilename(e.target.value); setSaved(false) }} /><small>.docx</small></label><div className="doc-row"><span className="doc-info-label">REFERENCE STYLE</span><span className="style-row">{referenceStyles.map(style => <button key={style.id} type="button" className={`style-chip${reference === style.id ? ' is-active' : ''}`} onClick={() => setReference(style.id)} title={`Export using ${style.id}.docx template`}>{style.name}</button>)}</span></div><p>Supports headings, lists, tables, code, links, and LaTeX math.</p></div></section>
    <section className="app-area">
      <aside className="sidebar"><button className="new-doc" onClick={newDocument}>＋ New markdown</button><div className="sidebar-tabs"><span>Notes</span><span>{notes.length}</span></div><div className="side-list">{notes.map(item => <div className="side-item" key={item.id}><button className="side-open" onClick={() => openDocument(item)}><strong>{item.title}</strong><small>{new Date(`${item.updated_at}Z`).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small></button><button className="delete-note" onClick={e => deleteNote(e, item.id)} title="Delete note" aria-label={`Delete ${item.title}`}>×</button></div>)}{!notes.length && <p className="empty">No notes yet.</p>}</div></aside>
      
      <div className="workspace">
        <div className="panel editor-panel">
          <div className="panel-head">
            <span><b className="dot blue" /> Markdown</span>
            <span className="head-tools">
              <span className="hint">{markdown.length.toLocaleString()} characters</span>
              <button className="icon-button" title={maximized ? 'Restore workspace' : 'Maximize workspace'} onClick={() => setMaximized(value => !value)}>⛶</button>
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
    {error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}{adminOpen && <AdminPanel onClose={() => setAdminOpen(false)} />}
    {eqOpen && <EquationHelper onInsert={insertEq} onClose={() => setEqOpen(false)} />}
    {!eqOpen && <button className="eq-fab" onClick={() => setEqOpen(true)} title="Open Equation Studio">∑ fx</button>}
    <footer><span>⌘ Enter to export · Esc to exit maximize</span><span>Powered by FastAPI + Pandoc + SQLite</span></footer>
  </main>
}

createRoot(document.getElementById('root')).render(<App />)
