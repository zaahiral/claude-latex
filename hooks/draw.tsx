/** @jsx h */
import type { Elements, RenderChildren, RenderElement, UiPressArgument } from 'claude-code'
import { NBSP, type Line, type Piece, type Span, type TextSpan } from './parse'
import type { Rendered } from './texjobs'

// Builds the drawing of one message from its pieces. No engine calls: the
// hook hands in the surface's elements and how to get each formula and
// block, so tools/preview.tsx can draw exactly the same tree outside the app.

type DrawElements = Pick<Elements['desktop'], 'Box' | 'Text' | 'Markdown' | 'Svg' | 'Button' | 'Link'>
type DisplayPiece = Extract<Piece, { kind: 'display' }>
type TablePiece = Extract<Piece, { kind: 'table' }>

export type DrawContext = {
  el: DrawElements
  // An SVG source ready to draw, or null when the formula does not render.
  formula: (tex: string, display: boolean) => string | null
  // A compiled block, or undefined while it is compiling.
  block: (piece: Extract<Piece, { kind: 'block' }>) => Rendered | undefined
  // A display formula MathJax could not draw, typeset by the local LaTeX:
  // the result, undefined while it compiles, or null where there is no TeX.
  fallback?: (piece: DisplayPiece) => Rendered | undefined | null
  // The most characters the whole drawing may come to. The desktop app
  // drops a larger drawing without a word and keeps showing whatever it drew
  // last. The first piece that would pass this, and every piece after it,
  // is handed to the app's own Markdown.
  maxChars?: number
  // Told what the drawing came to, for the debug log.
  onDrawn?: (drawn: { chars: number; handedBackAt: number | null }) => void
  // Whether to draw a Copy TeX button under display math and blocks.
  showCopy: boolean
  // What pressing Copy TeX does with `text`.
  onCopy: (text: string, press: UiPressArgument) => void
}

// Light grays that read on a light and on a dark theme.
const CODE_BACKGROUND = '#80808029'
const TABLE_HEAD = '#80808026'
const TABLE_STRIPE = '#8080800d'
// The most source a failed formula shows.
const MAX_SOURCE_CHARS = 600

// A Link takes an https URL in its canonical spelling and nothing else. One
// it would refuse takes the whole message's drawing with it, so anything
// else is drawn as text.
export function safeHref(raw: string): string | null {
  try {
    if (typeof URL !== 'function') return null
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    if (url.href.length > 2048 || /[^\x21-\x7e]/.test(url.href) || url.href.includes('@')) return null
    return url.href
  } catch {
    return null
  }
}

// How wide a formula's source suggests it draws, in characters.
function mathWidth(tex: string): number {
  return Math.min(30, tex.replace(/\\[a-zA-Z]+/g, 'x').replace(/[{}^_\s]/g, '').length)
}

// Each column's share of the row's width, as whole percentages. A column is
// about as wide as its widest cell, so a small table stays small, and a
// table too wide for the row is scaled down to fit it.
function columnWidths(table: TablePiece, columns: number): number[] {
  const wanted = Array.from({ length: columns }, (_, c) => {
    let widest = 0
    for (const row of [table.header, ...table.rows]) {
      let width = 0
      for (const span of row[c] ?? []) width += span.kind === 'math' ? mathWidth(span.tex) : span.text.length
      widest = Math.max(widest, width)
    }
    return Math.min(60, Math.max(4, widest)) * 1.3 + 5
  })
  const total = wanted.reduce((a, b) => a + b, 0)
  const scale = total > 100 ? 100 / total : 1
  return wanted.map(w => Math.max(1, Math.floor(w * scale)))
}

