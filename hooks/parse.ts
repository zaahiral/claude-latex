// Splits a markdown message into pieces the renderer draws differently.
// Pure functions, no engine calls, so they are easy to test.

export type TextSpan = {
  kind: 'text'
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  strike?: boolean
  // An https link the text points at.
  href?: string
}
export type Span = TextSpan | { kind: 'math'; tex: string }
export type Line = { prefix: string; heading: boolean; spans: Span[]; quote?: boolean }
export type Align = 'left' | 'center' | 'right'
export type Piece =
  | { kind: 'md'; text: string }
  // `source` is the formula as real LaTeX would take it, delimiters included.
  // `raw` on every piece but md is its text as written, for the app's own
  // Markdown to draw when the mod hands the piece back.
  | { kind: 'display'; tex: string; source: string; raw: string }
  | { kind: 'inline'; lines: Line[]; raw: string }
  // A table with math in it. Each cell is a row of spans.
  | { kind: 'table'; header: Span[][]; rows: Span[][][]; align: Align[]; raw: string }
  | { kind: 'block'; lang: 'tikz' | 'tikzcd' | 'latex'; source: string; raw: string }

export const NBSP = '\u00a0'

const FENCE_RE = /^\s*(```+|~~~+)\s*([\w-]*)/
// Environments that are display math without any dollars around them.
const DISPLAY_ENVS = new Set(['equation', 'align', 'gather', 'multline', 'alignat', 'flalign', 'eqnarray'])
// A display formula longer than this is two stray $$ far apart, not math.
const MAX_DISPLAY_CHARS = 8000

export function looksLikeMath(text: string): boolean {
  return /\$|\\\(|\\\[|\\begin\{|```\s*(tikz|latex)/.test(text)
}

// Whether a typed message has Markdown worth rendering: a heading, list,
// quote, fence or table at a line start, or emphasis, code or a link.
export function looksLikeMarkdown(text: string): boolean {
  return (
    /(^|\n) {0,3}(#{1,6} |[-*+] |\d+[.)] |> ?\S|```|~~~|\|.+\|)/.test(text) ||
    /\*\*[^*\s][^*\n]*\*\*|(?<![\w*])\*[^*\s][^*\n]*\*(?![\w*])|(?<![\w_])_[^_\s][^_\n]*_(?![\w_])|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)/.test(text)
  )
}

// What one stretch of text is made of, in order. `raw` is the source of a
// piece, delimiters included.
export type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string; raw: string }
  | { kind: 'inline'; tex: string; raw: string }
  | { kind: 'display'; tex: string; raw: string }

// The closing $ of an inline formula that opens just before `start`, or -1.
// The rules keep money as money: no space just inside either dollar, no
// digit straight after the closing one, and no line break inside. A $ inside
// braces belongs to the formula, as in \text{if $x>0$}.
function closeInline(text: string, start: number): number {
  const first = text[start]
  if (first === undefined || first === '$' || /\s/.test(first)) return -1
  const closes = (j: number) => !/\s/.test(text[j - 1] ?? ' ') && !/\d/.test(text[j + 1] ?? '')
  let depth = 0
  // With braces that never balance, as in $\frac{a$, the first $ closes.
  let inBraces = -1
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (c === '\n') break
    if (c === '\\') j += 1
    else if (c === '{') depth += 1
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '$') {
      if (depth === 0) return closes(j) ? j : -1
      if (inBraces < 0 && closes(j)) inBraces = j
    }
  }
  return inBraces
}

// The closing $$ of a display formula whose body starts at `start`, or -1.
function closeDisplay(text: string, start: number): number {
  let depth = 0
  let inBraces = -1
  const end = Math.min(text.length - 1, start + MAX_DISPLAY_CHARS)
  for (let j = start; j < end; j++) {
    const c = text[j]
    if (c === '\\') j += 1
    else if (c === '{') depth += 1
    else if (c === '}') depth = Math.max(0, depth - 1)
    else if (c === '$' && text[j + 1] === '$') {
      if (depth === 0) return j
      if (inBraces < 0) inBraces = j
      j += 1
    }
  }
  return inBraces
}

// The closing run of a code span opened by `ticks` backticks, or -1. A code
// span does not cross a blank line.
function closeCode(text: string, start: number, ticks: number): number {
  const blank = text.slice(start).search(/\n[ \t]*\n/)
  const limit = blank < 0 ? text.length : start + blank
  let j = start
  while (j < limit) {
    const k = text.indexOf('`', j)
    if (k < 0 || k >= limit) return -1
    let run = 1
    while (text[k + run] === '`') run += 1
    if (run === ticks) return k
    j = k + run
  }
  return -1
}

