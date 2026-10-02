import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'
import { definePreamble, renderTex, withInk, type ColorScheme } from './math'
import { drawMessage } from './draw'
import { keepLineBreaks, looksLikeMarkdown, looksLikeMath, mathOnly, parse } from './parse'
import {
  BIN_CANDIDATES,
  documentForBlock,
  documentForMath,
  fullDocument,
  hashOf,
  hasQueued,
  isLatexFont,
  pageNumber,
  release,
  requestBlock,
  requestMath,
  resultOf,
  setResult,
  takeBlock,
  takeMathBatch,
  texError,
  themeInk,
  type BlockJob,
  type LatexFont,
  type MathJob,
  type Rendered,
  type TexDoc,
} from './texjobs'

// Draws messages in the desktop Code tab with TeX rendered.
// $$...$$, \[...\] and equation/align environments become centered SVG blocks
// with a Copy TeX button. A paragraph with $...$ or \(...\) is laid out word
// by word, each formula an inline SVG sitting on the text's baseline.
// MathJax draws every formula at once. With a LaTeX font chosen, the local
// TeX install then typesets each formula in that font and the drawing swaps.
// ```tikz, ```tikzcd and ```latex blocks are compiled with the local TeX.
// Everything else stays the app's own Markdown.

// Goes up each time a compile finishes. Every message that draws math
// reads it, so writing it redraws exactly those messages.
const version = atom({ plugin: 'latex', key: 'version' } as const, 0)
// The one-time welcome band. Shown until dismissed, then remembered in the
// store across sessions.
const intro = atom({ plugin: 'latex', key: 'intro' } as const, false)
const INTRO_SEEN = 'introSeen'
const PANE = 'latex-settings'

// The user's own messages get Markdown. Notifications, agents and peers
// keep the app's drawing.
const OWN_MESSAGES = new Set(['composer', 'sdk', 'bridge', 'unclassified'])
// How your own sent message is drawn. `off`, the default: as typed, in the
// app's bubble. `under`: the app's bubble, with the math from the message
// under it. `rendered`, experimental: in a bubble of the mod's, as Markdown
// with its math.
const BUBBLE_MODES = ['off', 'under', 'rendered'] as const
type BubbleMode = (typeof BUBBLE_MODES)[number]
// The bubble behind a rendered message of yours: a light gray that reads on
// a light and on a dark theme.
const USER_BUBBLE = '#8080801f'
// What the model is told while the mod draws its replies: how to write math
// so it renders, and where the limits are. One section of the system prompt.
const MODEL_NOTE = `# Math rendering in this app (LaTeX mod)

A mod draws TeX in your replies here. Write math as TeX, never as Unicode symbols in plain text.

- Inline math: $...$ or \\(...\\). Display math: $$...$$, \\[...\\], or a bare equation, align, gather or multline environment.
- MathJax draws it, with AMS, mathtools, mhchem (\\ce), physics (\\dv, \\qty), braket, cancel and color. A display formula MathJax cannot draw is typeset by the user's own LaTeX when they have one.
- A \`\`\`tikz, \`\`\`tikzcd or \`\`\`latex code block is compiled by the user's LaTeX and shown as a drawing. To show LaTeX source as code, use \`\`\`tex.
- A macro defined in one formula (\\newcommand, \\def) does not exist in the next formula. Define it again, or avoid it.
- Size limit: one reply can hold about 235 KB of drawing. That is roughly 75 formulas in a reply that is mostly text, or 4 to 6 diagrams. Past the limit the rest of the reply is drawn by the app's plain renderer, which handles only simple formulas. Split longer material over several replies.
- One drawing can be at most 128 KB. A dense plot or a very long formula over that shows an error in its place.
- A display formula wider than the window is scaled down to fit. Break a long one over lines with aligned or split.
- Dollar amounts such as $5 and $10 are left as text. Write \\$ where a dollar sign could be read as math.
- The app may show text written between tool calls only as a short summary. Put math the user must see in the final message of a turn.`

// What the app's own row says under a rendered message of yours. The row is
// there for its controls.
const CONTROLS_ROW_TEXT = '⋯'

const FONT_CHOICES = ['mathjax', 'cm', 'libertinus', 'palatino', 'times', 'euler', 'concrete', 'fourier', 'stix2', 'kpfonts', 'cmbright']
// Compiles run side by side, each in its own folder.
const MAX_WORKERS = 3
// Interrupted compiles are retried this many times.
const MAX_RETRIES = 2
const retries = new Map<string, number>()

