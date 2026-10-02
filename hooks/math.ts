import { definePreamble as keepMacros, tex2svg } from './mathjax/entry.js'

// TeX to SVG with MathJax, sized and colored for the Code tab.

export type ColorScheme = 'auto' | 'light' | 'dark'

// CSS pixels per MathJax ex. MathJax lays out at ex = 8px for a 16px font.
// The Code tab's text is smaller, so scale down to match.
const PX_PER_EX = 7
// Height of the text's vertical center above its baseline, in ex. A row of
// words and formulas is centered on this line, so each inline SVG is padded
// to put its baseline this far below its own center.
const TEXT_CENTER_EX = 0.75
const MAX_SVG = 131072
const LIGHT_INK = '#1f1e1d'
const DARK_INK = '#ece9e3'

const cache = new Map<string, string | null>()

// LaTeX documents often use \bm from the bm package. MathJax 3 has no bm
// package, so map it to \boldsymbol.
keepMacros('\\newcommand{\\bm}[1]{\\boldsymbol{#1}}')

export function inkStyle(scheme: ColorScheme): string {
  if (scheme === 'light') return `<style>svg{color:${LIGHT_INK}}</style>`
  if (scheme === 'dark') return `<style>svg{color:${DARK_INK}}</style>`
  return `<style>svg{color:${LIGHT_INK}}@media (prefers-color-scheme: dark){svg{color:${DARK_INK}}}</style>`
}

export function withInk(svg: string, scheme: ColorScheme): string {
  return svg.replace(/^(<svg[^>]*>)/, `$1${inkStyle(scheme)}`)
}

// Runs a preamble such as a macros file once. Its \newcommand and
// \DeclareMathOperator definitions stay for every later formula. A formula in
// a message cannot do the same: its definitions end with it.
export function definePreamble(tex: string): string | undefined {
  try {
    const svg = keepMacros(tex)
    const err = svg.match(/data-mjx-error="([^"]*)"/)
    return err ? (err[1] ?? 'error') : undefined
  } catch (error) {
    return String(error)
  }
}

function centerBaseline(svg: string): string {
  const style = svg.match(/vertical-align: (-?[\d.]+)ex/)
  const height = svg.match(/ height="([\d.]+)ex"/)
  const viewBox = svg.match(/viewBox="([-\d. ]+)"/)
  if (!style || !height || !viewBox) return svg
  const depth = -parseFloat(style[1] ?? '0')
  const total = parseFloat(height[1] ?? '0')
  const [x = 0, y = 0, w = 0, h = 0] = (viewBox[1] ?? '').split(' ').map(Number)
  const unitsPerEx = h / total
  const above = total - depth - TEXT_CENTER_EX
  const below = depth + TEXT_CENTER_EX
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

// MathJax gives the rules of an array (\hline, the | in {cc|c}) their width
// in the page's stylesheet. An SVG drawn alone has no page, so the rules go
// inside it. Without them the lines are a thousandth of an em wide.
const TABLE_RULES =
  'line[data-line],rect[data-frame]{stroke-width:70px;fill:none}.mjx-dashed{stroke-dasharray:140}.mjx-dotted{stroke-linecap:round;stroke-dasharray:0,140}'

// Makes a MathJax SVG smaller without changing what it draws. The desktop
// app drops a message's drawing once it passes about 250 KB, so every
// character saved is more math per message. Dropped: the attributes MathJax
// writes for its own page scripts, long glyph ids, closing tags of empty
// elements, and groups that carry no attribute. Added: the table rules,
// where there is a table line.
function slim(svg: string): string {
  const hasRules = svg.includes('data-line') || svg.includes('data-frame')
  const ids = new Map<string, string>()
  const short = (id: string) => {
    let name = ids.get(id)
    if (!name) {
      name = `g${ids.size.toString(36)}`
      ids.set(id, name)
    }
    return name
  }
  const open: boolean[] = []
  const out = svg
    .replace(/ data-(?!line|frame)[\w-]+="[^"]*"/g, '')
    .replace(/ id="(MJX-[^"]+)"/g, (_, id: string) => ` id="${short(id)}"`)
    .replace(/ xlink:href="#(MJX-[^"]+)"/g, (_, id: string) => ` href="#${short(id)}"`)
    .replace(/ xmlns:xlink="[^"]*"| role="img"| focusable="false"/g, '')
    .replace(/><\/(path|use|rect|line)>/g, '/>')
    .replace(/<g>|<g\s[^>]*>|<\/g>/g, tag => {
      if (tag === '<g>') {
        open.push(false)
        return ''
      }
      if (tag === '</g>') return open.pop() ? tag : ''
      open.push(true)
      return tag
    })
    .replace(/<path id="(g[0-9a-z]+)" d="([^"]+)"\/>/g, (whole, id: string, d: string) => {
      const compact = compactPath(d)
      return compact === null ? whole : `<path id="${id}" transform="scale(${GRID})" d="${compact}"/>`
    })
  return hasRules ? out.replace(/^(<svg[^>]*>)/, `$1<style>${TABLE_RULES}</style>`) : out
}

// A glyph outline is most of a formula's SVG. MathJax writes it in absolute
// coordinates on a grid of 1000 to the em. This rewrites it on a grid ten
// times coarser, in relative coordinates, and scales the glyph back up. The
// outline moves by at most 0.005 em, about a fourteenth of a pixel, and
// takes about half the characters. An outline with a command this does not
// know is left as it is.
const GRID = 10
const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4, T: 2, C: 6, S: 4, Z: 0 }

function compactPath(d: string): string | null {
  const tokens = d.match(/[A-Za-z]|-?\d*\.?\d+/g)
  if (!tokens) return null
  let out = ''
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let command = ''
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    if (/[A-Za-z]/.test(token)) {
      command = token
      i += 1
    } else if (command === 'M') {
      // More pairs after a move are lines.
      command = 'L'
    }
    const count = ARGS[command]
    if (count === undefined || i + count > tokens.length) return null
    const values: number[] = []
    for (let k = 0; k < count; k++) {
      const value = Number(tokens[i + k])
      if (!Number.isFinite(value)) return null
      values.push(Math.round(value / GRID))
    }
    i += count
    if (command === 'Z') {
      out += 'z'
      x = startX
      y = startY
      continue
    }
    if (command === 'M') {
      out += `M${join(values)}`
      x = startX = values[0]!
      y = startY = values[1]!
      continue
    }
    if (command === 'H') {
      out += `h${values[0]! - x}`
      x = values[0]!
      continue
    }
    if (command === 'V') {
      out += `v${values[0]! - y}`
      y = values[0]!
      continue
    }
    // Pairs of x and y, each written from where the pen is now.
    out += command.toLowerCase() + join(values.map((value, k) => value - (k % 2 === 0 ? x : y)))
    x = values[count - 2]!
    y = values[count - 1]!
  }
  return out
}

// Numbers with as few separators as SVG needs: a minus sign is one already.
function join(values: number[]): string {
  return values.map((value, k) => (k > 0 && value >= 0 ? ' ' : '') + String(value)).join('')
}

// Returns the SVG without its color style, or null when MathJax reports an
// error or the result is too large to draw.
export function renderTex(tex: string, display: boolean): string | null {
  const key = (display ? 'D:' : 'I:') + tex
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let out: string | null = null
  try {
    let svg = tex2svg(tex, display)
    if (!svg.includes('data-mml-node="merror"')) {
      if (!display) svg = centerBaseline(svg)
      svg = slim(exToPx(svg))
      if (svg.length + 200 <= MAX_SVG) out = svg
    }
  } catch {
    out = null
  }
  cache.set(key, out)
  return out
}
