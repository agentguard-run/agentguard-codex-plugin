// AgentGuard Live, the mod in hooks/agentguard-live.mjs: the band, the stamp
// under each sub-agent launch and the pane draw what runtime/mod-status.cjs
// reports, the mod never decides anything, and it does no work where nothing
// draws. Run with `claude plugin test`.
import { expect, mock, test } from 'claude-code/testing'

const TEAL = '#2abcb4'

const STATUS = {
  v: 1, ok: true, sessionId: 'abc123', at: '2026-10-01T19:00:00.000Z',
  burn: {
    mode: 'enforce',
    burst: { count: 9, limit: 15, windowActiveMinutes: 15, enforced: true },
    sustained: { count: 22, limit: 40, windowActiveMinutes: 120 },
    tokens: { used: 1_200_000_000, limit: 5_000_000_000 },
    spawns: 31, running: 1, seen: true,
  },
  ledger: {
    license: { tier: 'free', paid: false, mode: 'enforce' },
    ledger: { entries: 1052, verified: true, signer: 'fbe6879b5757956f' },
    launches: { 'tu-asked': { sequence: 1051, result: 'asked you' }, 'tu-started': { sequence: 1043, result: 'started' } },
    recorded: 40, asked: 1, stopped: 1,
    decisions: [
      { sequence: 1051, at: '2026-10-01T18:59:00.000Z', tool: 'Agent', result: 'asked you', reason: 'burn_stop' },
      { sequence: 1049, at: '2026-10-01T18:58:00.000Z', tool: 'Bash', result: 'stopped', reason: 'guard_pack' },
      { sequence: 1043, at: '2026-10-01T18:57:00.000Z', tool: 'Task', result: 'started', reason: 'burn_ok' },
    ],
  },
}

const VIEWPORT = { columns: 140, rows: 40 }

const BAND = {
  plugin: 'agentguard', component: 'AbovePrompt', surface: 'terminal', viewport: VIEWPORT,
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 130, scroll: { offset: 0, bodyRows: 1 }, view: {} },
} as const

const PANE = {
  plugin: 'agentguard', component: 'Pane', requestId: 'agentguard', surface: 'terminal', viewport: VIEWPORT,
  props: { title: 'AgentGuard', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function row(tool: string, id: string, state: Record<string, unknown> = {}) {
  return {
    plugin: 'agentguard', component: 'ToolUse', requestId: id, surface: 'terminal', viewport: VIEWPORT,
    props: { tool_use_id: id, tool, input: {}, isRunning: true, isErrored: false, isInterrupted: false, ...state },
  } as const
}

function withStatus(on: any, status: any, runs: string[][] = [], render?: (e: any) => any) {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [{ kind: 'five_hour', percentUsed: 54, resetsAt: '2026-10-01T20:40:00.000Z' }], cost: 0 } }))
  on('process.run', ($: any, e: any) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '' } }
  })
  // What Claude Code and later mods would draw at a site
  on('ui.render', ($: any, e: any) => (render ? render(e) : null) ?? { type: 'Text', props: {}, children: ['drawn by Claude Code'] })
  return runs
}

const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

test('the band shows the sub-agent count, tokens and plan use, and keeps what other mods draw', async ($, on) => {
  const runs = withStatus(on, STATUS)
  await start($)
  expect(runs[0].slice(-2)).toEqual(['--session', 'abc123'])
  expect(runs[0][1]).toMatch(/runtime\/mod-status\.cjs$/)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: 'AgentGuard ' }))?.props.backgroundColor).toBe(TEAL)
  expect(await ui.find({ type: 'Text', text: /sub-agents 9 of 15/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /tokens 1\.2B of 5B/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5-hour 54%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('the window closer to its limit leads and is red at ninety percent', async ($, on) => {
  const near = structuredClone(STATUS)
  near.burn.burst.count = 3
  near.burn.sustained.count = 39
  withStatus(on, near)
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: / sub-agents 39 of 40/ }))?.props.color).toBe('red')
  await ui.unmount()
})

test('at the limit the count is red', async ($, on) => {
  const full = structuredClone(STATUS)
  full.burn.burst.count = 15
  withStatus(on, full)
  await start($)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: / sub-agents 15 of 15/ }))?.props.color).toBe('red')
  await ui.unmount()
})

test('a sixty-column terminal shortens labels and keeps the four default values', async ($, on) => {
  withStatus(on, STATUS)
  await start($)
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /a 9\/15/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\.2B\/5B/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5h 54%/ })).toBeDefined()
  await ui.unmount()
})

