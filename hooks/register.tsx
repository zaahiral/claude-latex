import type { EngineInterface as Engine, Register, RenderChildren } from 'claude-code'
import { definePreamble, renderTex, withInk, type ColorScheme } from './math'
import { looksLikeMath, NBSP, parse, type Line } from './parse'
import {
  BIN_CANDIDATES,
  documentForBlock,
  documentForMath,
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
} from './texjobs'

// Draws messages in the desktop Code tab with TeX rendered.
// $$...$$, \[...\] and equation/align environments become centred SVG blocks
// with a Copy TeX button. A paragraph with $...$ or \(...\) is laid out word
// by word, each formula an inline SVG sitting on the text's baseline.
// MathJax draws every formula at once. With a LaTeX font chosen, the local
// TeX install then typesets each formula in that font and the drawing swaps.
// ```tikz, ```tikzcd and ```latex blocks are compiled with the local TeX.
// Everything else stays the app's own Markdown.

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

// Runs latex then dvisvgm in `dir` on `source`. Returns the SVG pages in
// order, or the LaTeX error.
async function runTex($: Engine, dir: string, source: string, dvisvgmArgs: string[]): Promise<string[] | { error: string }> {
  const { bin } = tex!
  await $.fs.write(`${dir}/d.tex`, source)
  for (const entry of await $.fs.list(dir)) {
    if (pageNumber(entry.name) !== undefined || entry.name === 'd.svg') await $.fs.write(`${dir}/${entry.name}`, '')
  }
  const latex = await $.process.run(
    [`${bin}/latex`, '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'd.tex'],
    { cwd: dir, timeoutMs: 60000 },
  )
  if (latex.exitCode !== 0) return { error: texError(latex.stdout) }
  const dvisvgm = await $.process.run([`${bin}/dvisvgm`, '--no-fonts', ...dvisvgmArgs, 'd.dvi'], {
    cwd: dir,
    timeoutMs: 60000,
  })
  if (dvisvgm.exitCode !== 0) return { error: dvisvgm.stderr.trim().split('\n').slice(-3).join('\n') }
  const pages = (await $.fs.list(dir))
    .map(entry => ({ name: entry.name, page: entry.name === 'd.svg' ? 1 : pageNumber(entry.name) }))
    .filter((p): p is { name: string; page: number } => p.page !== undefined)
    .sort((a, b) => a.page - b.page)
  const svgs: string[] = []
  for (const p of pages) {
    const svg = await $.fs.read(`${dir}/${p.name}`)
    if (svg.trim()) svgs.push(themeInk(svg))
  }
  return svgs
}

async function compileBlock($: Engine, job: BlockJob, font: LatexFont): Promise<Rendered> {
  const cached = `${tex!.cacheDir}/b-${job.key}.svg`
  if (await $.fs.exists(cached)) return { svg: await $.fs.read(cached) }
  const out = await runTex($, `${tex!.cacheDir}/build/block`, documentForBlock(job, font, macros), [
    '--exact-bbox',
    '--zoom=1.3',
    '-o',
    'd.svg',
  ])
  if (!Array.isArray(out)) return out
  const svg = out[0]
  if (!svg) return { error: 'dvisvgm wrote no page.' }
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
  const out = await runTex($, `${tex!.cacheDir}/build/math`, documentForMath(todo, font, macros), [
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

export const register: Register = (on, options) => {
  const scheme = (['light', 'dark'].includes(String(options.colorScheme))
    ? options.colorScheme
    : 'auto') as ColorScheme
  const fontOption = String(options.mathFont ?? 'mathjax')
  const latexFont: LatexFont | null = isLatexFont(fontOption) ? fontOption : null
  const blocksOn = options.tikz !== false
  const renderUser = options.userMessages !== false

  on('session.start', async ($, e, next) => {
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
      if (!ready && latexFont) $.ui.log('latex: no latex and dvisvgm found, so maths uses MathJax')
      if (ready) {
        let busy = false
        $.clock.every(150, () => {
          if (busy || !hasQueued()) return
          busy = true
          void (async () => {
            const block = takeBlock()
            if (block) {
              setResult(block.key, await compileBlock($, block, latexFont ?? 'cm').catch(error => ({ error: String(error) })))
            } else if (latexFont) {
              const batch = takeMathBatch(60)
              await compileMath($, batch, latexFont).catch(() => {
                for (const job of batch) setResult(job.key, { error: 'compile failed' })
              })
            }
            $.ui.invalidate('ui.render')
          })().finally(() => {
            busy = false
          })
        })
      }
    }
    return next(e)
  })

  on('ui.render', { component: ['AssistantMessage', 'UserMessage'] }, async ($, e, next) => {
    if (e.component === 'UserMessage' && !renderUser) return next(e)
    if (e.surface !== 'desktop' && e.surface !== 'mobile') return next(e)
    if (!looksLikeMath(e.props.text)) return next(e)
    const pieces = parse(e.props.text, { blocks: blocksOn && tex !== null })
    if (!pieces.some(p => p.kind !== 'md')) return next(e)

    const { Box, Text, Markdown, Svg, Button } = $.ui.resolve(e)
    const useLatex = latexFont !== null && tex !== null

    const formula = (source: string, display: boolean) => {
      if (useLatex) {
        const key = hashOf('math', latexFont, display ? 'D' : 'I', macros, source)
        const typeset = resultOf(key)
        if (typeset && 'svg' in typeset) return <Svg source={withInk(typeset.svg, scheme)} alt={source} />
        if (!typeset) requestMath({ key, tex: source, display })
      }
      const svg = renderTex(source, display)
      if (svg) return <Svg source={withInk(svg, scheme)} alt={source} />
      return <Text color="red">{display ? `$$${source}$$` : `$${source}$`}</Text>
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

    const copyButton = (key: string, text: string) => (
      <Button
        key={key}
        label="Copy TeX"
        plain
        dimColor
        onPress={press => {
          void $.ui.copy({ text, surface: press.surface }).then(r => {
            if (r.isCopied) $.ui.toast('TeX copied')
          })
        }}
      />
    )

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
            const key = hashOf('block', latexFont ?? 'cm', p.lang, macros, p.source)
            const result = resultOf(key)
            if (!result) requestBlock({ key, lang: p.lang, source: p.source })
            return (
              <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
                {!result && <Text dimColor>Compiling with LaTeX…</Text>}
                {result && 'svg' in result && <Svg source={withInk(result.svg, scheme)} alt={p.source} />}
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
  })
}
