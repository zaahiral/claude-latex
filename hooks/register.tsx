import type { EngineInterface as Engine, Register, RenderChildren } from 'claude-code'
import { definePreamble, renderTex, withInk, type ColorScheme } from './math'
import { looksLikeMath, NBSP, parse, type Line } from './parse'
import {
  BIN_CANDIDATES,
  documentFor,
  hashOf,
  hasQueued,
  requestTikz,
  setResult,
  takeNext,
  texError,
  themeInk,
  tikzResult,
  type TikzResult,
} from './tikz'

// Draws messages in the desktop Code tab with TeX rendered.
// $$...$$, \[...\] and equation/align environments become centred SVG blocks
// with a Copy TeX button. A paragraph with $...$ or \(...\) is laid out word
// by word, each formula an inline SVG sitting on the text's baseline.
// ```tikz and ```tikzcd blocks are compiled with the local TeX install.
// Everything else stays the app's own Markdown.

// Where latex and dvisvgm live, and where compiled diagrams are kept.
let tex: { bin: string; cacheDir: string } | null = null

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

async function compileTikz($: Engine, hash: string, lang: 'tikz' | 'tikzcd', source: string): Promise<TikzResult> {
  const { bin, cacheDir } = tex!
  const cached = `${cacheDir}/${hash}.svg`
  if (await $.fs.exists(cached)) return { svg: await $.fs.read(cached) }

  const dir = `${cacheDir}/build/${hash}`
  await $.fs.write(`${dir}/d.tex`, documentFor(lang, source))
  const latex = await $.process.run(
    [`${bin}/latex`, '-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'd.tex'],
    { cwd: dir, timeoutMs: 60000 },
  )
  if (latex.exitCode !== 0) return { error: texError(latex.stdout) }
  const dvisvgm = await $.process.run(
    [`${bin}/dvisvgm`, '--no-fonts', '--exact-bbox', '--zoom=1.3', 'd.dvi', '-o', 'd.svg'],
    { cwd: dir, timeoutMs: 30000 },
  )
  if (dvisvgm.exitCode !== 0) return { error: dvisvgm.stderr.trim().split('\n').slice(-3).join('\n') }
  const svg = themeInk(await $.fs.read(`${dir}/d.svg`))
  await $.fs.write(cached, svg)
  return { svg }
}

// Compiles one queued block. Returns true when a result is new.
async function drainOne($: Engine): Promise<boolean> {
  const job = tex && takeNext()
  if (!job) return false
  let result: TikzResult
  try {
    result = await compileTikz($, job.hash, job.lang, job.source)
  } catch (error) {
    result = { error: String(error) }
  }
  setResult(job.hash, result)
  return true
}

export const register: Register = (on, options) => {
  const scheme = (['light', 'dark'].includes(String(options.colorScheme))
    ? options.colorScheme
    : 'auto') as ColorScheme
  const tikzOn = options.tikz !== false
  const renderUser = options.userMessages !== false

  on('session.start', async ($, e, next) => {
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const macrosPath = String(options.macrosFile || '~/.claude/latex-macros.tex').replace(/^~(?=\/)/, home)
    try {
      if (await $.fs.exists(macrosPath)) {
        const error = definePreamble(await $.fs.read(macrosPath))
        if (error) $.ui.log(`latex: ${macrosPath}: ${error}`)
      }
    } catch {
      // No file system here (tests, a remote host): no macros.
    }

    if (tikzOn) {
      const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''
      const ready = await findTex($, home, path).catch(() => false)
      if (ready) {
        let busy = false
        $.clock.every(250, () => {
          if (busy || !hasQueued()) return
          busy = true
          void drainOne($)
            .then(isNew => {
              if (isNew) $.ui.invalidate('ui.render')
            })
            .finally(() => {
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
    const pieces = parse(e.props.text, { tikz: tikzOn && tex !== null })
    if (!pieces.some(p => p.kind !== 'md')) return next(e)

    const { Box, Text, Markdown, Svg, Button } = $.ui.resolve(e)

    const formula = (tex: string, display: boolean) => {
      const svg = renderTex(tex, display)
      if (svg) return <Svg source={withInk(svg, scheme)} alt={tex} />
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
          if (p.kind === 'tikz') {
            const hash = hashOf(p.lang, p.source)
            const result = tikzResult(hash)
            if (!result) requestTikz(hash, p.lang, p.source)
            return (
              <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
                {!result && <Text dimColor>Compiling diagram…</Text>}
                {result && 'svg' in result && <Svg source={withInk(result.svg, scheme)} alt={p.source} />}
                {result && 'error' in result && (
                  <Box flexDirection="column">
                    <Text color="red">TikZ did not compile:</Text>
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
