// ML Math Shortcut Layer -> LaTeX
// Lightweight formatter, not a symbolic engine. Iteratively expands inner-most calls.

function splitArgs(argString) {
  const args = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < argString.length; i++) {
    const ch = argString[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      args.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim() || args.length) args.push(cur.trim())
  if (args.length === 1 && args[0] === '') return []
  return args
}

function parseSumBound(expr) {
  // expr like "i=1..n" or "i=1..10" or "i=0..n"
  if (!expr) return '_{}'
  if (expr.includes('=')) {
    const [v, range] = expr.split('=')
    const va = v.trim()
    const rg = range.trim()
    if (rg.includes('..')) {
      const [lo, hi] = rg.split('..')
      return `_{${va}=${lo.trim()}}^{${hi.trim()}}`
    }
    return `_{${va}=${rg}}`
  }
  if (expr.includes('..')) {
    const [lo, hi] = expr.split('..')
    return `_{${lo.trim()}}^{${hi.trim()}}`
  }
  return `_{${expr}}`
}

function parseIntegralBound(expr) {
  if (!expr) return ''
  if (expr.includes('..')) {
    const [lo, hi] = expr.split('..')
    return `_{${lo.trim()}}^{${hi.trim()}}`
  }
  return `_{${expr}}`
}

function limitTargetToLatex(t) {
  t = t.trim()
  if (t === 'inf' || t === 'infinity' || t === '\\infty') return '\\infty'
  if (t === '-inf' || t === '-infinity') return '-\\infty'
  return t
}

function doMat(latexRows) {
  return `\\begin{bmatrix}\n${latexRows}\n\\end{bmatrix}`
}