export function drawMessage(pieces: Piece[], ctx: DrawContext): RenderElement {
  const { Box, Text, Markdown, Svg, Button, Link } = ctx.el

  const source = (tex: string, display: boolean) => {
    const text = display ? `$$${tex}$$` : `$${tex}$`
    return <Text color="red">{text.length > MAX_SOURCE_CHARS ? `${text.slice(0, MAX_SOURCE_CHARS)}…` : text}</Text>
  }

  const formula = (tex: string) => {
    const svg = ctx.formula(tex, false)
    return svg ? <Svg source={svg} alt={tex} /> : source(tex, false)
  }

  const textElement = (text: string, span: TextSpan) => {
    if (span.code) return <Text backgroundColor={CODE_BACKGROUND}>{text}</Text>
    // Only the styles that are on: a message is mostly plain words, and
    // every character of the drawing counts toward the app's limit.
    const style = { ...(span.bold ? { bold: true } : {}), ...(span.italic ? { italic: true } : {}), ...(span.strike ? { strikethrough: true } : {}) }
    return <Text {...style}>{text}</Text>
  }

  // The flex items of one row of spans. A word is whatever has no space in
  // it: letters, a formula, the punctuation touching it. Each word is one
  // item, so a line never breaks between a formula and its comma, and the
  // space after a word travels with it.
  const wordsOf = (spans: Span[]): RenderChildren[] => {
    const items: RenderChildren[] = []
    type Atom = { text: string; span: TextSpan } | { element: RenderChildren }
    let word: Atom[] = []
    const endWord = (hasSpace: boolean) => {
      if (word.length === 0) return
      const last = word[word.length - 1]!
      if (hasSpace) {
        if ('text' in last && !last.span.code && !last.span.strike) last.text += NBSP
        else word.push({ element: <Text>{NBSP}</Text> })
      }
      const elements = word.map(atom => ('text' in atom ? textElement(atom.text, atom.span) : atom.element))
      items.push(
        elements.length === 1 ? (
          elements[0]
        ) : (
          <Box flexDirection="row" alignItems="center">
            {elements}
          </Box>
        ),
      )
      word = []
    }
    for (const span of spans) {
      if (span.kind === 'math') {
        word.push({ element: formula(span.tex) })
        continue
      }
      if (span.code) {
        word.push({ text: span.text, span })
        continue
      }
      const href = span.href ? safeHref(span.href) : null
      const text = span.href && !href ? `${span.text} (${span.href})` : span.text
      for (const token of text.split(/(\s+)/)) {
        if (token === '') continue
        if (/^\s+$/.test(token)) endWord(true)
        else if (href) word.push({ element: <Link href={href} label={token} /> })
        else word.push({ text: token, span })
      }
    }
    endWord(false)
    return items
  }

  const drawLine = (line: Line) => (
    <Box flexDirection="row" flexWrap="wrap" alignItems="center">
      {line.prefix ? line.quote ? <Text dimColor>{line.prefix}</Text> : <Text>{line.prefix}</Text> : null}
      {wordsOf(line.spans)}
    </Box>
  )

  const drawTable = (table: TablePiece) => {
    const columns = Math.max(table.header.length, ...table.rows.map(row => row.length))
    const widths = columnWidths(table, columns)
    const justify = { left: 'flex-start', center: 'center', right: 'flex-end' } as const
    const drawRow = (cells: Span[][], background: string | null) => (
      <Box flexDirection="row" {...(background ? { backgroundColor: background } : {})}>
        {widths.map((width, c) => (
          <Box
            width={`${width}%`}
            flexDirection="row"
            flexWrap="wrap"
            alignItems="center"
            justifyContent={justify[table.align[c] ?? 'left']}
            paddingX={1}
          >
            {wordsOf(cells[c] ?? [])}
          </Box>
        ))}
      </Box>
    )
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {drawRow(table.header, TABLE_HEAD)}
        {table.rows.map((row, r) => drawRow(row, r % 2 === 1 ? TABLE_STRIPE : null))}
      </Box>
    )
  }

  const drawDisplay = (p: DisplayPiece) => {
    const svg = ctx.formula(p.tex, true)
    if (svg) return <Svg source={svg} alt={p.tex} />
    const typeset = ctx.fallback ? ctx.fallback(p) : null
    if (typeset === undefined) return <Text dimColor>Typesetting with LaTeX…</Text>
    if (typeset && 'svg' in typeset) return <Svg source={typeset.svg} alt={p.tex} />
    return (
      <Box flexDirection="column">
        {source(p.tex, true)}
        {typeset?.error ? <Text dimColor>{typeset.error.split('\n')[0]}</Text> : null}
      </Box>
    )
  }

  const copyButton = (key: string, text: string) =>
    ctx.showCopy ? <Button key={key} label="Copy TeX" plain dimColor onPress={press => ctx.onCopy(text, press)} /> : null

  const drawPiece = (p: Piece, i: number) => {
    if (p.kind === 'md') return <Markdown text={p.text} />
    if (p.kind === 'table') return drawTable(p)
    if (p.kind === 'display') {
      return (
        <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
          {drawDisplay(p)}
          {copyButton(`copy-${i}`, p.tex)}
        </Box>
      )
    }
    if (p.kind === 'block') {
      const result = ctx.block(p)
      return (
        <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
          {!result && <Text dimColor>Compiling with LaTeX…</Text>}
          {result && 'svg' in result && <Svg source={result.svg} alt={p.source} />}
          {result && 'error' in result && (
            <Box flexDirection="column">
              <Text color="red">LaTeX did not compile:</Text>
              <Text color="red">{result.error}</Text>
            </Box>
          )}
          {copyButton(`copy-${i}`, p.source)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {p.lines.map(drawLine)}
      </Box>
    )
  }

  // The size of a piece of the drawing as the app receives it.
  const sizeOf = (element: RenderChildren): number => {
    try {
      return JSON.stringify(element)?.length ?? 0
    } catch {
      return 0
    }
  }
  let chars = 0
  let handedBackAt: number | null = null
  const drawn = pieces.map((p, i) => {
    if (handedBackAt !== null && p.kind !== 'md') return p.raw ? <Markdown text={p.raw} /> : null
    const element = drawPiece(p, i)
    const cost = sizeOf(element)
    if (ctx.maxChars !== undefined && p.kind !== 'md' && p.raw && chars + cost > ctx.maxChars) {
      handedBackAt = i
      return (
        <Box flexDirection="column">
          <Text dimColor>This message has more math than the app lets a mod draw in one message. From here on the app draws it.</Text>
          <Markdown text={p.raw} />
        </Box>
      )
    }
    chars += cost
    return element
  })
  ctx.onDrawn?.({ chars, handedBackAt })
  return <Box flexDirection="column">{drawn}</Box>
}
