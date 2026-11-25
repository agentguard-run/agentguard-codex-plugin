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

// 0.7.2: the band also says how many rows of the signed ledger there are. "signed" is a count and claims nothing
// more; "verified" appears only after a signature check ran in this session. A large ledger is never checked by
// itself, and its check runs without holding up the band.
function withRuns(on: any, answer: (argv: string[]) => any, seen: any[] = []) {
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'abc123' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 0, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', async ($: any, e: any) => {
    seen.push(e)
    const out = await answer(e.argv)
    if (out instanceof Error) throw out
    return { value: { exitCode: 0, stdout: JSON.stringify(out), stderr: '' } }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  return seen
}
const sized = (entries: number, verified: boolean | null = null) => {
  const s = structuredClone(STATUS) as any
  s.ledger.ledger = { entries, verified, signer: 'fbe6879b5757956f' }
  return s
}
// A check started in the background is given a few turns of the event loop to finish.
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 5)) }
const bandText = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((node: any) => String(node.children?.[0] ?? '')).join('')

test('the band counts the signed rows, before the /agentguard hint, and does not call them verified', async ($, on) => {
  // The status program reports verified: true here, as it would after someone else's check. A plain refresh must
  // not turn that into a claim: only a check this session ran counts.
  const seen = withRuns(on, () => sized(432663, true))
  await start($)
  const ui = await $.ui.mount(BAND)
  const part = await ui.find({ type: 'Text', text: ' · 433K signed' })
  expect(part).toBeDefined()
  expect(part?.props.dimColor).toBe(true)
  const all = await bandText(ui)
  expect(all).not.toMatch(/verified/)
  expect(all.indexOf('433K signed')).toBeLessThan(all.indexOf('/agentguard'))
  expect(all.indexOf('433K signed')).toBeGreaterThan(all.indexOf('tokens'))
  expect(seen.every((e: any) => !e.argv.includes('--verify'))).toBe(true)
  await ui.unmount()
})

test('a narrow terminal keeps the limits and leaves the signed count out; no ledger, no count', async ($, on) => {
  withRuns(on, () => sized(432663))
  await start($)
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 70 } })
  expect(await bandText(narrow)).not.toMatch(/signed/)
  expect(await narrow.find({ type: 'Text', text: /9\/15|9 of 15/ })).toBeDefined()
  await narrow.unmount()
})

test('with no ledger rows the band says nothing about signing', async ($, on) => {
  const none = structuredClone(STATUS) as any
  none.ledger = null
  withRuns(on, () => none)
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await bandText(ui)).not.toMatch(/signed|verified/)
  await ui.unmount()
})

test('opening the pane on a small ledger checks the signatures, and the band then says verified with the row count', async ($, on) => {
  const seen = withRuns(on, argv => sized(1052, argv.includes('--verify') ? true : null))
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  const checks = seen.filter((e: any) => e.argv.includes('--verify'))
  expect(checks.length).toBe(1)
  expect(checks[0].init?.timeoutMs).toBe(60000)
  const ui = await $.ui.mount(BAND)
  const part = await ui.find({ type: 'Text', text: /^ · 1\.1K verified \d\d:\d\d$/ })
  expect(part?.props.color).toBe('green')
  expect(await bandText(ui)).not.toMatch(/signed/)
  await ui.unmount()
})

test('a large ledger is not checked by opening the pane; pressing v checks it with time to finish', async ($, on) => {
  const seen: any[] = []
  withRuns(on, async argv => {
    if (!argv.includes('--verify')) return sized(432663)
    return sized(432663, true)
  }, seen)
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  expect(seen.some((e: any) => e.argv.includes('--verify'))).toBe(false)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /432,663 signed rows · press v to verify the signatures \(about 5 minutes\)/ })).toBeDefined()
  await pane.press({ key: 'verify' })
  const checks = seen.filter((e: any) => e.argv.includes('--verify'))
  expect(checks.length).toBe(1)
  // Four times the expected time would be 20 minutes; the host allows ten, and a plain read gets 15 seconds.
  expect(checks[0].init?.timeoutMs).toBe(600000)
  expect(seen.filter((e: any) => !e.argv.includes('--verify')).every((e: any) => e.init?.timeoutMs === 15000)).toBe(true)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /^ · 433K verified \d\d:\d\d$/ }))?.props.color).toBe('green')
  expect(await pane.find({ type: 'Text', text: /432,663 signed rows · signatures verified at \d\d:\d\d/ })).toBeDefined()
  await ui.unmount()
  await pane.unmount()
})