test('when the status cannot be read, the band says so instead of showing numbers', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.usage', () => ({ deny: 'not in this test' }))
  on('process.run', () => ({ deny: 'node is not installed' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /status unavailable/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sub-agents \d/ })).toBeUndefined()
  await ui.unmount()
})

test('where nothing draws, such as claude -p, the mod runs nothing', async ($, on) => {
  const runs = withStatus(on, STATUS)
  await $.session.start({ surface: 'terminal', isInteractive: false, cwd: '/work' })
  const ui = await $.ui.mount(BAND)
  expect(runs.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /AgentGuard/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  await ui.unmount()
})

test('AGENTGUARD_LIVE=0 turns the band off and runs nothing', async ($, on) => {
  const runs = withStatus(on, STATUS)
  mock.env(on, { AGENTGUARD_LIVE: '0' })
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(runs.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /AgentGuard/ })).toBeUndefined()
  await ui.unmount()
})

test('requests by sub-agents count toward their share of the tokens', async ($, on) => {
  withStatus(on, STATUS)
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: e.agentId ? 300 : 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })
  await start($)
  for (const agentId of [undefined, 'sub-1']) {
    const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-test', messageCount: 1, ...(agentId ? { agentId } : {}) })
    let step = await stream.next()
    while (step.done !== true) step = await stream.next()
  }
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /75% to sub-agents/ })).toBeDefined()
  await ui.unmount()
})

test('a launch the gate signed as started is stamped ALLOWED under its own row, with the count at launch', async ($, on) => {
  const status: any = structuredClone(STATUS)
  status.ledger.launches['tu-new'] = { sequence: 1052, result: 'started' }
  withStatus(on, status)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  const decision = await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 'tu-new' })
  expect(decision).toMatchObject({ decision: 'allow' })
  const ui = await $.ui.mount(row('Agent', 'tu-new'))
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: ' ALLOWED ' }))?.props.backgroundColor).toBe('green')
  expect(await ui.find({ type: 'Text', text: /sub-agents 9 of 15 at launch · signed #1052/ })).toBeDefined()
  await ui.unmount()
})

test('a launch with no signed row gets no stamp, whatever Claude Code decided', async ($, on) => {
  withStatus(on, STATUS)
  on('tool.check', () => ({ decision: 'allow' }))
  await start($)
  await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 'tu-unsigned' })
  const ui = await $.ui.mount(row('Agent', 'tu-unsigned'))
  expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /AgentGuard/ })).toBeUndefined()
  await ui.unmount()
})

test('an asked launch reads ASKED YOU with its signed row, and YOU SAID NO once the dialog refused it', async ($, on) => {
  withStatus(on, STATUS)
  await start($)
  let ui = await $.ui.mount(row('Agent', 'tu-asked', { isRunning: false }))
  expect((await ui.find({ type: 'Text', text: ' ASKED YOU ' }))?.props.backgroundColor).toBe('yellow')
  expect(await ui.find({ type: 'Text', text: /signed #1051/ })).toBeDefined()
  await ui.unmount()
  ui = await $.ui.mount(row('Agent', 'tu-asked', { isRunning: false, isErrored: true }))
  expect((await ui.find({ type: 'Text', text: ' YOU SAID NO ' }))?.props.backgroundColor).toBe('red')
  await ui.unmount()
})

test('rows of other tools, and launches AgentGuard knows nothing about, are left as Claude Code draws them', async ($, on) => {
  withStatus(on, STATUS)
  await start($)
  for (const drawn of [row('Bash', 'tu-started'), row('Agent', 'tu-unknown')]) {
    const ui = await $.ui.mount(drawn)
    expect(await ui.find({ type: 'Text', text: 'drawn by Claude Code' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /AgentGuard/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('while Claude works, the spinner carries the sub-agent count', async ($, on) => {
  const suffixes: string[] = []
  withStatus(on, STATUS, [], (e) => {
    if (e.component === 'Spinner') suffixes.push(e.props.suffix)
    return null
  })
  await start($)
  const ui = await $.ui.mount({ plugin: 'agentguard', component: 'Spinner', requestId: 'main', surface: 'terminal', viewport: VIEWPORT,
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' } })
  expect(suffixes.at(-1)).toBe(' · sub-agents 9/15…')
  await ui.unmount()
})

test('/agentguard opens the pane with the signed rows as pills and verifies the signatures', async ($, on) => {
  const runs = withStatus(on, STATUS)
  const opened: any[] = []
  const closed: any[] = []
  on('ui.open', ($: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close', ($: any, e: any) => { closed.push(e); return { value: undefined } })
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  expect(opened[0].id).toBe('agentguard')
  expect(runs.at(-1)).toContain('--verify')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /9 of 15 in the last 15 active minutes/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: ' ASKED YOU ' }))?.props.backgroundColor).toBe('yellow')
    expect((await ui.find({ type: 'Text', text: ' STOPPED ' }))?.props.backgroundColor).toBe('red')
    expect(await ui.find({ type: 'Text', text: /1,052 signed rows · signatures verified/ })).toBeDefined()
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'close' })
    await ui.unmount()
  }
  expect(closed.length).toBe(2)
})

test('a sub-agent launch refreshes the counts, and Claude Code\'s decision passes through unchanged', async ($, on) => {
  const runs = withStatus(on, STATUS)
  let answer: any = { decision: 'ask', reason: 'AgentGuard: the sub-agent limit was reached' }
  on('tool.check', () => answer)
  await start($)
  const before = runs.length
  expect(await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 'tu-x' })).toEqual(answer)
  expect(runs.length).toBe(before + 1)
  for (answer of [{ decision: 'deny', reason: 'stopped' }, { decision: 'allow' }]) {
    expect(await $.tool.check({ tool: 'Task', input: {}, tool_use_id: 'tu-y' })).toEqual(answer)
  }
})

test('when the status script cannot run, a launch\'s decision still passes through unchanged', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [], cost: 0 } }))
  on('process.run', () => { throw new Error('node is missing') })
  on('tool.check', () => ({ decision: 'ask' }))
  await start($)
  expect(await $.tool.check({ tool: 'Agent', input: {}, tool_use_id: 'tu-z' })).toEqual({ decision: 'ask' })
})