export function dslToLatex(input) {
  if (!input || !input.trim()) return ''
  let s = input

  // 1) mat / col / row blocks  (handle before function parens)
  s = s.replace(/mat\s*\[([\s\S]*?)\]/g, (_, inner) => {
    const rows = inner.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    if (!rows.length) return ''
    const latexRows = rows.map((row) => row.split(/\s+/).join(' & ')).join('\\\\\n')
    return doMat(latexRows)
  })
  s = s.replace(/col\s*\[([\s\S]*?)\]/g, (_, inner) => {
    const rows = inner.trim().split('\n').map((l) => l.trim()).filter(Boolean)
    if (!rows.length) return ''
    return doMat(rows.join('\\\\\n'))
  })
  s = s.replace(/row\s*\[([\s\S]*?)\]/g, (_, inner) => {
    const t = inner.trim().replace(/\n/g, ' ')
    return doMat(t.split(/\s+/).filter(Boolean).join(' & '))
  })

  // 2) function expansion via recursive balanced-paren scanner (handles nested parens like f(x) inside args)
  // ordered longest first so partial2 beats partial, norm2 beats norm, etc.
  const FUNC_NAMES_RAW = ['intersection','underline','overline','minimize','maximize','subject','partial2','jacobian','hadamard','sigmoid','softmax','integral','argmax','argmin','partial','deriv2','forall','exists','pinv','trans','inner','outer','trace','cross','floor','zeros','diag','sqrt','tilde','grad','hess','norm2','frac','norm','vec','sum','prod','limit','mean','ceil','ones','eig','svd','hat','bar','cal','bf','bb','rm','it','inv','det','rank','zero','relu','Var','Cov','text','eye','pow','log','exp','min','max','dot','abs','deriv','st','E','P','T','I']
  const FUNC_NAMES = [...FUNC_NAMES_RAW].sort((a,b)=> b.length - a.length)
  const FUNC_SET = new Set(FUNC_NAMES)

  function applyHandler(name, rawArgs, full) {
    const a = rawArgs[0] ?? ''
    const b = rawArgs[1] ?? ''
    const c = rawArgs[2] ?? ''
    // --- progressive partial: partial, partial2 ... partialN (any n) ---
    const pm = name.match(/^partial(\d*)$/)
    if (pm) {
      if (rawArgs.length < 2) return full
      const nStr = pm[1]
      const n = nStr ? parseInt(nStr, 10) : 1
      const f = a
      const vars = rawArgs.slice(1)
      const exp = n === 1 ? '' : (n > 9 ? `^{${n}}` : `^${n}`)
      const expDen = n === 1 ? '' : (n > 9 ? `^{${n}}` : `^${n}`)
      if (vars.length === 1) {
        if (n === 1) return `\\frac{\\partial ${f}}{\\partial ${vars[0]}}`
        return `\\frac{\\partial${exp} ${f}}{\\partial ${vars[0]}${expDen}}`
      }
      // mixed: e.g. partial2(f,x,y) or partial3(f,x,y,z)
      const denom = vars.map(v => `\\partial ${v}`).join('')
      if (n === 1) return `\\frac{\\partial ${f}}{${denom}}`
      return `\\frac{\\partial${exp} ${f}}{${denom}}`
    }
    const dm = name.match(/^deriv(\d*)$/)
    if (dm) {
      if (rawArgs.length < 2) return full
      const nStr = dm[1]
      const n = nStr ? parseInt(nStr, 10) : 1
      const f = a
      const v = b
      if (rawArgs.length === 2) {
        if (n === 1) return `\\frac{d${f}}{d${v}}`
        const exp = n > 9 ? `^{${n}}` : `^${n}`
        return `\\frac{d${exp}${f}}{d${v}${exp}}`
      }
      // fallback for more vars (rare): treat as mixed
      const vars = rawArgs.slice(1)
      const exp = n === 1 ? '' : (n > 9 ? `^{${n}}` : `^${n}`)
      const denom = vars.map(vv => `d${vv}`).join('')
      if (n === 1) return `\\frac{d${f}}{${denom}}`
      return `\\frac{d${exp}${f}}{${denom}}`
    }
    switch (name) {
      case 'frac': if (rawArgs.length < 2) return full; return `\\frac{${a}}{${b}}`
      case 'grad': if (rawArgs.length === 1) return `\\nabla ${a}`; return `\\nabla_{${b}} ${a}`
      case 'hess': if (rawArgs.length === 1) return `\\nabla^2 ${a}`; return `\\nabla_{${b}}^2 ${a}`
      case 'jacobian': if (rawArgs.length < 2) return full; return `J_{${b}} ${a}`
      case 'vec': return `\\mathbf{${a}}`
      case 'T': return `${a}^\\top`
      case 'trans': return `${a}^\\top`
      case 'norm': if (rawArgs.length === 1) return `\\|${a}\\|`; return `\\|${a}\\|_{${b}}`
      case 'norm2': return `\\|${a}\\|_2^2`
      case 'sum': { if (rawArgs.length < 2) return full; return `\\sum${parseSumBound(a)} ${b}` }
      case 'prod': { if (rawArgs.length < 2) return full; return `\\prod${parseSumBound(a)} ${b}` }
      case 'min': if (rawArgs.length < 2) return full; return `\\min_{${a}} ${b}`
      case 'max': if (rawArgs.length < 2) return full; return `\\max_{${a}} ${b}`
      case 'minimize': if (rawArgs.length < 2) return full; return `\\min_{${a}} ${b}`
      case 'maximize': if (rawArgs.length < 2) return full; return `\\max_{${a}} ${b}`
      case 'argmin': if (rawArgs.length < 2) return full; return `\\arg\\min_{${a}} ${b}`
      case 'argmax': if (rawArgs.length < 2) return full; return `\\arg\\max_{${a}} ${b}`
      case 'limit': {
        if (rawArgs.length < 2) return full
        const arrowIdx = a.indexOf('->')
        if (arrowIdx !== -1) { const v = a.slice(0, arrowIdx).trim(); const tgt = limitTargetToLatex(a.slice(arrowIdx + 2)); return `\\lim_{${v}\\to ${tgt}}${b}` }
        return `\\lim_{${a}}${b}`
      }
      case 'integral': { if (rawArgs.length === 2) return `\\int ${a}\\,d${b}`; if (rawArgs.length >= 3) return `\\int${parseIntegralBound(a)} ${b}\\,d${c}`; return full }
      case 'E': { if (a.includes('|')) { const [L,R]=a.split('|'); return `\\mathbb{E}[${L.trim()}\\mid ${R.trim()}]` } return `\\mathbb{E}[${a}]` }
      case 'P': { if (a.includes('|')) { const [L,R]=a.split('|'); return `P(${L.trim()}\\mid ${R.trim()})` } return `P(${a})` }
      case 'Var': { if (a.includes('|')) { const [L,R]=a.split('|'); return `\\operatorname{Var}(${L.trim()}\\mid ${R.trim()})` } return `\\operatorname{Var}(${a})` }
      case 'Cov': return `\\operatorname{Cov}(${rawArgs.join(', ')})`
      case 'abs': return `\\left|${a}\\right|`
      case 'floor': return `\\left\\lfloor ${a}\\right\\rfloor`
      case 'ceil': return `\\left\\lceil ${a}\\right\\rceil`
      case 'dot': if (rawArgs.length < 2) return full; return `${a}^\\top ${b}`
      case 'cross': if (rawArgs.length < 2) return full; return `${a}\\times ${b}`
      case 'hadamard': if (rawArgs.length < 2) return full; return `${a}\\odot ${b}`
      case 'det': return `\\det(${a})`
      case 'trace': return `\\operatorname{tr}(${a})`
      case 'rank': return `\\operatorname{rank}(${a})`
      case 'I': return `I_{${a}}`
      case 'eye': return `I_{${a}}`
      case 'zero': return `\\mathbf{0}_{${a}}`
      case 'zeros': {
        if (rawArgs.length === 1) return `\\mathbf{0}_{${a}}`
        if (rawArgs.length >= 2) return `\\mathbf{0}_{${a} \\times ${b}}`
        return full
      }
      case 'ones': {
        if (rawArgs.length === 1) return `\\mathbf{1}_{${a}}`
        if (rawArgs.length >= 2) return `\\mathbf{1}_{${a} \\times ${b}}`
        return full
      }
      case 'mean': return `\\bar{${a}}`
      case 'bar': return `\\bar{${a}}`
      case 'hat': return `\\hat{${a}}`
      case 'tilde': return `\\tilde{${a}}`
      case 'overline': return `\\overline{${a}}`
      case 'underline': return `\\underline{${a}}`
      case 'sqrt': {
        if (rawArgs.length === 1) return `\\sqrt{${a}}`
        if (rawArgs.length >= 2) return `\\sqrt[${a}]{${b}}`
        return full
      }
      case 'pow': if (rawArgs.length < 2) return full; return `${a}^{${b}}`
      case 'bf': return `\\mathbf{${a}}`
      case 'it': return `\\mathit{${a}}`
      case 'cal': return `\\mathcal{${a}}`
      case 'bb': return `\\mathbb{${a}}`
      case 'rm': return `\\mathrm{${a}}`
      case 'inner': if (rawArgs.length < 2) return full; return `\\langle ${a}, ${b} \\rangle`
      case 'outer': if (rawArgs.length < 2) return full; return `${a} ${b}^\\top`
      case 'diag': return `\\operatorname{diag}(${rawArgs.join(', ')})`
      case 'inv': return `${a}^{-1}`
      case 'pinv': return `${a}^{\\dagger}`
      case 'eig': return `\\operatorname{eig}(${a})`
      case 'svd': return `\\operatorname{SVD}(${a})`
      case 'forall': {
        if (rawArgs.length === 0) return `\\forall`
        if (rawArgs.length === 1) return `\\forall ${a}`
        return `\\forall ${a},\\; ${b}`
      }
      case 'exists': {
        if (rawArgs.length === 0) return `\\exists`
        if (rawArgs.length === 1) return `\\exists ${a}`
        return `\\exists ${a},\\; ${b}`
      }
      case 'st': {
        if (rawArgs.length === 0) return `\\text{s.t.}`
        return `\\text{s.t.}\\; ${a}`
      }
      case 'subject': {
        if (rawArgs.length === 0) return `\\text{subject to}`
        return `\\text{subject to}\\; ${a}`
      }
      case 'intersection': if (rawArgs.length < 2) return full; return `${a} \\cap ${b}`
      case 'union': if (rawArgs.length < 2) return full; return `${a} \\cup ${b}`
      case 'log': return `\\log(${a})`
      case 'ln': return `\\ln(${a})`
      case 'exp': return `\\exp(${a})`
      case 'sigmoid': return `\\sigma(${a})`
      case 'relu': return `\\operatorname{ReLU}(${a})`
      case 'softmax': return `\\operatorname{softmax}(${a})`
      case 'text': return `\\text{${a}}`
      default: return full
    }
  }

  function isWordChar(c){ return /[A-Za-z0-9_]/.test(c) }

  function expandRec(str){
    let out=''
    let i=0
    while(i < str.length){
      let matched=null, matchEnd=-1, matchName='', matchArgsStr=''
      // --- progressive partial / deriv (partial, partial2 ... partialN) ---
      let prog = null
      let m = str.slice(i).match(/^partial(\d*)\(/)
      if (m) prog = 'partial' + m[1]
      else {
        m = str.slice(i).match(/^deriv(\d*)\(/)
        if (m) prog = 'deriv' + m[1]
      }
      if (prog) {
        const before = i>0 ? str[i-1] : ''
        if (!before || !isWordChar(before)) {
          let depth=0, end=-1
          for(let k=i+prog.length;k<str.length;k++){
            const ch=str[k]
            if(ch==='(') depth++
            else if(ch===')'){ depth--; if(depth===0){ end=k; break } }
          }
          if(end!==-1){
            matched=prog; matchEnd=end; matchArgsStr=str.slice(i+prog.length+1, end)
          }
        }
      }
      // try to match any func at i (must be boundary before)
      if (!matched) for(const name of FUNC_NAMES){
        if(str.startsWith(name, i) && str[i+name.length]==='('){
          const before = i>0 ? str[i-1] : ''
          if(before && isWordChar(before)) continue
          // find matching ')'
          let depth=0, end=-1
          for(let k=i+name.length;k<str.length;k++){
            const ch=str[k]
            if(ch==='(') depth++
            else if(ch===')'){ depth--; if(depth===0){ end=k; break } }
          }
          if(end===-1) continue
          matched=name; matchEnd=end; matchArgsStr=str.slice(i+name.length+1, end); break
        }
      }
      if(matched){
        const rawArgs = splitArgs(matchArgsStr)
        const expandedArgs = rawArgs.map(a=> expandRec(a))
        const full = matched+'('+matchArgsStr+')'
        const repl = applyHandler(matched, expandedArgs, full)
        // if handler returned full (unhandled), keep as-is but advance
        if(repl===full){
          out+=str.slice(i, matchEnd+1)
        } else {
          out+=repl
        }
        i=matchEnd+1
      } else {
        out+=str[i]; i++
      }
    }
    return out
  }

  s = expandRec(s)

  // Also support text{...} variant (only if not already \text)
  s = s.replace(/(?<!\\)text\{([\s\S]*?)\}/g, (_, t) => `\\text{${t}}`)

  // 3) simple token replacements (order matters)
  // sets: RR, NN, ZZ, QQ, CC, HH, FF, etc. -> \mathbb{X}
  s = s.replace(/\b([A-Z])\1\b/g, (_, ch) => `\\mathbb{${ch}}`)
  // also support explicit single-letter sets via \bRR etc already covered

  // operators - longest first
  s = s.replace(/<->/g, '\\leftrightarrow')
  s = s.replace(/=>/g, '\\Rightarrow')
  // keep -> for limit? limit already handled, so remaining -> -> \rightarrow
  s = s.replace(/->/g, '\\rightarrow')
  s = s.replace(/<=/g, '\\leq')
  s = s.replace(/>=/g, '\\geq')
  s = s.replace(/!=/g, '\\neq')
  s = s.replace(/~=/g, '\\approx')
  // inf word boundary
  s = s.replace(/\binf\b/g, '\\infty')

  // fix "x" as \times in sets exponent like \mathbb{R}^{m x n} or \mathbb{R}^(m x n)
  s = s.replace(/\^\{([^}]*)\}/g, (m, inner) => {
    const fixed = inner.replace(/\s*x\s*/g, ' \\times ')
    return `^{${fixed}}`
  })
  s = s.replace(/\^\(([^)]*)\)/g, (m, inner) => {
    const fixed = inner.replace(/\s*x\s*/g, ' \\times ')
    return `^{${fixed}}`
  })

  return s
}

