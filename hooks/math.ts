import { tex2svg } from './mathjax/entry.js'

// TeX to SVG with MathJax, sized and coloured for the Code tab.

export type ColorScheme = 'auto' | 'light' | 'dark'

// CSS pixels per MathJax ex. MathJax lays out at ex = 8px for a 16px font.
// The Code tab's text is smaller, so scale down to match.
const PX_PER_EX = 7
// Height of the text's vertical centre above its baseline, in ex. A row of
// words and formulas is centred on this line, so each inline SVG is padded
// to put its baseline this far below its own centre.
const TEXT_CENTRE_EX = 0.75
const MAX_SVG = 131072
const LIGHT_INK = '#1f1e1d'
const DARK_INK = '#ece9e3'

const cache = new Map<string, string | null>()

export function inkStyle(scheme: ColorScheme): string {
  if (scheme === 'light') return `<style>svg{color:${LIGHT_INK}}</style>`
  if (scheme === 'dark') return `<style>svg{color:${DARK_INK}}</style>`
  return `<style>svg{color:${LIGHT_INK}}@media (prefers-color-scheme: dark){svg{color:${DARK_INK}}}</style>`
}

export function withInk(svg: string, scheme: ColorScheme): string {
  return svg.replace(/^(<svg[^>]*>)/, `$1${inkStyle(scheme)}`)
}

// Runs a preamble such as a macros file once. MathJax keeps \newcommand and
// \DeclareMathOperator definitions for every later formula.
export function definePreamble(tex: string): string | undefined {
  try {
    const svg = tex2svg(tex, false)
    const err = svg.match(/data-mjx-error="([^"]*)"/)
    return err ? (err[1] ?? 'error') : undefined
  } catch (error) {
    return String(error)
  }
}

function centreBaseline(svg: string): string {
  const style = svg.match(/vertical-align: (-?[\d.]+)ex/)
  const height = svg.match(/ height="([\d.]+)ex"/)
  const viewBox = svg.match(/viewBox="([-\d. ]+)"/)
  if (!style || !height || !viewBox) return svg
  const depth = -parseFloat(style[1] ?? '0')
  const total = parseFloat(height[1] ?? '0')
  const [x = 0, y = 0, w = 0, h = 0] = (viewBox[1] ?? '').split(' ').map(Number)
  const unitsPerEx = h / total
  const above = total - depth - TEXT_CENTRE_EX
  const below = depth + TEXT_CENTRE_EX
  const half = Math.max(above, below)
  const padTop = half - above
  const padBottom = half - below
  const newBox = [x, y - padTop * unitsPerEx, w, h + (padTop + padBottom) * unitsPerEx]
    .map(n => n.toFixed(1))
    .join(' ')
  return svg
    .replace(/ style="vertical-align: [^"]*"/, '')
    .replace(viewBox[0], `viewBox="${newBox}"`)
    .replace(height[0], ` height="${(total + padTop + padBottom).toFixed(3)}ex"`)
}

function exToPx(svg: string): string {
  return svg
    .replace(/ width="([\d.]+)ex"/, (_, w) => ` width="${(parseFloat(w) * PX_PER_EX).toFixed(1)}px"`)
    .replace(/ height="([\d.]+)ex"/, (_, h) => ` height="${(parseFloat(h) * PX_PER_EX).toFixed(1)}px"`)
}

// Returns the SVG without its colour style, or null when MathJax reports an
// error or the result is too large to draw.
export function renderTex(tex: string, display: boolean): string | null {
  const key = (display ? 'D:' : 'I:') + tex
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let out: string | null = null
  try {
    let svg = tex2svg(tex, display)
    if (!svg.includes('data-mml-node="merror"')) {
      if (!display) svg = centreBaseline(svg)
      svg = exToPx(svg)
      if (svg.length + 200 <= MAX_SVG) out = svg
    }
  } catch {
    out = null
  }
  cache.set(key, out)
  return out
}
