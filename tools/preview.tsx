// Draws Claude replies the way the mod does, into an HTML page you can open
// in any browser. It uses the mod's own parser, MathJax build and drawing
// code (hooks/draw.tsx), so what you see is the tree the mod hands the app.
// It checks the mod output only. It is not how the Code tab paints it.
//
//   bun tools/preview.tsx reply.md [more.md ...] [--out page.html] [--dark]
//   bun tools/preview.tsx --session ~/.claude/projects/<dir>/<id>.jsonl [--last 5] [--grep text]
//
// Blocks are read from ~/.cache/claude-latex like the mod does, or compiled
// with the local latex and dvisvgm when missing.
import './jsx'
import type { Child, Node } from './jsx'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { marked } from 'marked'
import { drawMessage } from '../hooks/draw'
import { definePreamble, renderTex, withInk, type ColorScheme } from '../hooks/math'
import { parse } from '../hooks/parse'
import { documentForBlock, fullDocument, hashOf, themeInk, type Rendered } from '../hooks/texjobs'

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const out = flag('--out') ?? join(homedir(), '.cache/claude-latex/preview.html')
const session = flag('--session')
const last = Number(flag('--last') ?? 0)
const grep = flag('--grep')
const scheme: ColorScheme = args.includes('--dark') ? 'dark' : 'light'
const files = args.filter(a => !a.startsWith('--'))

const cacheDir = join(homedir(), '.cache/claude-latex')
const bin = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].find(d => existsSync(join(d, 'latex')))
const macrosPath = join(homedir(), '.claude/latex-macros.tex')
const macros = existsSync(macrosPath) ? readFileSync(macrosPath, 'utf8') : ''
if (macros) definePreamble(macros)