// Also handle mat row/col that might have been inside function args? Already done at start,
// but after function expansion new mat strings could appear? Not needed.

// Helper to give markdown-ready block
export function toMarkdownMath(latex, display = true) {
  if (!latex) return ''
  return display ? `$$\n${latex}\n$$` : `$${latex}$`
}

export const SHORTCUTS = [
  // core
  { in: 'frac(a,b)', out: '\\frac{a}{b}', desc: 'Fraction' },
  { in: 'sqrt(x)', out: '\\sqrt{x}', desc: 'Sqrt' },
  { in: 'pow(x,2)', out: 'x^{2}', desc: 'Power' },
  { in: 'partial(f,x)', out: '\\frac{\\partial f}{\\partial x}', desc: 'Partial' },
  { in: 'partial2(f,x)', out: '\\frac{\\partial^2 f}{\\partial x^2}', desc: 'Second partial' },
  { in: 'partial3(f,x) .. partialN', out: '\\frac{\\partial^N f}{\\partial x^N}', desc: 'N-th partial (any N)' },
  { in: 'partial2(f,x,y) .. partialN', out: '\\frac{\\partial^N f}{\\partial x\\partial y…}', desc: 'Mixed partial any order' },
  { in: 'deriv(f,x)', out: '\\frac{df}{dx}', desc: 'Derivative' },
  { in: 'deriv2(f,x)', out: '\\frac{d^2f}{dx^2}', desc: 'Second deriv' },
  { in: 'deriv3(f,x) .. derivN', out: '\\frac{d^N f}{dx^N}', desc: 'N-th deriv (any N)' },
  { in: 'grad(f)', out: '\\nabla f', desc: 'Gradient' },
  { in: 'grad(f,x)', out: '\\nabla_x f', desc: 'Grad w.r.t' },
  { in: 'hess(f)', out: '\\nabla^2 f', desc: 'Hessian' },
  { in: 'hess(f,x)', out: '\\nabla_x^2 f', desc: 'Hessian w.r.t' },
  { in: 'jacobian(f,x)', out: 'J_x f', desc: 'Jacobian' },
  // vectors
  { in: 'vec(x)', out: '\\mathbf{x}', desc: 'Vector bold' },
  { in: 'bf(x)', out: '\\mathbf{x}', desc: 'Bold' },
  { in: 'hat(x)', out: '\\hat{x}', desc: 'Hat' },
  { in: 'tilde(x)', out: '\\tilde{x}', desc: 'Tilde' },
  { in: 'bar(x)', out: '\\bar{x}', desc: 'Bar' },
  { in: 'cal(x)', out: '\\mathcal{x}', desc: 'Cal' },
  { in: 'bb(x)', out: '\\mathbb{x}', desc: 'Blackboard' },
  { in: 'T(x) / trans(x)', out: 'x^\\top', desc: 'Transpose' },
  { in: 'inv(A)', out: 'A^{-1}', desc: 'Inverse' },
  { in: 'pinv(A)', out: 'A^{\\dagger}', desc: 'Pseudoinv' },
  { in: 'norm(x)', out: '\\|x\\|', desc: 'Norm' },
  { in: 'norm(x,2)', out: '\\|x\\|_2', desc: 'L2' },
  { in: 'norm2(x)', out: '\\|x\\|_2^2', desc: 'Sq L2' },
  { in: 'abs(x)', out: '|x|', desc: 'Abs' },
  { in: 'inner(x,y)', out: '\\langle x,y\\rangle', desc: 'Inner' },
  { in: 'outer(x,y)', out: 'x y^\\top', desc: 'Outer' },
  { in: 'dot(x,y)', out: 'x^\\top y', desc: 'Dot' },
  { in: 'cross(x,y)', out: 'x\\times y', desc: 'Cross' },
  { in: 'hadamard(A,B)', out: 'A\\odot B', desc: 'Hadamard' },
  // matrices
  { in: 'mat[1 2; 3 4]', out: '\\begin{bmatrix}…\\end{bmatrix}', desc: 'Matrix' },
  { in: 'col[x1\\nx2]', out: 'col vector', desc: 'Column' },
  { in: 'row[x1 x2]', out: 'row vector', desc: 'Row' },
  { in: 'diag(a,b)', out: '\\operatorname{diag}(…)', desc: 'Diag' },
  { in: 'det(A)', out: '\\det(A)', desc: 'Det' },
  { in: 'trace(A)', out: '\\operatorname{tr}(…)', desc: 'Trace' },
  { in: 'rank(A)', out: '\\operatorname{rank}(…)', desc: 'Rank' },
  { in: 'eig(A)', out: '\\operatorname{eig}(A)', desc: 'Eig' },
  { in: 'I(n)/eye(n)', out: 'I_n', desc: 'Identity' },
  { in: 'zero(n)/zeros(m,n)', out: '\\mathbf{0}', desc: 'Zero' },
  { in: 'ones(m,n)', out: '\\mathbf{1}', desc: 'Ones' },
  // sums/products
  { in: 'sum(i=1..n, x_i)', out: '\\sum_{i=1}^{n}x_i', desc: 'Sum' },
  { in: 'prod(i=1..n, x_i)', out: '\\prod_{i=1}^{n}x_i', desc: 'Prod' },
  // optimisation
  { in: 'min(x,f) / minimize(x,f)', out: '\\min_x f', desc: 'Min' },
  { in: 'max(x,f) / maximize(x,f)', out: '\\max_x f', desc: 'Max' },
  { in: 'argmin(x,f)', out: '\\arg\\min_x f', desc: 'Argmin' },
  { in: 'argmax(x,f)', out: '\\arg\\max_x f', desc: 'Argmax' },
  { in: 'st() / subject()', out: '\\text{s.t.}', desc: 'Subject to' },
  { in: 'forall(x)', out: '\\forall x', desc: 'For all' },
  { in: 'exists(x)', out: '\\exists x', desc: 'Exists' },
  { in: 'limit(x->a,f)', out: '\\lim_{x\\to a}f', desc: 'Limit' },
  { in: 'integral(f,x)', out: '\\int f\\,dx', desc: 'Integral' },
  { in: 'integral(a..b,f,x)', out: '\\int_a^b f\\,dx', desc: 'Definite' },
  // prob
  { in: 'E(X|Y)', out: '\\mathbb{E}[X\\mid Y]', desc: 'Expect' },
  { in: 'Var(X)', out: '\\operatorname{Var}', desc: 'Var' },
  { in: 'Cov(X,Y)', out: '\\operatorname{Cov}', desc: 'Cov' },
  // other
  { in: 'floor(x)', out: '\\lfloor x\\rfloor', desc: 'Floor' },
  { in: 'ceil(x)', out: '\\lceil x\\rceil', desc: 'Ceil' },
  { in: 'RR, NN, ZZ, QQ, CC, HH, FF', out: '\\mathbb{R},\\mathbb{N},…', desc: 'Sets (any doubled)' },
  { in: '<= >= != ~= -> => <-> inf', out: '\\leq … \\infty', desc: 'Ops' },
]
