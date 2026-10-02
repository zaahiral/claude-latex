import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const SAMPLE = [
  'The loss is $L(\\boldsymbol{\\phi}) = \\sum_{i=1}^{I} (\\phi_0 + \\phi_1 x_i - y_i)^2$, and **its gradient** is',
  '',
  '$$\\frac{\\partial L}{\\partial \\phi_1} = 2\\sum_{i=1}^{I} x_i(\\phi_0 + \\phi_1 x_i - y_i) = 0.$$',
  '',
  'This costs $5 and $10.',
].join('\n')

const reply = (text: string) => ({ text, isFirstOfReply: true })

test('draws inline and display math as SVG on the desktop', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(SAMPLE) })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  // Copy TeX is off by default.
  expect(await ui.findAll({ type: 'Button' })).toHaveLength(0)
  expect(await ui.find({ type: 'Markdown', text: /costs \$5 and \$10/ })).toBeDefined()
  await ui.unmount()
})

test('leaves dollar amounts to the app', async ($, on) => {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('It costs $5 and $10 today.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /engine drew/ })).toBeDefined()
  await ui.unmount()
})

test('keeps math inside code blocks as code', async $ => {
  const text = 'Run this:\n\n```bash\necho "$HOME and $PATH"\n```\n\nThen $x^2$.'
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  expect(await ui.find({ type: 'Markdown', text: /echo/ })).toBeDefined()
  await ui.unmount()
})

test('shows a bad formula as red source', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('Broken: $\\frac{a$ here.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  await ui.unmount()
})

test('renders math in the messages you send', async $ => {
  const ui = await $.ui.mount({
    plugin: 'latex',
    surface: 'desktop',
    component: 'UserMessage',
    props: { text: 'why is $\\mathbb{E}[X^2] \\ge \\mathbb{E}[X]^2$?', origin: { kind: 'composer' }, isExpanded: true } as never,
  })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('lays out lists with inline math', async $ => {
  const text = '- first $a_1$\n- second $a_2$\n1. third $a_3$'
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})

test('maps \\bm to bold math', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('A vector $\\bm{x} \\in \\mathbb{R}^n$.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('draws chemistry with mhchem', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('$$\\ce{CO2 + H2O <=> H2CO3}$$') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('shows an unknown command as red source, not as an SVG', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('Try $\\notacommand{x}$ now.') })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
  expect(await ui.find({ type: 'Text', text: /notacommand/ })).toBeDefined()
  await ui.unmount()
})

// A fake TeX install: latex writes d.dvi, dvisvgm writes one SVG per page.
function fakeTex(on: On, pages = 1) {
  const files = new Map<string, string>()
  const runs: string[][] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', async ($, e) => ({ value: e.path.startsWith('/Library/TeX/texbin/') || files.has(e.path) }))
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', async ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.list', async ($, e) => ({
    value: [...files.keys()]
      .filter(p => p.startsWith(e.path + '/'))
      .map(p => ({ name: p.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('process.run', async ($, e) => {
    runs.push([...e.argv])
    const cwd = e.init?.cwd ?? ''
    if (e.argv.includes('-ini')) {
      const job = e.argv.find(a => a.startsWith('-jobname='))?.slice('-jobname='.length)
      files.set(`${cwd}/${job}.fmt`, 'format')
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[0] === '/bin/mv') {
      const [from, to] = [e.argv[1] ?? '', e.argv[2] ?? '']
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    }
    if (e.argv[0]?.endsWith('/latex')) files.set(`${cwd}/d.dvi`, 'dvi')
    if (e.argv[0]?.endsWith('/dvisvgm')) {
      if (e.argv.includes('d.svg')) files.set(`${cwd}/d.svg`, "<svg width='10pt' height='5pt'><path d=''/></svg>")
      else for (let i = 1; i <= pages; i++) files.set(`${cwd}/d-${i}.svg`, `<svg width='${i}pt' height='5pt'></svg>`)
    }
    if (e.argv[0] === '/bin/rm') for (const p of [...files.keys()]) if (p.startsWith(e.argv[2] + '/')) files.delete(p)
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { files, runs }
}

test('a LaTeX block redraws by itself once compiled', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test', PATH: '' })
  const { runs } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const text = 'A square:\n\n```tikzcd\nA \\arrow[r] & B\n```'
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.find({ type: 'Text', text: /Compiling with LaTeX/ })).toBeDefined()
  for (let i = 0; i < 3; i++) await clock.advance(100)
  expect(runs.some(argv => argv[0]?.endsWith('/latex'))).toBe(true)
  // The compile used a saved format, built once in the background.
  expect(runs.some(argv => argv.includes('-ini'))).toBe(true)
  expect(runs.some(argv => argv.some(a => a.startsWith('-fmt=')))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Compiling with LaTeX/ })).toBeUndefined()
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('compiles blocks side by side, each in its own folder', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test', PATH: '' })
  const { runs } = fakeTex(on)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const text = ['```tikz', '\\draw (0,0) -- (1,1);', '```', '', '```latex', '\\usepackage{bussproofs}', 'x', '```', '', '```tikzcd', 'A & B', '```'].join('\n')
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  await clock.advance(100)
  await clock.advance(100)
  const latexRuns = runs.filter(argv => argv[0]?.endsWith('/latex') && !argv.includes('-ini'))
  expect(latexRuns).toHaveLength(3)
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})

test('with a LaTeX font, typesets a message in one run and swaps it in', { options: { mathFont: 'palatino' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { HOME: '/Users/test', PATH: '' })
  const { runs, files } = fakeTex(on, 2)
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('Both $a^2$ and $b^2$ here.') })
  const before = await ui.findAll({ type: 'Svg' })
  expect(before).toHaveLength(2)
  expect(String(before[0]?.props.source)).toContain('viewBox')
  await clock.advance(100)
  await clock.advance(100)
  expect(runs.filter(argv => argv[0]?.endsWith('/latex') && !argv.includes('-ini'))).toHaveLength(1)
  const source = [...files.entries()].find(([p]) => p.endsWith('.svg') && p.includes('/m-'))
  expect(source).toBeDefined()
  const after = await ui.findAll({ type: 'Svg' })
  expect(after.map(s => String(s.props.source).match(/width='(\d)pt'/)?.[1])).toEqual(['1', '2'])
  await ui.unmount()
})

test('draws Copy TeX buttons when the setting is on', { options: { copyButton: true } }, async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply('$$a^2 + b^2 = c^2$$') })
  expect(await ui.find({ type: 'Button', key: 'copy-0' })).toBeDefined()
  await ui.unmount()
})

const own = (text: string) => ({ text, origin: { kind: 'composer' }, isExpanded: true }) as never

test('renders your own message as Markdown and keeps its line breaks', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'UserMessage', props: own('**bold** and a list:\n- one\n- two\nline one\nline two') })
  const md = await ui.find({ type: 'Markdown' })
  expect(md).toBeDefined()
  expect(String(md?.props.text)).toContain('line one  \nline two')
  await ui.unmount()
})

