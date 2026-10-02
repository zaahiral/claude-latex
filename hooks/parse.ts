// Splits a markdown message into pieces the renderer draws differently.
// Pure functions, no engine calls, so they are easy to test.

export type Span =
  | { kind: 'text'; text: string; bold: boolean; italic: boolean; code: boolean }
  | { kind: 'math'; tex: string }
export type Line = { prefix: string; heading: boolean; spans: Span[] }
export type Piece =
  | { kind: 'md'; text: string }
  | { kind: 'display'; tex: string }
  | { kind: 'inline'; lines: Line[] }
  | { kind: 'block'; lang: 'tikz' | 'tikzcd' | 'latex'; source: string }

export const NBSP = ' '

const DISPLAY_RE =
  /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\begin\{(equation|align|gather|multline|alignat|eqnarray)(\*?)\}[\s\S]+?\\end\{\3\4\}/g
// Code spans, \(...\), and $...$ that does not look like money: no space just
// inside either dollar, and no digit straight after the closing one.
const INLINE_RE =
  /(`+)([\s\S]+?)\1|\\\(([\s\S]+?)\\\)|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\d$])/g
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w-]*)/

export function looksLikeMath(text: string): boolean {
  return /\$|\\\(|\\\[|\\begin\{|```\s*(tikz|latex)/.test(text)
}

function hasInlineMath(text: string): boolean {
  for (const m of text.matchAll(INLINE_RE)) if (m[1] === undefined) return true
  return false
}

// Blocks are separated by blank lines. A code fence is always a block of its
// own. A blank line inside an open $$ or \[ does not end the block.
export function splitBlocks(text: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let fence: string | null = null
  const push = () => {
    if (current.length) blocks.push(current.join('\n'))
    current = []
  }
  for (const line of text.split('\n')) {
    const marker = line.match(FENCE_RE)
    if (fence === null && marker) {
      push()
      fence = marker[1] ?? '```'
      current.push(line)
      continue
    }
    if (fence !== null) {
      current.push(line)
      if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, '') === '') {
        fence = null
        push()
      }
      continue
    }
    if (line.trim() === '') {
      const joined = current.join('\n')
      const openDollars = (joined.match(/\$\$/g) ?? []).length % 2 === 1
      const openBracket = (joined.match(/\\\[/g) ?? []).length > (joined.match(/\\\]/g) ?? []).length
      if (!openDollars && !openBracket) {
        push()
        continue
      }
    }
    current.push(line)
  }
  push()
  return blocks
}

export function parseLine(raw: string): Line {
  let text = raw
  let prefix = ''
  let heading = false
  const h = text.match(/^\s*#{1,6}\s+/)
  const bullet = text.match(/^(\s*)([-*+])\s+/)
  const number = text.match(/^(\s*)(\d+[.)])\s+/)
  const quote = text.match(/^\s*>\s?/)
  if (h) {
    heading = true
    text = text.slice(h[0].length)
  } else if (bullet) {
    prefix = (bullet[1] ?? '').replace(/ /g, NBSP) + '•' + NBSP
    text = text.slice(bullet[0].length)
  } else if (number) {
    prefix = (number[1] ?? '').replace(/ /g, NBSP) + (number[2] ?? '') + NBSP
    text = text.slice(number[0].length)
  } else if (quote) {
    prefix = '│' + NBSP
    text = text.slice(quote[0].length)
  }

  const spans: Span[] = []
  let bold = heading
  let italic = false
  const pushText = (chunk: string) => {
    for (const part of chunk.split(/(\*\*|\*)/)) {
      if (part === '**') bold = heading || !bold
      else if (part === '*') italic = !italic
      else if (part) spans.push({ kind: 'text', text: part, bold, italic, code: false })
    }
  }
  let last = 0
  for (const m of text.matchAll(INLINE_RE)) {
    pushText(text.slice(last, m.index))
    if (m[1] !== undefined) spans.push({ kind: 'text', text: m[2] ?? '', bold, italic, code: true })
    else spans.push({ kind: 'math', tex: (m[3] ?? m[4] ?? '').trim() })
    last = m.index! + m[0].length
  }
  pushText(text.slice(last))
  return { prefix, heading, spans }
}

export function parse(text: string, options: { blocks: boolean }): Piece[] {
  const pieces: Piece[] = []
  let md: string[] = []
  const flush = () => {
    if (md.length) pieces.push({ kind: 'md', text: md.join('\n\n') })
    md = []
  }
  const addText = (chunk: string) => {
    const t = chunk.trim()
    if (!t) return
    // A table keeps the app's own Markdown: laying it out word by word
    // would lose the columns.
    const isTable = t.split('\n').every(l => l.trim().startsWith('|'))
    if (!isTable && hasInlineMath(t)) {
      flush()
      pieces.push({ kind: 'inline', lines: t.split('\n').map(parseLine) })
    } else {
      md.push(t)
    }
  }
  for (const block of splitBlocks(text)) {
    const fence = block.match(FENCE_RE)
    if (fence) {
      const lang = (fence[2] ?? '').toLowerCase()
      const closed = /\n\s*(```+|~~~+)\s*$/.test(block)
      if (options.blocks && closed && (lang === 'tikz' || lang === 'tikzcd' || lang === 'latex')) {
        flush()
        const body = block.split('\n').slice(1, -1).join('\n')
        pieces.push({ kind: 'block', lang, source: body })
      } else {
        md.push(block)
      }
      continue
    }
    let last = 0
    for (const m of block.matchAll(DISPLAY_RE)) {
      addText(block.slice(last, m.index))
      flush()
      const tex = m[1] ?? m[2] ?? m[0]
      pieces.push({ kind: 'display', tex: tex.trim() })
      last = m.index! + m[0].length
    }
    addText(block.slice(last))
  }
  flush()
  return pieces
}

// Markdown joins single line breaks into one line. A message someone typed
// keeps its line breaks: each single newline outside a code fence becomes a
// hard break.
export function keepLineBreaks(text: string): string {
  let fence: string | null = null
  return text
    .split('\n')
    .map((line, i, lines) => {
      const marker = line.match(FENCE_RE)
      if (marker) {
        if (fence === null) fence = marker[1] ?? '```'
        else if (line.trim().startsWith(fence)) fence = null
        return line
      }
      const next = lines[i + 1]
      const isBreak = fence === null && next !== undefined && line.trim() !== '' && next.trim() !== ''
      return isBreak ? `${line}  ` : line
    })
    .join('\n')
}