// Reads text left to right and marks its code spans and formulas. Reading in
// order is what keeps `$a$$b$` two inline formulas, and a $$ inside a code
// span code.
export function scan(text: string): Segment[] {
  const out: Segment[] = []
  let textStart = 0
  let i = 0
  const emit = (segment: Segment, end: number) => {
    if (i > textStart) out.push({ kind: 'text', text: text.slice(textStart, i) })
    out.push(segment)
    i = end
    textStart = end
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      const next = text[i + 1]
      if (next === '(') {
        const close = text.indexOf('\\)', i + 2)
        if (close > i + 2) {
          emit({ kind: 'inline', tex: text.slice(i + 2, close).trim(), raw: text.slice(i, close + 2) }, close + 2)
          continue
        }
      }
      if (next === '[') {
        const close = text.indexOf('\\]', i + 2)
        if (close > i + 2 && close - i < MAX_DISPLAY_CHARS && text.slice(i + 2, close).trim()) {
          emit({ kind: 'display', tex: text.slice(i + 2, close).trim(), raw: text.slice(i, close + 2) }, close + 2)
          continue
        }
      }
      if (next === 'b') {
        const m = /^\\begin\{([a-z]+)(\*?)\}/.exec(text.slice(i, i + 24))
        if (m && DISPLAY_ENVS.has(m[1] ?? '')) {
          const endTag = `\\end{${m[1]}${m[2]}}`
          const close = text.indexOf(endTag, i)
          if (close > 0 && close - i < MAX_DISPLAY_CHARS) {
            const raw = text.slice(i, close + endTag.length)
            emit({ kind: 'display', tex: raw, raw }, close + endTag.length)
            continue
          }
        }
      }
      // Any other backslash escapes the next character: \$ is a dollar sign.
      i += 2
      continue
    }
    if (c === '`') {
      let ticks = 1
      while (text[i + ticks] === '`') ticks += 1
      const close = closeCode(text, i + ticks, ticks)
      if (close >= 0) {
        emit({ kind: 'code', text: text.slice(i + ticks, close), raw: text.slice(i, close + ticks) }, close + ticks)
        continue
      }
      i += ticks
      continue
    }
    if (c === '$') {
      if (text[i + 1] === '$') {
        const close = closeDisplay(text, i + 2)
        if (close >= 0 && text.slice(i + 2, close).trim()) {
          emit({ kind: 'display', tex: text.slice(i + 2, close).trim(), raw: text.slice(i, close + 2) }, close + 2)
          continue
        }
        // An empty $$ $$ is left as typed, both pairs, so its closing pair
        // does not open a formula with the next $$ in the message.
        i = close >= 0 ? close + 2 : i + 2
        continue
      }
      const close = closeInline(text, i + 1)
      if (close >= 0) {
        emit({ kind: 'inline', tex: text.slice(i + 1, close).trim(), raw: text.slice(i, close + 1) }, close + 1)
        continue
      }
    }
    i += 1
  }
  if (text.length > textStart) out.push({ kind: 'text', text: text.slice(textStart) })
  return out
}

function hasInlineMath(text: string): boolean {
  return scan(text).some(s => s.kind === 'inline' || s.kind === 'display')
}

// A text or code fence region of a message, in order.
type Region = { fence: false; text: string } | { fence: true; text: string; lang: string; closed: boolean }

