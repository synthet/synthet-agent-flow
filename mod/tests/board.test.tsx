import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SNAPSHOT = {
  initialized: true,
  actor: 'claude:abcd1234',
  ticket: {
    id: 'af-k3x9q',
    title: 'Add GET /api/orders with pagination',
    status: 'review',
    owner: 'claude:abcd1234',
    priority: 'p1',
    lease_until: null,
    branch: 'af/af-k3x9q-add-get-api-orders',
    blocked_reason: null,
    rework_count: 0,
    acceptance: [
      { ac_id: 'AC-1', text: 'returns 20 per page', verdict: 'Verified' },
      { ac_id: 'AC-2', text: 'bad params return 400', verdict: 'Unknown' },
    ],
    last_handoff: 'endpoint + tests done',
  },
  ready: [{ id: 'af-22p21', title: 'Write migration', priority: 'p0', lane: 'feature' }],
  counts: { ready: 1, review: 1, blocked: 0, needs_human: 0 },
  loop: null,
}

const PANE = {
  plugin: 'agent-flow-mod',
  component: 'Pane',
  requestId: 'agent-flow',
  props: { title: 'agent-flow', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'agent-flow-mod',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
} as const

function engine(on: On, snapshot: unknown = SNAPSHOT) {
  on('command.register', () => ({ value: { command: 'flow-board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'abcd1234-0000' }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  // Stands for the engine's own drawing when the mod hands a component on.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  mock.env(on, {})
  mock.clock(on, { now: Date.parse('2026-11-06T12:00:00Z') })
  on('process.run', (_, e) => {
    expect(e.argv.slice(0, 3)).toEqual(['agent-flow', 'snapshot', '--json'])
    return { value: { exitCode: 0, stdout: JSON.stringify(snapshot), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the pane shows the bound ticket, its AC verdicts and the ready queue', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'flow-board' } as never) // origin/presentation are engine-stamped
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /af-k3x9q · review/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /✔ AC-1 returns 20 per page/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /· AC-2 bad params return 400/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /af-22p21 \[p0\] Write migration/ }))).toBeDefined()
    await ui.unmount()
  }
})

test('the band asks for review while the ticket is in review, and hides on press', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'flow-board' } as never) // origin/presentation are engine-stamped
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /in review/ }))).toBeDefined()
  await ui.press({ key: 'hide' })
  expect((await ui.find({ type: 'Text', text: /in review/ }))).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: 'engine' }))).toBeDefined()
  await ui.unmount()
})

test('a repo without agent-flow says so', async ($, on) => {
  engine(on, { initialized: false })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'flow-board' } as never) // origin/presentation are engine-stamped
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /agent-flow init/ }))).toBeDefined()
  await ui.unmount()
})