// What a failed run looks like to the reader.
function describeFailure(error: unknown): Rendered {
  const text = String(error)
  if (/time|still running/i.test(text)) {
    return { error: 'LaTeX ran for 60 seconds without finishing, so it was stopped. The block may loop forever.' }
  }
  return { error: text, interrupted: true }
}
// The app's limit on one Svg element is 131072 characters. Leave room for
// the color style withInk adds.
const MAX_SVG_CHARS = 131072 - 400
// How large one message's drawing may be. The desktop app showed a drawing
// of about 248,000 characters and dropped the next one, about 257,000,
// without a word: it kept showing the older drawing, with the end of the
// message missing. Past this size the mod hands the rest of the message to
// the app's own Markdown.
const MAX_MESSAGE_CHARS = 235_000

// Where latex and dvisvgm live, and where compiled SVGs are kept.
let tex: { bin: string; cacheDir: string } | null = null
// A log the mod writes to ~/.cache/claude-latex/debug/, readable without
// the app: each setup step, its time, and why it failed.
const debugLines: string[] = []
let debugDir = ''

function debug($: Engine, line: string): void {
  debugLines.push(`${new Date().toISOString()} ${line}`)
  if (debugLines.length > 600) debugLines.splice(0, debugLines.length - 600)
  if (debugDir) void $.fs.write(`${debugDir}/setup.log`, debugLines.join('\n') + '\n').catch(() => undefined)
}

// Runs one setup step on its own, so a failure or a hang in one never
// blocks the others.
async function step($: Engine, name: string, run: () => Promise<unknown>): Promise<void> {
  const t0 = Date.now()
  try {
    await run()
    debug($, `ok   ${name} ${Date.now() - t0} ms`)
  } catch (error) {
    debug($, `FAIL ${name} ${Date.now() - t0} ms: ${String(error)}`)
  }
}

// While a turn runs, its message is redrawn on every streamed chunk anyway,
// and forcing extra redraws of a message mid-stream can stall the app's
// drawing of it. So forced redraws wait for the turn to end. The flag clears
// itself after ten minutes in case an end event is missed.
let turnStartedAt = 0
function isTurnRunning(): boolean {
  return turnStartedAt > 0 && Date.now() - turnStartedAt < 10 * 60 * 1000
}

// Compiles queued blocks and formulas, up to MAX_WORKERS at once, and
// redraws waiting messages as results land.
let workersStarted = false
function startWorkers($: Engine, latexFont: LatexFont | null): void {
  if (workersStarted) return
  workersStarted = true
  let running = 0
  let finished = 0
  let lastBump = 0
  $.clock.every(100, () => {
    // Redraw waiting messages at most every 400 ms, and once more when
    // the queue drains, rather than once per compile.
    const now = Date.now()
    if (finished > 0 && (now - lastBump >= 400 || (running === 0 && !hasQueued()))) {
      finished = 0
      lastBump = now
      void update($, version, n => n + 1).catch(() => undefined)
    }
    while (running < MAX_WORKERS && hasQueued()) {
      const block = takeBlock()
      const batch = block || !latexFont ? [] : takeMathBatch(60)
      if (!block && batch.length === 0) break
      running += 1
      void (async () => {
        if (block) {
          const font = latexFont ?? 'cm'
          const compileStarted = Date.now()
          const result = await compileBlock($, block, font).catch(describeFailure)
          const tries = retries.get(block.key) ?? 0
          const outcome = 'svg' in result ? `${result.svg.length} chars` : `error${result.interrupted ? ' (interrupted)' : ''}: ${result.error.split('\n')[0]}`
          debug($, `compiled ${block.lang} ${block.key}, try ${tries + 1}: ${outcome}, ${Date.now() - compileStarted} ms | ${JSON.stringify(block.source.slice(0, 40))}`)
          if ('error' in result && result.interrupted && tries < MAX_RETRIES) {
            retries.set(block.key, tries + 1)
            release(block.key)
            requestBlock(block)
          } else {
            setResult(block.key, result)
          }
        } else if (latexFont) {
          await compileMath($, batch, latexFont).catch(() => {
            for (const job of batch) setResult(job.key, { error: 'compile failed' })
          })
        }
      })()
        .catch(() => undefined)
        .finally(() => {
          running -= 1
          finished += 1
        })
    }
  })
}

