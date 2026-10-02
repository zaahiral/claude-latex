import { expect, test } from 'claude-code/testing'

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