function compile(p: { lang: 'tikz' | 'tikzcd' | 'latex'; source: string }): Rendered {
  const key = hashOf('block', 'cm', p.lang, macros, p.source)
  const cached = join(cacheDir, `b-${key}.svg`)
  if (existsSync(cached)) return { svg: readFileSync(cached, 'utf8') }
  if (!bin) return { error: 'no latex found' }
  const dir = mkdtempSync(join(tmpdir(), 'latex-preview-'))
  try {
    writeFileSync(join(dir, 'd.tex'), fullDocument(documentForBlock({ key, ...p }, 'cm', macros)))
    execFileSync(join(bin, 'latex'), ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'd.tex'], { cwd: dir, stdio: 'pipe' })
    execFileSync(join(bin, 'dvisvgm'), ['--no-fonts', '--exact-bbox', '--zoom=1.3', '-o', 'd.svg', 'd.dvi'], { cwd: dir, stdio: 'pipe' })
    const svg = themeInk(readFileSync(join(dir, 'd.svg'), 'utf8'))
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cached, svg)
    return { svg }
  } catch (error) {
    const log = existsSync(join(dir, 'd.log')) ? readFileSync(join(dir, 'd.log'), 'utf8') : String(error)
    const at = log.split('\n').findIndex(l => l.startsWith('!'))
    return { error: at >= 0 ? log.split('\n').slice(at, at + 3).join('\n') : 'compile failed' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// The mod's tree for one message, or null when the mod would leave it to the app.
function treeFor(text: string): Node | null {
  const pieces = parse(text, { blocks: Boolean(bin) })
  if (!pieces.some(p => p.kind !== 'md')) return null
  return drawMessage(pieces, {
    el: { Box: 'Box', Text: 'Text', Markdown: 'Markdown', Svg: 'Svg', Button: 'Button', Link: 'Link' } as never,
    formula: (tex, display) => {
      const svg = renderTex(tex, display)
      return svg ? withInk(svg, scheme) : null
    },
    block: p => {
      const r = compile(p)
      return 'svg' in r ? { svg: withInk(r.svg, scheme) } : r
    },
    onCopy: () => undefined,
  }) as unknown as Node
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Box margins and gaps are in rows on the terminal. Treat a row as 0.5em here.
const unit = (n: unknown) => `${Number(n) * 0.5}em`

// Bun may build React-style elements (children inside props) instead of
// calling h. Accept both shapes.
function kidsOf(node: Node): Child[] {
  const raw = (node.children ?? (node.props as { children?: unknown }).children ?? []) as unknown
  const list = Array.isArray(raw) ? raw.flat(Infinity) : [raw]
  return list.filter(c => c !== null && c !== undefined && c !== false && c !== true) as Child[]
}

function html(node: Child): string {
  if (typeof node === 'string' || typeof node === 'number') return esc(String(node))
  const p = node.props
  const kids = kidsOf(node).map(html).join('')
  switch (node.type) {
    case 'Box': {
      const style = [
        'display:flex',
        `flex-direction:${p.flexDirection ?? 'row'}`,
        p.flexWrap ? `flex-wrap:${p.flexWrap}` : '',
        p.alignItems ? `align-items:${p.alignItems}` : '',
        p.marginTop ? `margin-top:${unit(p.marginTop)}` : '',
        p.marginBottom ? `margin-bottom:${unit(p.marginBottom)}` : '',
        p.justifyContent ? `justify-content:${p.justifyContent}` : '',
        p.width ? `width:${p.width};box-sizing:border-box` : '',
        p.paddingX ? `padding:0 ${unit(p.paddingX)}` : '',
        p.backgroundColor ? `background:${p.backgroundColor}` : '',
      ].filter(Boolean).join(';')
      return `<div class="box" style="${style}">${kids}</div>`
    }
    case 'Text': {
      const style = [
        p.bold ? 'font-weight:600' : '',
        p.italic ? 'font-style:italic' : '',
        p.color ? `color:${p.color}` : '',
        p.dimColor ? 'opacity:.55' : '',
        p.strikethrough ? 'text-decoration:line-through' : '',
        p.backgroundColor ? `background:${p.backgroundColor};border-radius:3px;font-family:ui-monospace,monospace;font-size:.9em` : '',
      ].filter(Boolean).join(';')
      return `<span class="text" style="${style}">${kids}</span>`
    }
    case 'Markdown':
      return `<div class="md">${marked.parse(String(p.text ?? ''))}</div>`
    case 'Svg':
      return `<img class="svg" alt="${esc(String(p.alt ?? ''))}" src="data:image/svg+xml;base64,${Buffer.from(String(p.source)).toString('base64')}">`
    case 'Link':
      return `<a href="${esc(String(p.href))}">${esc(String(p.label ?? p.href))}</a>`
    case 'Button':
      return `<button class="btn">${esc(String(p.label ?? ''))}</button>`
    default:
      return kids
  }
}

type Message = { title: string; text: string }
const messages: Message[] = []
for (const f of files) messages.push({ title: f, text: readFileSync(f, 'utf8') })
if (session) {
  const found: Message[] = []
  for (const line of readFileSync(session, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let row: { type?: string; message?: { content?: unknown } }
    try { row = JSON.parse(line) } catch { continue }
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content as { type: string; text?: string }[]) {
      if (block.type === 'text' && block.text) found.push({ title: `reply ${found.length + 1}`, text: block.text })
    }
  }
  const picked = found.filter(m => !grep || m.text.includes(grep))
  messages.push(...(last > 0 ? picked.slice(-last) : picked))
}

const cards = messages.map(m => {
  const tree = treeFor(m.text)
  const body = tree ? html(tree) : `<div class="md">${marked.parse(m.text)}</div>`
  return `<section><h6>${esc(m.title)}${tree ? '' : ' (left to the app)'}</h6>${body}</section>`
})

const dark = scheme === 'dark'
writeFileSync(out, `<!doctype html><meta charset="utf-8"><title>LaTeX mod preview</title>
<style>
body{margin:0;padding:24px 16px;background:${dark ? '#262624' : '#faf9f5'};color:${dark ? '#ece9e3' : '#1f1e1d'};font:15px/1.6 -apple-system,system-ui,sans-serif}
section{max-width:760px;margin:0 auto 28px;padding:16px 20px;border-radius:12px;background:${dark ? '#30302e' : '#fff'};box-shadow:0 1px 3px #0001}
h6{margin:0 0 8px;font-size:11px;opacity:.5;font-weight:500}
.md>:first-child{margin-top:0}.md>:last-child{margin-bottom:0}
.md code{font:13px ui-monospace,monospace;background:#8882;padding:1px 4px;border-radius:4px}
.md pre{background:#8881;padding:10px;border-radius:8px;overflow:auto}
.box .text{white-space:pre}
.svg{max-width:100%}
.btn{border:0;background:none;color:inherit;opacity:.5;font:12px system-ui;cursor:pointer}
table{border-collapse:collapse}td,th{border:1px solid #8884;padding:4px 8px}
</style>${cards.join('\n')}`)
console.log(`${messages.length} messages, ${cards.length} drawn -> ${out}`)
