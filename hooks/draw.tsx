/** @jsx h */
import type { Elements, RenderChildren, RenderElement, UiPressArgument } from 'claude-code'
import { NBSP, type Line, type Piece } from './parse'
import type { Rendered } from './texjobs'

// Builds the drawing of one message from its pieces. No engine calls: the
// hook hands in the surface's elements and how to get each formula and
// block, so tools/preview.tsx can draw exactly the same tree outside the app.

type DrawElements = Pick<Elements['desktop'], 'Box' | 'Text' | 'Markdown' | 'Svg' | 'Button'>

export type DrawContext = {
  el: DrawElements
  // An SVG source ready to draw, or null when the formula does not render.
  formula: (tex: string, display: boolean) => string | null
  // A compiled block, or undefined while it is compiling.
  block: (piece: Extract<Piece, { kind: 'block' }>) => Rendered | undefined
  // Whether to draw a Copy TeX button under display math and blocks.
  showCopy: boolean
  // What pressing Copy TeX does with `text`.
  onCopy: (text: string, press: UiPressArgument) => void
}

export function drawMessage(pieces: Piece[], ctx: DrawContext): RenderElement {
  const { Box, Text, Markdown, Svg, Button } = ctx.el

  const formula = (tex: string, display: boolean) => {
    const svg = ctx.formula(tex, display)
    if (svg) return <Svg source={svg} alt={tex} />
    return <Text color="red">{display ? `$$${tex}$$` : `$${tex}$`}</Text>
  }

  const drawLine = (line: Line) => {
    const items: RenderChildren[] = []
    if (line.prefix) items.push(<Text>{line.prefix}</Text>)
    for (const span of line.spans) {
      if (span.kind === 'math') {
        items.push(formula(span.tex, false))
        continue
      }
      if (span.code) {
        items.push(<Text>{span.text}</Text>)
        continue
      }
      for (const token of span.text.split(/(\s+)/)) {
        if (token === '') continue
        if (/^\s+$/.test(token)) items.push(<Text>{NBSP}</Text>)
        else items.push(<Text bold={span.bold} italic={span.italic}>{token}</Text>)
      }
    }
    return (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center">
        {items}
      </Box>
    )
  }

  const copyButton = (key: string, text: string) =>
    ctx.showCopy ? <Button key={key} label="Copy TeX" plain dimColor onPress={press => ctx.onCopy(text, press)} /> : null

  return (
    <Box flexDirection="column">
      {pieces.map((p, i) => {
        if (p.kind === 'md') return <Markdown text={p.text} />
        if (p.kind === 'display') {
          return (
            <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
              {formula(p.tex, true)}
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
      })}
    </Box>
  )
}