test('a failed signature check is red on the band, and a check that cannot run is never shown as verified', async ($, on) => {
  let mode = 'bad'
  const seen = withRuns(on, argv => !argv.includes('--verify') ? sized(1052) : mode === 'bad' ? sized(1052, false) : new Error('node is missing'))
  on('classic.SessionStart', () => ({}))
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  let ui = await $.ui.mount(BAND)
  const bad = await ui.find({ type: 'Text', text: ' · signature check FAILED' })
  expect(bad?.props.color).toBe('red')
  expect(await bandText(ui)).not.toMatch(/verified \d/)
  await ui.unmount()
  // A new session starts clean, and a check that throws leaves "signed", with the pane saying it did not finish.
  mode = 'throw'
  await $.classic.SessionStart({ session_id: 'next-session', source: 'clear', hook_event_name: 'SessionStart' })
  await $.command.run({ command: 'agentguard', args: '' })
  ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: ' · 1.1K signed' })).toBeDefined()
  expect(await bandText(ui)).not.toMatch(/verified|FAILED/)
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /the signature check did not finish\. Press v to try again\./ })).toBeDefined()
  expect(seen.filter((e: any) => e.argv.includes('--verify')).length).toBe(2)
  await ui.unmount()
  await pane.unmount()
})

for (const [rows, limit] of [[20001, 60000], [100000, 280000], [432663, 600000], [685000, 600000]] as const) {
  test(`a check of ${rows} rows asks for ${limit} ms: never under a minute, never more than the host allows`, async ($, on) => {
    const seen = withRuns(on, argv => sized(rows, argv.includes('--verify') ? true : null))
    await start($)
    const pane = await $.ui.mount(PANE)
    await pane.press({ key: 'verify' })
    const checks = seen.filter((e: any) => e.argv.includes('--verify'))
    expect(checks.length).toBe(1)
    expect(checks[0].init?.timeoutMs).toBe(limit)
    await pane.unmount()
  })
}

test('while a check runs the band says so, a plain refresh still goes through, and no second check starts', async ($, on) => {
  // The band and the pane are looked at from inside the stand-in for the check itself.
  let during = '', plainDuring = -1, checksDuring = -1
  const seen: any[] = []
  withRuns(on, async argv => {
    if (!argv.includes('--verify')) return sized(432663)
    const band = await $.ui.mount(BAND)
    during = await bandText(band)
    await band.unmount()
    const before = seen.filter((e: any) => !e.argv.includes('--verify')).length
    await $.command.run({ command: 'agentguard', args: '' })
    plainDuring = seen.filter((e: any) => !e.argv.includes('--verify')).length - before
    checksDuring = seen.filter((e: any) => e.argv.includes('--verify')).length
    return sized(432663, true)
  }, seen)
  await start($)
  const pane = await $.ui.mount(PANE)
  await pane.press({ key: 'verify' })
  expect(during).toMatch(/ · 433K signed, checking signatures · \/agentguard/)
  expect(during).not.toMatch(/verified/)
  expect(plainDuring).toBe(1)
  expect(checksDuring).toBe(1)
  const ui = await $.ui.mount(BAND)
  expect(await bandText(ui)).toMatch(/ · 433K verified \d\d:\d\d · \/agentguard/)
  await ui.unmount()
  await pane.unmount()
})

test('a ledger whose check cannot finish in ten minutes is not started, and the pane says how to check it', async ($, on) => {
  const seen = withRuns(on, argv => sized(900000, argv.includes('--verify') ? true : null))
  await start($)
  await $.command.run({ command: 'agentguard', args: '' })
  const pane = await $.ui.mount(PANE)
  expect(await pane.find({ type: 'Text', text: /900,000 signed rows · too many to check from this pane \(about 11 minutes\)\. Ask Claude to run verify_chain/ })).toBeDefined()
  await pane.press({ key: 'verify' })
  expect(seen.some((e: any) => e.argv.includes('--verify'))).toBe(false)
  expect(await pane.find({ type: 'Text', text: /did not finish/ })).toBeUndefined()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: ' · 900K signed' })).toBeDefined()
  expect(await bandText(ui)).not.toMatch(/verified|checking/)
  await ui.unmount()
  await pane.unmount()
})
