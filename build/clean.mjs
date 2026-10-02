// Rewrites the bundled MathJax chunks so the plugin directory can read them.
// Run by build.sh after bundling, on every .js file in the folders given.
//
// 1. TypeScript's class helper falls back to `{__proto__:[]}` and
//    `d.__proto__ = b` when Object.setPrototypeOf is missing. Every engine
//    a mod runs in has Object.setPrototypeOf, so the fallback never runs.
//    It is removed, leaving `Object.setPrototypeOf || <copy the statics>`.
// 2. Every character outside ASCII is written as a \uXXXX escape, so a
//    reader sees which character it is. MathJax's tables hold many, some of
//    them invisible (U+2061 function application, U+00A0 no-break space).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROTO_FALLBACK = /\{__proto__:\[\]\}instanceof Array&&function\((\w+),(\w+)\)\{\1\.__proto__=\2\}\|\|/g

for (const dir of process.argv.slice(2)) {
  for (const name of readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const path = join(dir, name)
    const source = readFileSync(path, 'utf8')
    let protos = 0
    let out = source.replace(PROTO_FALLBACK, () => (protos++, ''))
    if (out.includes('__proto__')) throw new Error(`${path}: __proto__ left after the rewrite`)
    // A backslash before the character would make the escape a different string.
    if (/\\[^\x00-\x7f]/.test(out)) throw new Error(`${path}: a backslash before a character outside ASCII`)
    // The regex works on UTF-16 units, so a character past U+FFFF becomes
    // two escapes, which JavaScript reads back as the same character.
    let escaped = 0
    out = out.replace(/[^\x00-\x7f]/g, ch => {
      escaped++
      return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
    })
    writeFileSync(path, out)
    console.log(`${name}: ${protos} __proto__ fallbacks removed, ${escaped} characters escaped`)
  }
}
