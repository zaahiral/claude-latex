import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'
import { definePreamble, renderTex, withInk, type ColorScheme } from './math'
import { drawMessage } from './draw'
import { keepLineBreaks, looksLikeMath, parse } from './parse'
import {
  BIN_CANDIDATES,
  documentForBlock,
  documentForMath,
  fullDocument,
  hashOf,
  hasQueued,
  isLatexFont,
  pageNumber,
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

// Where latex and dvisvgm live, and where compiled SVGs are kept.
let tex: { bin: string; cacheDir: string } | null = null
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
  await $.process.run([`${tex!.bin}/latex`, '-ini', '-interaction=nonstopmode', `-jobname=${temp}`, '&latex', `${temp}.tex`], {
    cwd: dir,
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
      [`${bin}/latex`, ...(fmt ? [`-fmt=${fmt}`] : []), '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'd.tex'],
      { cwd: dir, timeoutMs: 60000 },
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
    const dvisvgm = await $.process.run([`${bin}/dvisvgm`, '--no-fonts', '--precision=2', ...dvisvgmArgs, 'd.dvi'], {
      cwd: dir,
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
  const renderUser = options.userMessages !== false
  const userMarkdown = options.userMarkdown !== false
  const showCopy = options.copyButton === true
  // The settings rows, by field: `latex.mathFont`, or `latex@inline.mathFont`
  // for a plugin loaded from a folder. Filled at session start.
  const configKeys = new Map<string, string>()

  on('session.start', async ($, e, next) => {
    try {
      for (const row of await $.config.list()) {
        const m = row.key.match(/^latex(@[\w-]+)?\.(\w+)$/)
        if (m?.[2]) configKeys.set(m[2], row.key)
      }
    } catch {
      // No settings rows here (tests): the pane shows values without buttons.
    }
    await $.command.register({ name: 'latex', description: 'Open the LaTeX mod settings' }).catch(() => undefined)
    if (!(await $.store.get(INTRO_SEEN).catch(() => true))) await update($, intro, () => true)
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const macrosPath = String(options.macrosFile || '~/.claude/latex-macros.tex').replace(/^~(?=\/)/, home)
    try {
      if (await $.fs.exists(macrosPath)) {
        macros = await $.fs.read(macrosPath)
        const error = definePreamble(macros)
        if (error) $.ui.log(`latex: ${macrosPath}: ${error}`)
      }
    } catch {
      // No file system here (tests, a remote host): no macros.
    }

    if (blocksOn || latexFont) {
      const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
      const ready = await findTex($, home, path).catch(() => false)
      if (!ready && latexFont) $.ui.log('latex: no latex and dvisvgm found, so math uses MathJax')
      if (ready) {
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
                const result = await compileBlock($, block, font).catch(describeFailure)
                const tries = retries.get(block.key) ?? 0
                if ('error' in result && result.interrupted && tries < MAX_RETRIES) {
                  retries.set(block.key, tries + 1)
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
    }
    return next(e)
  })

  on('command.run', { command: 'latex' }, async $ => {
    await $.ui.open({ id: PANE, title: 'LaTeX settings' })
    return { text: 'Opened the LaTeX settings.' }
  })

  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    if (e.surface !== 'desktop' && e.surface !== 'mobile') return next(e)
    const isUser = e.component === 'UserMessage'
    if (isUser && (e.props.task || e.props.from || !OWN_MESSAGES.has(e.props.origin.kind))) return next(e)
    const text = isUser ? keepLineBreaks(e.props.text) : e.props.text
    const withMath = !isUser || renderUser
    const markdownOnly = () => {
      const { Markdown } = $.ui.resolve(e)
      return <Markdown text={text} />
    }
    if (!withMath || !looksLikeMath(text)) return isUser && userMarkdown ? markdownOnly() : next(e)
    const pieces = parse(text, { blocks: blocksOn && tex !== null })
    if (!pieces.some(p => p.kind !== 'md')) return isUser && userMarkdown ? markdownOnly() : next(e)

    const { Box, Text, Markdown, Svg, Button } = $.ui.resolve(e)
    const useLatex = latexFont !== null && tex !== null
    let isWaiting = false

    // Fill the in-memory results from the disk cache before drawing.
    for (const p of pieces) {
      if (p.kind === 'block') {
        const key = hashOf('block', latexFont ?? 'cm', p.lang, macros, p.source)
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
      el: { Box, Text, Markdown, Svg, Button },
      formula: (source, display) => {
        if (useLatex) {
          const key = hashOf('math', latexFont, display ? 'D' : 'I', macros, source)
          const typeset = resultOf(key)
          if (typeset && 'svg' in typeset) return withInk(typeset.svg, scheme)
          if (!typeset) {
            requestMath({ key, tex: source, display })
            isWaiting = true
          }
        }
        const svg = renderTex(source, display)
        return svg ? withInk(svg, scheme) : null
      },
      block: p => {
        const key = hashOf('block', latexFont ?? 'cm', p.lang, macros, p.source)
        const result = resultOf(key)
        if (!result) {
          requestBlock({ key, lang: p.lang, source: p.source })
          isWaiting = true
          return undefined
        }
        return 'svg' in result ? { svg: withInk(result.svg, scheme) } : result
      },
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
    return tree
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
          Math, TikZ and LaTeX blocks in replies now render. You can pick one of 10 math fonts, turn Markdown in your messages on or off, and show a Copy TeX button.
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
    const set = (field: string, value: string | boolean) => {
      const key = configKeys.get(field)
      if (key) void $.config.set({ key, value }).catch(() => undefined)
    }
    const toggle = (field: string, label: string, help: string, isOn: boolean) => (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>{label}</Text>
          <Button key={`toggle-${field}`} label={isOn ? 'On' : 'Off'} variant={isOn ? 'primary' : 'secondary'} onPress={() => set(field, !isOn)} />
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
              onSelect={(value: string) => set('mathFont', value)}
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
              onSelect={(value: string) => set('colorScheme', value)}
            />
          ) : (
            <Text>{colorValue}</Text>
          )}
        </Box>
        {toggle('userMarkdown', 'Markdown in your messages', 'Your sent messages show bold, lists, code and tables.', userMarkdown)}
        {toggle('userMessages', 'Math in your messages', 'Your sent messages render $...$ math.', renderUser)}
        {toggle('copyButton', 'Copy TeX button', 'A button under each display formula and LaTeX block.', showCopy)}
        {toggle('tikz', 'Compile LaTeX blocks', 'tikz, tikzcd and latex code blocks, using your TeX install.', blocksOn)}
        <Text dimColor>Macros file: {String(options.macrosFile || '~/.claude/latex-macros.tex')}. Reopen this pane with /latex.</Text>
      </Box>
    )
  })
}
