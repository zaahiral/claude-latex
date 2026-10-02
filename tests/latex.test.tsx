import { expect, mock, test } from 'claude-code/testing'

const SAMPLE = [
  'The loss is $L(\\boldsymbol{\\phi}) = \\sum_{i=1}^{I} (\\phi_0 + \\phi_1 x_i - y_i)^2$, and **its gradient** is',
  '',
  '$$\\frac{\\partial L}{\\partial \\phi_1} = 2\\sum_{i=1}^{I} x_i(\\phi_0 + \\phi_1 x_i - y_i) = 0.$$',
  '',
  'This costs $5 and $10.',
].join('\n')

const reply = (text: string) => ({ text, isFirstOfReply: true })

test('draws inline and display maths as SVG on the desktop', async $ => {
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(SAMPLE) })
  const svgs = await ui.findAll({ type: 'Svg' })
  expect(svgs).toHaveLength(2)
  expect(await ui.find({ type: 'Button', key: 'copy-1' })).toBeDefined()
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

test('keeps maths inside code blocks as code', async $ => {
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

test('renders maths in the messages you send', async $ => {
  const ui = await $.ui.mount({
    plugin: 'latex',
    surface: 'desktop',
    component: 'UserMessage',
    props: { text: 'why is $\\mathbb{E}[X^2] \\ge \\mathbb{E}[X]^2$?', origin: { kind: 'composer' }, isExpanded: true } as never,
  })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(1)
  await ui.unmount()
})

test('lays out lists with inline maths', async $ => {
  const text = '- first $a_1$\n- second $a_2$\n1. third $a_3$'
  const ui = await $.ui.mount({ plugin: 'latex', surface: 'desktop', component: 'AssistantMessage', props: reply(text) })
  expect(await ui.findAll({ type: 'Svg' })).toHaveLength(3)
  await ui.unmount()
})

test('maps \\bm to bold maths', async $ => {
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
function fakeTex(on: Parameters<Parameters<typeof test>[1]>[1], pages = 1) {
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
    if (e.argv[0]?.endsWith('/latex')) files.set(`${cwd}/d.dvi`, 'dvi')
    if (e.argv[0]?.endsWith('/dvisvgm')) {
      if (e.argv.includes('d.svg')) files.set(`${cwd}/d.svg`, "<svg width='10pt' height='5pt'><path d=''/></svg>")
      else for (let i = 1; i <= pages; i++) files.set(`${cwd}/d-${i}.svg`, `<svg width='${i}pt' height='5pt'></svg>`)
    }
    if (e.argv[0] === '/bin/rm') for (const p of [...files.keys()]) if (p.startsWith(e.argv[2] + '/')) files.delete(p)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
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
  const latexRuns = runs.filter(argv => argv[0]?.endsWith('/latex'))
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
  expect(runs.filter(argv => argv[0]?.endsWith('/latex'))).toHaveLength(1)
  const source = [...files.entries()].find(([p]) => p.endsWith('.svg') && p.includes('/m-'))
  expect(source).toBeDefined()
  const after = await ui.findAll({ type: 'Svg' })
  expect(after.map(s => String(s.props.source).match(/width='(\d)pt'/)?.[1])).toEqual(['1', '2'])
  await ui.unmount()
})