// A macOS sandbox profile every TeX run goes through, when sandbox-exec works
// here. A LaTeX block can \\input any file by its absolute path, and TeX's own
// openin_any setting does not stop that, so the profile denies reading the
// home folder apart from TeX's and the mod's own folders, and denies the
// network and writes outside them.
let sandbox: string | null = null
const SANDBOX_EXEC = '/usr/bin/sandbox-exec'
// TeX's own write guard: no writing outside the build folder.
const TEX_ENV = { openout_any: 'p', openin_any: 'p' }

function sandboxProfile(home: string, cacheDir: string): string {
  const q = (path: string) => JSON.stringify(path)
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    `(deny file-read* (subpath ${q(home)}) (subpath "/Volumes"))`,
    `(allow file-read* (subpath ${q(cacheDir)}) (subpath ${q(`${home}/Library/texlive`)}) (subpath ${q(`${home}/Library/texmf`)}) (subpath ${q(`${home}/texmf`)}))`,
    '(deny file-write* (subpath "/"))',
    `(allow file-write* (subpath ${q(cacheDir)}) (subpath ${q(`${home}/Library/texlive`)}) (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null"))`,
    '',
  ].join('\n')
}

// Wraps a TeX command in the sandbox when there is one.
function texArgv(argv: string[]): string[] {
  return sandbox ? [SANDBOX_EXEC, '-f', sandbox, ...argv] : argv
}

async function setupSandbox($: Engine, home: string): Promise<void> {
  if (!tex || !home) return
  const path = `${tex.cacheDir}/sandbox.sb`
  await $.fs.write(path, sandboxProfile(home, tex.cacheDir))
  const probe = await $.process.run([SANDBOX_EXEC, '-f', path, '/usr/bin/true']).catch(() => null)
  if (probe?.exitCode === 0) sandbox = path
  else $.ui.log('latex: could not sandbox LaTeX here, so LaTeX blocks run without a sandbox', { to: 'debug' })
}
let macros = ''

async function findTex($: Engine, home: string, path: string): Promise<boolean> {
  for (const dir of [...BIN_CANDIDATES, ...path.split(':').filter(Boolean)]) {
    const found =
      (await $.fs.exists(`${dir}/latex`).catch(() => false)) &&
      (await $.fs.exists(`${dir}/dvisvgm`).catch(() => false))
    if (found) {
      tex = { bin: dir, cacheDir: `${home}/.cache/claude-latex` }
      return true
    }
  }
  return false
}

// Saved LaTeX formats: the class and fixed preamble of one kind of document,
// loaded once and dumped, so each compile skips loading TikZ, pgfplots and
// the font packages. About halves LaTeX time. Built once per machine and
// kept in the cache folder. A format that ever fails is not used again this
// session, and the compile falls back to the whole document.
const formats = new Map<string, Promise<string | null>>()
const brokenFormats = new Set<string>()

async function buildFormat($: Engine, name: string, base: string): Promise<string | null> {
  const dir = `${tex!.cacheDir}/formats`
  const path = `${dir}/${name}`
  if (await $.fs.exists(`${path}.fmt`)) return path
  // Build under a temporary name, then move it into place, so a session that
  // looks while another builds never reads half a format.
  const temp = `${name}-${Math.random().toString(36).slice(2, 8)}`
  await $.fs.write(`${dir}/${temp}.tex`, `${base}\n\\dump\n`)
  await $.process.run(texArgv([`${tex!.bin}/latex`, '-ini', '-interaction=nonstopmode', `-jobname=${temp}`, '&latex', `${temp}.tex`]), {
    cwd: dir,
    env: TEX_ENV,
    timeoutMs: 120000,
  })
  if (!(await $.fs.exists(`${dir}/${temp}.fmt`))) return null
  await $.process.run(['/bin/mv', `${dir}/${temp}.fmt`, `${path}.fmt`])
  await $.process.run(['/bin/rm', '-f', `${dir}/${temp}.tex`, `${dir}/${temp}.log`]).catch(() => undefined)
  return (await $.fs.exists(`${path}.fmt`)) ? path : null
}

function formatName(doc: TexDoc): string {
  return `fmt-${doc.kind}-${hashOf(doc.base)}`
}

function formatFor($: Engine, doc: TexDoc): Promise<string | null> {
  const name = formatName(doc)
  if (brokenFormats.has(name)) return Promise.resolve(null)
  let pending = formats.get(name)
  if (!pending) {
    pending = buildFormat($, name, doc.base).catch(() => null)
    formats.set(name, pending)
  }
  return pending
}