test('the pane shows the work receipt of the last finished session, and no line when there is none', async ($, on) => {
  const status: any = structuredClone(STATUS)
  status.ledger.receipt = {
    sequence: 1050, at: '2026-10-01T18:40:00.000Z', sessionId: 'previous-session', version: 1, tokens: 1_200_000,
    subagents: { started: 3, finished: 2, endedWithoutFinishing: 1 }, decisions: { allowed: 39, asked: 2, saidYes: 1, stopped: 1 }, pluginVersion: '0.3.17',
  }
  withStatus(on, status)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Work receipt, last finished session \(.+\): 1\.2M tokens · 3 sub-agents · 42 decisions, 2 asked, 1 stopped · signed #1050$/ })).toBeDefined()
  delete status.ledger.receipt
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /Work receipt/ })).toBeUndefined()
  await ui.unmount()
})

test('after /clear the new session id is the one read', async ($, on) => {
  const runs = withStatus(on, STATUS)
  on('classic.SessionStart', () => ({}))
  await start($)
  await $.classic.SessionStart({ session_id: 'after-clear', source: 'clear', hook_event_name: 'SessionStart' })
  expect(runs.at(-1)?.slice(-2)).toEqual(['--session', 'after-clear'])
})

test('model buttons fill the prompt and leave the person to submit the command', async ($, on) => {
  withStatus(on, STATUS)
  const fills: any[] = []
  on('ui.close', () => ({ value: undefined }))
  on('prompt.fill', ($, e) => { fills.push(e); return { isFilled: true } })
  on('prompt.submit', () => { throw new Error('Model selection must never submit') })
  await start($)
  const ui = await $.ui.mount(PANE)
  for (const id of ['fable', 'opus', 'sonnet', 'claude-haiku-5-5']) {
    await ui.press({key: 'model:' + id})
    expect(fills.at(-1)?.text).toBe('/model ' + id)
    expect(fills.at(-1)?.mode).toBe('replace')
  }
  expect(fills.length).toBe(4)
  await ui.unmount()
})

test('PreModelSwitch shows the list price and preserves the host permission result', async ($, on) => {
  withStatus(on, STATUS)
  const lines: string[] = []
  on('ui.log', ($, e) => { lines.push(e.text); return { value: undefined } })
  const result = {permissionDecision: 'deny' as const, permissionDecisionReason: 'Fixture decision'}
  on('classic.PreModelSwitch', () => result)
  await start($)
  const event = {session_id:'abc123',hook_event_name:'PreModelSwitch' as const,from_model:'claude-opus-5-5',to_model:'claude-sonnet-5-5',requested_model:'sonnet',source:'command' as const,
    context_tokens:100000,prompt_cache_warm:true,cache_ttl:'5m' as const,estimated_cache_write_usd:0.25,pricing:'catalog' as const}
  expect(await $.classic.PreModelSwitch(event)).toEqual(result)
  expect(lines.some(line => line.includes('switching re-sends this chat, ≈ $0.25 at API list price'))).toBe(true)
})