function splitFences(text: string): Region[] {
  const regions: Region[] = []
  let current: string[] = []
  let fence: { marker: string; lang: string } | null = null
  const pushText = () => {
    if (current.length) regions.push({ fence: false, text: current.join('\n') })
    current = []
  }
  for (const line of text.split('\n')) {
    const marker = line.match(FENCE_RE)
    if (fence === null && marker) {
      pushText()
      fence = { marker: marker[1] ?? '```', lang: (marker[2] ?? '').toLowerCase() }
      current.push(line)
      continue
    }
    current.push(line)
    if (fence !== null && line.trim().startsWith(fence.marker) && line.trim().replace(/[`~]/g, '') === '') {
      regions.push({ fence: true, text: current.join('\n'), lang: fence.lang, closed: true })
      current = []
      fence = null
    }
  }
  if (fence !== null) regions.push({ fence: true, text: current.join('\n'), lang: fence.lang, closed: false })
  else pushText()
  return regions
}

// The paragraphs of a message, as its text reads: code fences each a
// paragraph of their own, the rest split at blank lines.
export function splitBlocks(text: string): string[] {
  return splitFences(text).flatMap(region => (region.fence ? [region.text] : paragraphs(region.text)))
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n/)
    .map(p => p.replace(/^\n+|\s+$/g, ''))
    .filter(p => p.trim() !== '')
}

// One piece of a line before its emphasis is worked out: a run of plain
// text, an emphasis marker, or a finished span.
type Token =
  | { kind: 'text'; text: string }
  | { kind: 'mark'; mark: string; canOpen: boolean; canClose: boolean }
  | { kind: 'span'; span: Span }
  | { kind: 'link'; text: string; href: string }

const INLINE_MD = /\\([!-/:-@[-`{-~])|\[((?:[^\]\\\n]|\\.)+)\]\((https?:\/\/[^\s)]+)\)|(\*{1,3}|~~|_{1,2})/g

function tokensOf(segments: Segment[]): Token[] {
  const tokens: Token[] = []
  segments.forEach((segment, at) => {
    if (segment.kind === 'code') {
      tokens.push({ kind: 'span', span: { kind: 'text', text: segment.text, bold: false, italic: false, code: true } })
      return
    }
    if (segment.kind !== 'text') {
      tokens.push({ kind: 'span', span: { kind: 'math', tex: segment.tex } })
      return
    }
    const chunk = segment.text
    // A formula or code span next to the text counts as a letter beside it.
    const before = at > 0 ? 'x' : ' '
    const after = at < segments.length - 1 ? 'x' : ' '
    let last = 0
    let plain = ''
    const flush = () => {
      if (plain) tokens.push({ kind: 'text', text: plain })
      plain = ''
    }
    for (const m of chunk.matchAll(INLINE_MD)) {
      plain += chunk.slice(last, m.index)
      last = m.index! + m[0].length
      if (m[1] !== undefined) {
        plain += m[1]
      } else if (m[2] !== undefined) {
        flush()
        tokens.push({ kind: 'link', text: m[2].replace(/\\(.)/g, '$1').replace(/[*`]/g, ''), href: m[3] ?? '' })
      } else {
        const mark = m[4] ?? ''
        const prev = m.index! > 0 ? chunk[m.index! - 1]! : before
        const next = last < chunk.length ? chunk[last]! : after
        const isWord = (ch: string) => /[\p{L}\p{N}]/u.test(ch)
        let canOpen = !/\s/.test(next)
        let canClose = !/\s/.test(prev)
        // An underscore inside a word is part of the word: snake_case.
        if (mark[0] === '_' && isWord(prev) && isWord(next)) canOpen = canClose = false
        if (!canOpen && !canClose) plain += mark
        else {
          flush()
          tokens.push({ kind: 'mark', mark, canOpen, canClose })
        }
      }
    }
    plain += chunk.slice(last)
    flush()
  })
  return tokens
}

// Turns the tokens of one line into styled spans. A marker opens only when
// the same marker closes later in the line, so a lone * stays a star.
function spansOf(segments: Segment[], heading = false): Span[] {
  const tokens = tokensOf(segments)
  const spans: Span[] = []
  const on = { bold: false, italic: false, strike: false }
  const style = (mark: string): (keyof typeof on)[] =>
    mark === '~~' ? ['strike'] : mark.length === 3 ? ['bold', 'italic'] : mark.length === 2 ? ['bold'] : ['italic']
  const open = new Map<string, boolean>()
  const text = (value: string, href?: string) => {
    if (!value) return
    const span: TextSpan = { kind: 'text', text: value, bold: heading || on.bold, italic: on.italic, code: false }
    if (on.strike) span.strike = true
    if (href) span.href = href
    spans.push(span)
  }
  tokens.forEach((token, at) => {
    if (token.kind === 'text') text(token.text)
    else if (token.kind === 'link') text(token.text, token.href)
    else if (token.kind === 'span') {
      const span = token.span
      spans.push(span.kind === 'text' ? { ...span, bold: heading || on.bold, italic: on.italic } : span)
    } else {
      const isOpen = open.get(token.mark) === true
      const closesLater = tokens.slice(at + 1).some(t => t.kind === 'mark' && t.mark === token.mark && t.canClose)
      if (isOpen && token.canClose) {
        open.set(token.mark, false)
        for (const key of style(token.mark)) on[key] = false
      } else if (!isOpen && token.canOpen && closesLater) {
        open.set(token.mark, true)
        for (const key of style(token.mark)) on[key] = true
      } else {
        text(token.mark)
      }
    }
  })
  return spans
}

// A list item is indented as the app's own lists are: each level of nesting
// steps in, with a different bullet.
const BULLETS = ['•', '◦', '▪']
const listLevel = (indent: string) => Math.floor(indent.replace(/\t/g, '  ').length / 2)
const listIndent = (level: number) => NBSP.repeat(2 + 4 * level)

export function parseLine(raw: string): Line {
  let text = raw
  let prefix = ''
  let heading = false
  const h = text.match(/^\s*#{1,6}\s+/)
  const bullet = text.match(/^(\s*)([-*+])\s+/)
  const number = text.match(/^(\s*)(\d+[.)])\s+/)
  const quote = text.match(/^\s*>\s?/)
  const indent = text.match(/^(\s+)\S/)
  if (h) {
    heading = true
    text = text.slice(h[0].length)
  } else if (bullet) {
    const level = listLevel(bullet[1] ?? '')
    prefix = listIndent(level) + (BULLETS[Math.min(level, BULLETS.length - 1)] ?? '•') + NBSP
    text = text.slice(bullet[0].length)
  } else if (number) {
    prefix = listIndent(listLevel(number[1] ?? '')) + (number[2] ?? '') + NBSP
    text = text.slice(number[0].length)
  } else if (quote) {
    prefix = '▍' + NBSP
    text = text.slice(quote[0].length)
  } else if (indent) {
    // A continuation line under a list item sits under the item's text.
    prefix = listIndent(listLevel(indent[1] ?? '')) + NBSP.repeat(2)
    text = text.slice((indent[1] ?? '').length)
  }
  const line: Line = { prefix, heading, spans: spansOf(scan(text), heading) }
  if (quote && !h && !bullet && !number) line.quote = true
  return line
}

const TABLE_RULE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

// The cells of one table row: split at each | outside code and math.
function cellsOf(line: string): Segment[][] {
  const cells: Segment[][] = [[]]
  for (const segment of scan(line.trim())) {
    if (segment.kind !== 'text') {
      cells[cells.length - 1]!.push(segment)
      continue
    }
    const parts = segment.text.split(/(?<!\\)\|/)
    parts.forEach((part, i) => {
      if (i > 0) cells.push([])
      if (part) cells[cells.length - 1]!.push({ kind: 'text', text: part.replace(/\\\|/g, '|') })
    })
  }
  // The row starts and ends with a |, which leaves an empty cell at each end.
  const isEmpty = (cell: Segment[]) => cell.every(s => s.kind === 'text' && s.text.trim() === '')
  if (cells.length && isEmpty(cells[0]!)) cells.shift()
  if (cells.length && isEmpty(cells[cells.length - 1]!)) cells.pop()
  return cells
}

function trimCell(spans: Span[]): Span[] {
  const out = spans.map(s => ({ ...s }))
  const first = out[0]
  const last = out[out.length - 1]
  if (first?.kind === 'text' && !first.code) first.text = first.text.trimStart()
  if (last?.kind === 'text' && !last.code) last.text = last.text.trimEnd()
  return out.filter(s => s.kind !== 'text' || s.text !== '')
}

// Whether a paragraph is nothing but list items and their continuation
// lines, and whether its numbers reach 10.
function listShape(lines: string[]): { isList: boolean; reachesTen: boolean } {
  let reachesTen = false
  let items = 0
  for (const line of lines) {
    const number = line.match(/^\s*(\d+)[.)]\s+/)
    if (number) reachesTen ||= Number(number[1]) >= 10
    if (number || /^\s*[-*+]\s+/.test(line)) items += 1
    else if (!/^\s+\S/.test(line)) return { isList: false, reachesTen: false }
  }
  return { isList: items > 0, reachesTen }
}

function parseTable(lines: string[], raw: string): Extract<Piece, { kind: 'table' }> | null {
  const [head, rule, ...body] = lines
  if (head === undefined || rule === undefined || !TABLE_RULE.test(rule.trim())) return null
  const row = (line: string, bold: boolean) => cellsOf(line).map(cell => trimCell(spansOf(cell, bold)))
  const align = rule
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell): Align => {
      const c = cell.trim()
      return c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left'
    })
  return { kind: 'table', header: row(head, true), rows: body.map(line => row(line, false)), align, raw }
}

// A display formula as a LaTeX document takes it.
function displaySource(tex: string, raw: string): string {
  if (raw.startsWith('\\begin{')) return raw
  const env = /^\\begin\{([a-z]+)\*?\}/.exec(tex)
  if (env && DISPLAY_ENVS.has(env[1] ?? '')) return tex
  return `\\[\n${tex}\n\\]`
}

export function parse(text: string, options: { blocks: boolean }): Piece[] {
  const pieces: Piece[] = []
  // Whether the mod lays out lists in the region being read: see addParagraph.
  let ownsLists = false
  let md: string[] = []
  const flush = () => {
    if (md.length) pieces.push({ kind: 'md', text: md.join('\n\n') })
    md = []
  }
  const addParagraph = (paragraph: string) => {
    const lines = paragraph.split('\n')
    if (!hasInlineMath(paragraph)) {
      // A list item without math is still laid out by the mod when the
      // items around it are, so one list looks like one list. So is a list
      // that reaches 10: the app's Markdown cuts off the left edge of a
      // two-digit number.
      const shape = listShape(lines)
      if (shape.isList && (ownsLists || shape.reachesTen)) {
        flush()
        pieces.push({ kind: 'inline', lines: lines.map(parseLine), raw: paragraph })
      } else {
        md.push(paragraph)
      }
      return
    }
    if (lines.every(l => l.trim().startsWith('|'))) {
      // A table with math is laid out by the mod. One the mod cannot read
      // keeps the app's own Markdown.
      const table = parseTable(lines, paragraph)
      if (table) {
        flush()
        pieces.push(table)
      } else {
        md.push(paragraph)
      }
      return
    }
    flush()
    pieces.push({ kind: 'inline', lines: lines.map(parseLine), raw: paragraph })
  }
  for (const region of splitFences(text)) {
    if (region.fence) {
      const { lang } = region
      if (options.blocks && region.closed && (lang === 'tikz' || lang === 'tikzcd' || lang === 'latex')) {
        flush()
        // Blank lines at either end of a block are dropped: a pasted block
        // often ends with one, and inside tikzcd a blank line is an error.
        const source = region.text.split('\n').slice(1, -1).join('\n').replace(/^(\s*\n)+|(\n\s*)+$/g, '')
        pieces.push({ kind: 'block', lang, source, raw: region.text })
      } else {
        md.push(region.text)
      }
      continue
    }
    // Display formulas come out first, wherever they sit. The text between
    // them is split into paragraphs.
    const segments = scan(region.text)
    // A list with math anywhere in it, or cut in two by a display formula.
    ownsLists = segments.some(s => s.kind === 'inline' || s.kind === 'display') && /(^|\n)\s*([-*+]|\d+[.)])\s/.test(region.text)
    let run = ''
    const flushRun = () => {
      for (const paragraph of paragraphs(run)) addParagraph(paragraph)
      run = ''
    }
    for (const segment of segments) {
      if (segment.kind === 'display') {
        flushRun()
        flush()
        pieces.push({ kind: 'display', tex: segment.tex, source: displaySource(segment.tex, segment.raw), raw: segment.raw })
      } else {
        run += segment.kind === 'text' ? segment.text : segment.raw
      }
    }
    flushRun()
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

// The math of a message without its prose: display formulas and LaTeX
// blocks as they are, and every inline formula gathered into one row.
// Drawn under your own message, whose text the app's bubble already shows.
export function mathOnly(pieces: Piece[]): Piece[] {
  const out: Piece[] = []
  const inline: Span[] = []
  const gather = (spans: Span[]) => {
    for (const span of spans) {
      if (span.kind !== 'math') continue
      if (inline.length) inline.push({ kind: 'text', text: `${NBSP}${NBSP}${NBSP}`, bold: false, italic: false, code: false })
      inline.push(span)
    }
  }
  for (const p of pieces) {
    if (p.kind === 'display' || p.kind === 'block') out.push(p)
    if (p.kind === 'inline') for (const line of p.lines) gather(line.spans)
    if (p.kind === 'table') for (const row of [p.header, ...p.rows]) for (const cell of row) gather(cell)
  }
  if (inline.length) out.unshift({ kind: 'inline', lines: [{ prefix: '', heading: false, spans: inline }], raw: '' })
  return out
}