// Runs latex then dvisvgm in a fresh folder `dir`, then removes it.
// Returns the SVG pages in order, or the LaTeX error.
async function runTex($: Engine, dir: string, doc: TexDoc, dvisvgmArgs: string[]): Promise<string[] | { error: string; interrupted?: boolean }> {
  const { bin } = tex!
  const latex = async (source: string, fmt: string | null) => {
    await $.fs.write(`${dir}/d.tex`, source)
    return $.process.run(
      texArgv([`${bin}/latex`, ...(fmt ? [`-fmt=${fmt}`] : []), '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'd.tex']),
      { cwd: dir, env: TEX_ENV, timeoutMs: 60000 },
    )
  }
  try {
    const fmt = await formatFor($, doc)
    let run = fmt ? await latex(doc.rest, fmt) : await latex(fullDocument(doc), null)
    if (run.exitCode !== 0 && fmt) {
      // Either the document has an error or the format does. The whole
      // document tells them apart.
      run = await latex(fullDocument(doc), null)
      if (run.exitCode === 0) brokenFormats.add(formatName(doc))
    }
    if (run.exitCode !== 0) {
      // A run with no error line was stopped from outside, not by the TeX.
      const isTexError = run.stdout.includes('\n!') || run.stdout.startsWith('!')
      return isTexError ? { error: texError(run.stdout) } : { error: 'The compile was interrupted.', interrupted: true }
    }
    const dvisvgm = await $.process.run(texArgv([`${bin}/dvisvgm`, '--no-fonts', '--precision=2', ...dvisvgmArgs, 'd.dvi']), {
      cwd: dir,
      env: TEX_ENV,
      timeoutMs: 60000,
    })
    if (dvisvgm.exitCode !== 0) return { error: 'dvisvgm stopped before writing the SVG.', interrupted: true }
    const pages = (await $.fs.list(dir))
      .map(entry => ({ name: entry.name, page: entry.name === 'd.svg' ? 1 : pageNumber(entry.name) }))
      .filter((p): p is { name: string; page: number } => p.page !== undefined)
      .sort((a, b) => a.page - b.page)
    const svgs: string[] = []
    for (const p of pages) svgs.push(themeInk(await $.fs.read(`${dir}/${p.name}`)))
    return svgs
  } finally {
    await $.process.run(['/bin/rm', '-rf', dir]).catch(() => undefined)
  }
}

async function compileBlock($: Engine, job: BlockJob, font: LatexFont): Promise<Rendered> {
  const cached = `${tex!.cacheDir}/b-${job.key}.svg`
  if (await $.fs.exists(cached)) return { svg: await $.fs.read(cached) }
  const out = await runTex($, `${tex!.cacheDir}/build/b-${job.key}`, documentForBlock(job, font, macros), [
    '--exact-bbox',
    '--zoom=1.3',
    '-o',
    'd.svg',
  ])
  if (!Array.isArray(out)) return out
  const svg = out[0]
  if (!svg) return { error: 'dvisvgm wrote no page.' }
  // The app refuses an SVG over 131072 characters, and refusing one refuses
  // the whole message's drawing. Report it on this block instead.
  if (svg.length > MAX_SVG_CHARS) {
    return { error: `This drawing is ${Math.round(svg.length / 1024)} KB of SVG. The app draws at most 128 KB.` }
  }
  await $.fs.write(cached, svg)
  return { svg }
}

// Typesets a batch of formulas in one LaTeX run, one page each. If the run
// fails, each formula is tried alone so one bad formula costs only itself.
async function compileMath($: Engine, jobs: MathJob[], font: LatexFont): Promise<void> {
  const todo: MathJob[] = []
  for (const job of jobs) {
    const cached = `${tex!.cacheDir}/m-${job.key}.svg`
    if (await $.fs.exists(cached)) setResult(job.key, { svg: await $.fs.read(cached) })
    else todo.push(job)
  }
  if (todo.length === 0) return
  const batchDir = `${tex!.cacheDir}/build/m-${hashOf(...todo.map(job => job.key))}`
  const out = await runTex($, batchDir, documentForMath(todo, font, macros), [
    '--bbox=papersize',
    '--zoom=1.2',
    '-p',
    '1-',
  ])
  if (Array.isArray(out) && out.length === todo.length) {
    for (const [i, job] of todo.entries()) {
      const svg = out[i]!
      setResult(job.key, { svg })
      await $.fs.write(`${tex!.cacheDir}/m-${job.key}.svg`, svg)
    }
    return
  }
  if (todo.length === 1) {
    setResult(todo[0]!.key, Array.isArray(out) ? { error: 'page count mismatch' } : out)
    return
  }
  for (const job of todo) await compileMath($, [job], font)
}

// A compiled SVG already on disk is read straight into memory while
// drawing, so a cached diagram appears at once instead of after a compile
// round trip.
async function fromDisk($: Engine, file: string, key: string): Promise<Rendered | undefined> {
  if (!tex) return undefined
  const path = `${tex.cacheDir}/${file}`
  if (!(await $.fs.exists(path).catch(() => false))) return undefined
  const svg = await $.fs.read(path).catch(() => '')
  if (!svg) return undefined
  setResult(key, { svg })
  return { svg }
}

export const register: Register = (on, options) => {
  const scheme = (['light', 'dark'].includes(String(options.colorScheme))
    ? options.colorScheme
    : 'auto') as ColorScheme
  const fontOption = String(options.mathFont ?? 'mathjax')
  const latexFont: LatexFont | null = isLatexFont(fontOption) ? fontOption : null
  const blocksOn = options.tikz !== false
  const bubbleMode: BubbleMode = BUBBLE_MODES.find(mode => mode === options.userBubble) ?? 'off'
  const showCopy = options.copyButton === true
  const tellModel = options.tellModel !== false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Setup runs after the session is ready, so it never holds it up. TeX
    // comes first: it is what most of the mod needs.
    void (async () => {
      const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
      debugDir = home ? `${home}/.cache/claude-latex/debug` : ''
      debug($, `session start, options ${JSON.stringify(options)}`)

      if (blocksOn || latexFont) {
        let ready = false
        await step($, 'find TeX', async () => {
          const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
          ready = await findTex($, home, path)
          debug($, `     TeX ${ready ? `at ${tex?.bin}` : 'not found'}`)
        })
        if (!ready && latexFont) $.ui.log('latex: no latex and dvisvgm found, so math uses MathJax')
        if (ready) {
          await step($, 'sandbox', async () => {
            await setupSandbox($, home)
            debug($, `     sandbox ${sandbox ? 'on' : 'off'}`)
          })
          // A compile killed mid-run (a reload, a crash) leaves its folder.
          // Clear folders older than ten minutes, which no live compile uses.
          void $.process
            .run(['/usr/bin/find', `${tex!.cacheDir}/build`, '-mindepth', '1', '-maxdepth', '1', '-mmin', '+10', '-exec', '/bin/rm', '-rf', '{}', '+'])
            .catch(() => undefined)
          // Build the common formats now, in the background, so the first
          // diagram does not wait for them.
          const font = latexFont ?? 'cm'
          void formatFor($, documentForBlock({ key: '', lang: 'tikz', source: '' }, font, ''))
          void formatFor($, documentForBlock({ key: '', lang: 'latex', source: '' }, font, ''))
          if (latexFont) void formatFor($, documentForMath([], latexFont, ''))
          startWorkers($, latexFont)
          // Messages drawn before TeX was found left their blocks as code.
          // Draw them again now that blocks can compile.
          await update($, version, n => n + 1).catch(() => undefined)
        }
      }

      await step($, 'macros', async () => {
        const macrosPath = String(options.macrosFile || '~/.claude/latex-macros.tex').replace(/^~(?=\/)/, home)
        if (await $.fs.exists(macrosPath)) {
          macros = await $.fs.read(macrosPath)
          const error = definePreamble(macros)
          if (error) $.ui.log(`latex: ${macrosPath}: ${error}`)
        }
      })
      await step($, 'settings rows', async () => {
        const keys = (await $.config.list()).map(row => row.key).filter(key => key.startsWith('latex'))
        debug($, `     keys ${JSON.stringify(keys)}`)
      })
      await step($, 'register /latex', () => $.command.register({ name: 'latex', description: 'Open the LaTeX mod settings' }))
      await step($, 'welcome band', async () => {
        if (!(await $.store.get(INTRO_SEEN))) await update($, intro, () => true)
      })
    })()
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    turnStartedAt = Date.now()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    turnStartedAt = 0
    // One redraw for everything that compiled during the turn.
    await update($, version, n => n + 1).catch(() => undefined)
    return done
  })

  // The model cannot see how its reply is drawn. Where the mod draws, it adds
  // one section to the system prompt saying how math renders and what the
  // limits are.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const drawsHere = e.surfaces.some(surface => surface === 'desktop' || surface === 'mobile')
    if (!tellModel || !drawsHere) return composed
    return { sections: [...composed.sections, { id: 'latex:rendering', text: MODEL_NOTE, scope: 'session' as const }] }
  })

  on('command.run', { command: 'latex' }, async $ => {
    await $.ui.open({ id: PANE, title: 'LaTeX settings' })
    return { text: 'Opened the LaTeX settings.' }
  })

  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'mobile') return next(e)
    const renderStarted = Date.now()
    try {
    const isUser = e.component === 'UserMessage'
    if (isUser && (e.props.task || e.props.from || !OWN_MESSAGES.has(e.props.origin.kind))) return next(e)
    const text = isUser ? keepLineBreaks(e.props.text) : e.props.text
    const { Box, Text, Markdown, Svg, Button, Link } = $.ui.resolve(e)
    const mode = !isUser ? 'reply' : bubbleMode
    if (mode === 'off') return next(e)
    // Before TeX is found, blocks are left as code. Listen for the redraw
    // that follows TeX setup.
    if (blocksOn && tex === null && /```\s*(tikz|latex)/.test(text)) await read($, version)
    const hasMath = looksLikeMath(text)
    // A message of yours with nothing to render keeps the app's own bubble.
    if (!hasMath && !(mode === 'rendered' && looksLikeMarkdown(text))) return next(e)
    let pieces = parse(text, { blocks: blocksOn && tex !== null })
    if (mode === 'under') pieces = mathOnly(pieces)
    // A display formula MathJax cannot draw goes to LaTeX. Before TeX is
    // found it is drawn as source: listen for the redraw that follows setup.
    if (blocksOn && tex === null && pieces.some(p => p.kind === 'display' && renderTex(p.tex, true) === null)) await read($, version)
    // Dollars that turned out not to be math leave nothing to draw.
    if (!pieces.some(p => p.kind !== 'md') && !(mode === 'rendered' && looksLikeMarkdown(text))) return next(e)

    // The app's bubble cannot be drawn into: it reaches a mod as a closed
    // handle. So a rendered message of yours is drawn in a bubble of the
    // mod's own, on the right, with a Copy button that appears under it on
    // hover and copies the message as you typed it.
    const inBubble = (tree: ReturnType<typeof drawMessage>) => (
      <Box key={`you-${hashOf(e.props.text)}`} flexDirection="column" alignItems="flex-end">
        <Box flexDirection="column" flexShrink={1} marginLeft={6} backgroundColor={USER_BUBBLE} borderStyle="round" borderColor={USER_BUBBLE} paddingX={1}>
          {tree}
        </Box>
        <Box flexDirection="row" height={1}>
          <Box flexDirection="row" display="none" hover={{ display: 'flex' }}>
            <Button
              key="copy-message"
              label="Copy"
              plain
              dimColor
              onPress={press => {
                void $.ui.copy({ text: e.props.text, surface: press.surface }).then(r => {
                  if (r.isCopied) $.ui.toast('Message copied')
                })
              }}
            />
          </Box>
        </Box>
      </Box>
    )
    // `under` keeps the app's bubble and adds the math below it.
    const underBubble = async (tree: ReturnType<typeof drawMessage>) => (
      <Box flexDirection="column">
        {await next(e)}
        <Box flexDirection="column" marginTop={1}>
          {tree}
        </Box>
      </Box>
    )

    const useLatex = latexFont !== null && tex !== null
    let isWaiting = false
    // What this drawing hands the app, for the debug log.
    const handed = { svgs: 0, svgChars: 0 }
    let size: { chars: number; handedBackAt: number | null } = { chars: 0, handedBackAt: null }
    const count = (svg: string) => {
      handed.svgs += 1
      handed.svgChars += svg.length
      return svg
    }
    // A display formula MathJax cannot draw is typeset by the local LaTeX,
    // as a LaTeX block would be.
    const canFallBack = blocksOn && tex !== null
    const fallbackBlock = (p: { source: string }) => ({ lang: 'latex' as const, source: p.source })
    const blockKey = (p: { lang: BlockJob['lang']; source: string }) => hashOf('block', latexFont ?? 'cm', p.lang, macros, p.source)
    const compiled = (p: { lang: BlockJob['lang']; source: string }) => {
      const key = blockKey(p)
      const result = resultOf(key)
      if (!result) {
        requestBlock({ key, lang: p.lang, source: p.source })
        isWaiting = true
        return undefined
      }
      return 'svg' in result ? { svg: count(withInk(result.svg, scheme)) } : result
    }

    // Fill the in-memory results from the disk cache before drawing.
    for (const p of pieces) {
      const asBlock = p.kind === 'block' ? p : p.kind === 'display' && canFallBack && renderTex(p.tex, true) === null ? fallbackBlock(p) : null
      if (asBlock) {
        const key = blockKey(asBlock)
        if (!resultOf(key)) await fromDisk($, `b-${key}.svg`, key)
      }
      if (useLatex && (p.kind === 'display' || p.kind === 'inline')) {
        const formulas =
          p.kind === 'display'
            ? [{ tex: p.tex, display: true }]
            : p.lines.flatMap(l => l.spans.flatMap(sp => (sp.kind === 'math' ? [{ tex: sp.tex, display: false }] : [])))
        for (const f of formulas) {
          const key = hashOf('math', latexFont, f.display ? 'D' : 'I', macros, f.tex)
          if (!resultOf(key)) await fromDisk($, `m-${key}.svg`, key)
        }
      }
    }

    const tree = drawMessage(pieces, {
      el: { Box, Text, Markdown, Svg, Button, Link },
      formula: (source, display) => {
        if (useLatex) {
          const key = hashOf('math', latexFont, display ? 'D' : 'I', macros, source)
          const typeset = resultOf(key)
          if (typeset && 'svg' in typeset) return count(withInk(typeset.svg, scheme))
          if (!typeset) {
            requestMath({ key, tex: source, display })
            isWaiting = true
          }
        }
        const svg = renderTex(source, display)
        return svg ? count(withInk(svg, scheme)) : null
      },
      block: compiled,
      maxChars: MAX_MESSAGE_CHARS,
      onDrawn: drawn => {
        size = drawn
      },
      fallback: p => (canFallBack ? compiled(fallbackBlock(p)) : null),
      showCopy,
      onCopy: (text, press) => {
        void $.ui.copy({ text, surface: press.surface }).then(r => {
          if (r.isCopied) $.ui.toast('TeX copied')
        })
      },
    })
    // Only a message still waiting on a compile listens for finished
    // compiles. A finished message is never redrawn by them.
    if (isWaiting) await read($, version)
    const kinds = pieces.map(p => p.kind[0]).join('')
    debug($, `drew ${e.component} ${e.props.text.length} chars as ${mode}: pieces ${kinds}, ${handed.svgs} svgs of ${handed.svgChars} chars, drawing ${size.chars} chars${size.handedBackAt === null ? '' : ` then handed back from piece ${size.handedBackAt}`}, ${Date.now() - renderStarted} ms${isWaiting ? ', waiting on LaTeX' : ''} | ${JSON.stringify(e.props.text.slice(0, 40))}`)
    if (mode === 'rendered') {
      // The time, copy, rewind and fork controls are the app's, and come only
      // with the app's own row. So that row is kept under the rendered
      // bubble with its text replaced by an ellipsis: a small pill whose
      // controls show on hover. It must be asked for once: the app drew
      // nothing when one drawing held several of its rows.
      const controls = await next({ ...e, props: { ...e.props, text: CONTROLS_ROW_TEXT } } as typeof e).catch(() => null)
      return (
        <Box flexDirection="column">
          {inBubble(tree)}
          {controls}
        </Box>
      )
    }
    return mode === 'under' ? await underBubble(tree) : tree
    } catch (error) {
      // Never leave a message undrawn: fall back to the app's own drawing.
      debug($, `render error (${e.component}, ${e.props.text.length} chars): ${String(error)}`)
      return next(e)
    } finally {
      const ms = Date.now() - renderStarted
      if (ms > 150) debug($, `slow render ${ms} ms (${e.component}, ${e.props.text.length} chars)`)
    }
  }).catch(async ($, e, next) => {
    // The engine refused the drawing, or the hook overran. Write down why,
    // and let the app draw the message itself.
    debug($, `REFUSED ${e.component} ${e.props.text.length} chars: ${next.error.kind} ${next.error.message ?? ''} | ${JSON.stringify(e.props.text.slice(0, 40))}`)
    return next(e)
  })

  // A one-time band above the prompt: what the mod does, where its settings are.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, intro))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const dismiss = async () => {
      await $.store.set(INTRO_SEEN, true)
      await update($, intro, () => false)
    }
    return (
      <Box flexDirection="column">
        <Text bold>LaTeX mod is on</Text>
        <Text dimColor>
          Math, TikZ and LaTeX blocks in replies now render. You can pick one of 10 math fonts, and choose whether your own messages show their math.
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button
            key="intro-settings"
            label="Open settings"
            variant="primary"
            onPress={() => {
              void dismiss()
              void $.ui.open({ id: PANE, title: 'LaTeX settings' })
            }}
          />
          <Button key="intro-dismiss" label="Got it" role="dismiss" onPress={() => void dismiss()} />
        </Box>
      </Box>
    )
  })

  // The settings pane, opened by /latex or the welcome band. Each change goes
  // through the app's own settings, which reloads the mod with the new value.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // The mobile app has no Select. Show the value as text there.
    const Select = 'Select' in elements ? elements.Select : undefined
    // Each call names its setting in full, so the plugin directory can read
    // which settings the pane changes. A change reloads the mod.
    const saved = (change: Promise<unknown>) => void change.catch(error => debug($, `config.set failed: ${error}`))
    const setMathFont = (value: string) => saved($.config.set({ key: 'latex.mathFont', value: value }))
    const setColorScheme = (value: string) => saved($.config.set({ key: 'latex.colorScheme', value: value }))
    const setUserBubble = (value: string) => saved($.config.set({ key: 'latex.userBubble', value: value }))
    const setTellModel = (value: boolean) => saved($.config.set({ key: 'latex.tellModel', value: value }))
    const setCopyButton = (value: boolean) => saved($.config.set({ key: 'latex.copyButton', value: value }))
    const setTikz = (value: boolean) => saved($.config.set({ key: 'latex.tikz', value: value }))
    const toggle = (field: string, label: string, help: string, isOn: boolean, change: (value: boolean) => void) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{label}</Text>
          <Button key={`toggle-${field}`} label={isOn ? 'On' : 'Off'} variant={isOn ? 'primary' : 'secondary'} onPress={() => change(!isOn)} />
        </Box>
        <Text dimColor>{help}</Text>
      </Box>
    )
    const fontValue = String(options.mathFont ?? 'mathjax')
    const colorValue = String(options.colorScheme ?? 'auto')
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Math font</Text>
          {Select ? (
            <Select
              key="math-font"
              value={fontValue}
              options={FONT_CHOICES.map(v => ({ value: v, label: v === 'mathjax' ? 'MathJax (instant)' : v }))}
              onSelect={setMathFont}
            />
          ) : (
            <Text>{fontValue}</Text>
          )}
          <Text dimColor>MathJax draws at once. Any other font is typeset by your own LaTeX, with MathJax shown until it is ready.</Text>
        </Box>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Math color</Text>
          {Select ? (
            <Select
              key="math-color"
              value={colorValue}
              options={[{ value: 'auto', label: 'Follow the system' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
              onSelect={setColorScheme}
            />
          ) : (
            <Text>{colorValue}</Text>
          )}
        </Box>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Your messages</Text>
          {Select ? (
            <Select
              key="user-bubble"
              value={bubbleMode}
              options={[
                { value: 'off', label: 'As typed' },
                { value: 'under', label: 'As typed, with the math under the bubble' },
                { value: 'rendered', label: 'Rendered: Markdown and math in a bubble (experimental)' },
              ]}
              onSelect={setUserBubble}
            />
          ) : (
            <Text>{bubbleMode}</Text>
          )}
          <Text dimColor>How a message you sent is drawn. Rendered draws its own bubble and keeps the app's row under it as a small pill, for the time, rewind and fork controls.</Text>
        </Box>
        {toggle('tellModel', 'Tell the model how math renders here', 'Adds a short note to the system prompt: the syntax that renders, and the size limits.', tellModel, setTellModel)}
        {toggle('copyButton', 'Copy TeX button', 'A button under each display formula and LaTeX block.', showCopy, setCopyButton)}
        {toggle('tikz', 'Compile LaTeX blocks', 'tikz, tikzcd and latex code blocks, using your TeX install.', blocksOn, setTikz)}
        <Text dimColor>Macros file: {String(options.macrosFile || '~/.claude/latex-macros.tex')}. Reopen this pane with /latex.</Text>
      </Box>
    )
  })
}
