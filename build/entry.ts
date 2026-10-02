import { mathjax } from 'mathjax-full/js/mathjax.js'
import { TeX } from 'mathjax-full/js/input/tex.js'
import { SVG } from 'mathjax-full/js/output/svg.js'
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js'
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js'
import { MapHandler } from 'mathjax-full/js/input/tex/MapHandler.js'
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js'
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js'
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js'
import 'mathjax-full/js/input/tex/mhchem/MhchemConfiguration.js'
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration.js'
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js'
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js'
import 'mathjax-full/js/input/tex/braket/BraketConfiguration.js'
import 'mathjax-full/js/input/tex/textmacros/TextMacrosConfiguration.js'
import 'mathjax-full/js/input/tex/mathtools/MathtoolsConfiguration.js'

const adaptor = liteAdaptor()
RegisterHTMLHandler(adaptor)
const input = new TeX({ packages: ['base', 'ams', 'newcommand', 'mhchem', 'physics', 'boldsymbol', 'cancel', 'color', 'braket', 'textmacros', 'mathtools'] })
const doc = mathjax.document('', {
  InputJax: input,
  OutputJax: new SVG({ fontCache: 'local' }),
})

// MathJax keeps every \newcommand, \def and \DeclareMathOperator for all later
// formulas. A formula in a message must not change what the next one means,
// so the tables those definitions go into are put back after each formula.
// Only definePreamble keeps what it defines.
type Table = { map: Map<string, unknown> }
const tables = (): Table[] =>
  ['new-Command', 'new-Delimiter', 'new-Environment'].map(name => MapHandler.getMap(name) as unknown as Table)
let kept = tables().map(table => new Map(table.map))

function convert(tex: string, display: boolean): string {
  // Tags and labels start again, so the same \label in two formulas is fine.
  input.reset()
  const node = doc.convert(tex, { display, em: 16, ex: 8, containerWidth: 80 * 16 })
  return adaptor.innerHTML(node)
}

export function tex2svg(tex: string, display: boolean): string {
  try {
    return convert(tex, display)
  } finally {
    tables().forEach((table, i) => {
      table.map = new Map(kept[i])
    })
  }
}

// Runs definitions that stay for every later formula: a macros file.
export function definePreamble(tex: string): string {
  const svg = convert(tex, false)
  kept = tables().map(table => new Map(table.map))
  return svg
}