test('leaves your messages to the app when Markdown is off', { options: { userMarkdown: false } }, async ($, on) => {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'UserMessage', props: own('**bold**') })
  expect(await ui.find({ type: 'Text', text: /engine drew/ })).toBeDefined()
  await ui.unmount()
})

test('leaves task notifications to the app', async ($, on) => {
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  const props = { text: '**done**', origin: { kind: 'task-notification' }, isExpanded: true } as never
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'UserMessage', props })
  expect(await ui.find({ type: 'Text', text: /engine drew/ })).toBeDefined()
  await ui.unmount()
})

test('shows the welcome band once, and Got it remembers', async ($, on) => {
  mock.store(on)
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('config.list', async () => ({ value: [] }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine drew this</Text>
  })
  const bandProps = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 80 } as never
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
  expect(await band.find({ type: 'Text', text: /LaTeX mod is on/ })).toBeDefined()
  await band.press({ key: 'intro-dismiss' })
  expect(await band.find({ type: 'Text', text: /LaTeX mod is on/ })).toBeUndefined()
  await band.unmount()
  // A new session reads the store and keeps the band hidden.
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const again = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
  expect(await again.find({ type: 'Text', text: /LaTeX mod is on/ })).toBeUndefined()
  await again.unmount()
})

test('the settings pane changes the real settings', async ($, on) => {
  const sets: unknown[] = []
  on('session.start', async ($, e) => ({ cwd: e.cwd }))
  on('config.list', async () => ({ value: [{ key: 'latex.copyButton', label: 'Copy TeX button', kind: 'boolean', value: false, provider: { kind: 'plugin', name: 'latex' }, isLocked: false }] as never }))
  on('config.set', async ($, e) => {
    sets.push(e)
    return { value: { value: e.value } as never }
  })
  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const pane = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'Pane', props: { title: 'LaTeX settings', isFocused: true, bodyColumns: 60, placement: 'dock' } as never, requestId: 'latex-settings' } as never)
  expect(await pane.find({ type: 'Select', key: 'math-font' })).toBeDefined()
  await pane.press({ key: 'toggle-copyButton' })
  expect(sets).toEqual([expect.objectContaining({ key: 'latex.copyButton', value: true })])
  await pane.unmount()
})
