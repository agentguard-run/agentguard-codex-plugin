import {formatStatusFields} from './generated/status-fields.mjs'
import {quickModels, nextCheaperQuickModel, switchNotice} from './quick-models.mjs'

// AgentGuard Live: a band above the prompt, a stamp under each sub-agent
// launch and a pane, drawn from what AgentGuard's gates decided. The band shows
// how close this session is to its sub-agent limits and its token limit, the
// share of tokens that went to sub-agents, and plan usage. Each launch's row in
// the conversation gets AgentGuard's word on it: allowed, asked, stopped, with
// its signed ledger row. The pane lists each launch, ask and stop, and the
// work receipt of the last finished session.
// Nothing here decides or blocks. The plugin's settings hooks enforce, the
// same way in Codex and in Claude Code without mods; this module only reads
// and draws. Every permission decision passes through unchanged: the one
// permission hook below returns next(e). The only program it runs is
// `node <plugin>/runtime/mod-status.cjs --session <id>` (plus `--verify` when
// the person asks for the signature check), which reads local files and
// prints JSON. The module opens no network connection and sends nothing.

const PANE = 'agentguard'
const REFRESH_MS = 20000
const TEAL = '#2abcb4'
const INK = '#04201e'                 // dark text on a light pill
const SPAWN_TOOLS = ['Task', 'Agent']

let active = true            // false where nothing draws: claude -p, the VS Code panel
let sessionId = null
let status = null            // the last answer from runtime/mod-status.cjs
let failed = false           // the last refresh could not run
let verified = null          // { ok, rows, at } from the last signature check
let busy = false
let again = false
let againVerify = false
let stale = false            // a model request finished since the last refresh
let usage = null             // $.session.usage(), for plan limits
let usageSamples = []
let statusFields = ''
let detailsOpen = false
let modelChoices = quickModels()
let currentModel = null
let highPlanUsage = false
let compactThreshold = null  // tokens at which Claude Code auto-compacts, from $.session.usage({ breakdown })
let thresholdAt = 0
let thresholdWindow = null   // the model window that point was read under; a different window means a model change
let liveContext = null       // the last context reading, kept apart from the plan-limit validation below
let compactWarned = false    // one toast per approach to the compaction point
const live = { main: 0, sub: 0 }  // tokens per request since this session opened
const stamps = new Map()     // tool_use_id -> the sub-agent count when it launched

function compact(n) {
  if (typeof n !== 'number' || !isFinite(n)) return '0'
  const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, unit] of units) {
    if (n >= size) return (n / size).toFixed(n >= size * 10 ? 0 : 1).replace(/\.0$/, '') + unit
  }
  return String(Math.round(n))
}

function grouped(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function level(count, limit) {
  if (!limit) return 'ok'
  const ratio = count / limit
  return ratio >= 0.9 ? 'over' : ratio >= 0.7 ? 'near' : 'ok'
}

const COLOR = { ok: null, near: 'yellow', over: 'red' }
const THRESHOLD_MS = 120000   // the compaction point moves only with the model or settings
const WARN_LEFT = 10          // percent of context left that raises the one warning
const REARM_LEFT = 50         // a compaction brings the context back under this

// The live main-conversation context against the point where Claude Code
// auto-compacts. Both figures are Claude Code's own; null until both exist,
// and null again while a model change waits for the point to be read anew.
function contextFigure() {
  const tokens = liveContext && liveContext.tokens
  if (!Number.isFinite(tokens) || !compactThreshold) return null
  if (thresholdWindow !== null && Number.isFinite(liveContext.window) && liveContext.window !== thresholdWindow) return null
  return { tokens, threshold: compactThreshold }
}

function contextLeft(figure) {
  return Math.max(0, Math.round(100 - (100 * figure.tokens) / figure.threshold))
}

// The /context breakdown carries the compaction point. Its summary form is
// estimated locally and sends no request. The usual read is the plain one;
// every two minutes the one read asks for the summary and takes the point
// from it, so idle polling still costs one host read per tick. A plain read
// that shows a different model window reads the point again at once, so a
// model change never counts down against the old model's point.
async function readHostUsage($) {
  if (Date.now() - thresholdAt >= THRESHOLD_MS) return readCompactionPoint($)
  const value = await $.session.usage()
  const window = value && value.context && value.context.window
  if (compactThreshold !== null && Number.isFinite(window) && window !== thresholdWindow) return readCompactionPoint($)
  return value
}

async function readCompactionPoint($) {
  thresholdAt = Date.now()
  let value
  try { value = await $.session.usage({ breakdown: 'summary' }) }
  catch { value = await $.session.usage() /* a Claude Code without the breakdown: the field stays hidden */ }
  const breakdown = value && value.context && value.context.breakdown
  compactThreshold = breakdown && breakdown.isAutoCompactEnabled && Number.isFinite(breakdown.autoCompactThreshold) && breakdown.autoCompactThreshold > 0
    ? breakdown.autoCompactThreshold : null
  thresholdWindow = value && value.context && Number.isFinite(value.context.window) ? value.context.window : null
  return value
}

// One toast and one notification as the context nears the compaction point,
// armed again once a compaction has brought it back down. Display only: the
// conversation, the model and every decision are untouched. Nothing here is
// awaited: the person's own Notification hooks run before the channel writes,
// and a sub-agent launch's refresh must never wait on them.
function warnCompact($) {
  const figure = contextFigure()
  if (!figure) return
  const left = contextLeft(figure)
  if (left > REARM_LEFT) compactWarned = false
  if (!active || compactWarned || left > WARN_LEFT) return
  compactWarned = true
  const text = left + '% of context left before Claude Code auto-compacts. Finish this step, or type /compact and say what to keep.'
  try { $.ui.toast(text, { timeoutMs: 15000 }) } catch { /* a surface without toasts */ }
  try { Promise.resolve($.ui.notify(text, { title: 'AgentGuard' })).catch(() => {}) } catch { /* notifications off or refused */ }
}

// A filled label, like the coloured agent names Claude Code draws
function pill(label, background) {
  return { text: ' ' + label + ' ', background, color: background === 'red' ? 'white' : INK, bold: true }
}

function clock(at) {
  const time = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at)
  return isNaN(time.getTime()) ? '' : time.toTimeString().slice(0, 8)
}

const PLAN_NAMES = { five_hour: '5-hour', seven_day: 'weekly', seven_day_opus: 'weekly Opus', seven_day_sonnet: 'weekly Sonnet' }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function planName(kind) {
  return PLAN_NAMES[kind] || String(kind || 'plan').replace(/_/g, ' ')
}

// A reset later today shows its time; a later day shows the date too
function resets(at) {
  const time = new Date(typeof at === 'number' && at < 1e12 ? at * 1000 : at)
  if (isNaN(time.getTime())) return ''
  const hours = time.toTimeString().slice(0, 5)
  return time.toDateString() === new Date().toDateString() ? hours : MONTHS[time.getMonth()] + ' ' + time.getDate() + ', ' + hours
}

// The highest plan limit Claude Code reports, such as the five-hour one
function planUsed() {
  let best = null
  for (const limit of (usage && usage.rateLimits) || []) {
    if (typeof limit.percentUsed === 'number' && (!best || limit.percentUsed > best.percentUsed)) best = limit
  }
  return best
}

function subShare() {
  const total = live.main + live.sub
  return total > 0 && live.sub > 0 ? Math.round((100 * live.sub) / total) : null
}

// The window closer to its limit is the one the band leads with
function leading(burn) {
  const ratio = (w) => (w.limit ? w.count / w.limit : 0)
  return ratio(burn.sustained) > ratio(burn.burst) ? burn.sustained : burn.burst
}

function text(part) {
  const props = { children: [part.text] }
  if (part.color) props.color = part.color
  if (part.background) props.backgroundColor = part.background
  if (part.bold) props.bold = true
  if (part.dim) props.dimColor = true
  if (part.truncate) props.wrap = 'truncate-end'
  return props
}

// Both the band and Burn statusline use the generated shared formatter.
function recordUsage(value) {
  const now = Date.now()
  if (!value || !Array.isArray(value.rateLimits)) return false
  const samples = []
  for (const limit of value.rateLimits) {
    const reset = typeof limit.resetsAt === 'number' && limit.resetsAt < 1e12 ? limit.resetsAt * 1000 : new Date(limit.resetsAt).getTime()
    if (typeof limit.kind !== 'string' || !Number.isFinite(limit.percentUsed) || !Number.isFinite(reset)) return false
    samples.push({name: limit.kind, usedPercent: limit.percentUsed, resetsAt: reset, observedAt: now, source: 'claude-statusline'})
  }
  usage = value
  // A successful empty reading clears removed windows. A failed reading never
  // removes the last good one, and its original observation time stays intact.
  usageSamples = usageSamples.filter(sample => sample.observedAt >= now - 600000 && samples.some(current => current.name === sample.name && current.resetsAt === sample.resetsAt))
  usageSamples.push(...samples)
  return true
}

async function readUsage($) {
  try { currentModel = await $.session.model() } catch { currentModel = null }
  try {
    const value = await readHostUsage($)
    // The context reading stands on its own: a plan window the host reports
    // without a reset time must not freeze the countdown.
    if (value && value.context && typeof value.context === 'object') liveContext = value.context
    const recorded = recordUsage(value)
    warnCompact($)
    if (!recorded) return
    const high = (planUsed()?.percentUsed ?? 0) >= 80
    const crossed = high && !highPlanUsage
    highPlanUsage = high
    if (active && crossed) {
      const model = nextCheaperQuickModel(currentModel, modelChoices)
      if (model) await $.prompt.suggest({text: '/model ' + model})
    }
  } catch { /* keep the last good reading and its age; never retry a suggestion above the threshold */ }
}

function formattedStatus(width = 200) {
  return formatStatusFields({burn: status && status.burn, share: subShare(), windows: usageSamples, context: contextFigure(),
    fields: statusFields, ...((status && status.fields) || {}), width, failed})
}

// What each decision reads as, as a pill
const RESULT_PILL = {
  'started': ['ALLOWED', 'green'],
  'allowed by you': ['YOU SAID YES', 'green'],
  'asked you': ['ASKED YOU', 'yellow'],
  'stopped': ['STOPPED', 'red'],
  'flagged': ['FLAGGED', 'yellow'],
}

// AgentGuard's word on one launch row: its signed ledger row, read with the
// row's own state for an asked launch (refused at the dialog, or running).
function stampFor(row) {
  const id = row.tool_use_id
  const signed = status && status.ledger && status.ledger.launches && status.ledger.launches[id]
  const seen = stamps.get(id)
  const result = signed ? signed.result : null
  if (!result) return null
  if (result === 'asked you') {
    if (row.isErrored || row.isInterrupted) return { label: ['YOU SAID NO', 'red'], seen, signed }
    if (!row.isRunning && row.output !== undefined) return { label: ['YOU SAID YES', 'green'], seen, signed }
  }
  return RESULT_PILL[result] ? { label: RESULT_PILL[result], seen, signed } : null
}

// The last finished session's work receipt, one line of its counts: what the
// receipt holds and nothing more, so a count it left out stays out
function receiptLine(receipt) {
  const parts = []
  if (typeof receipt.tokens === 'number') parts.push(compact(receipt.tokens) + ' tokens')
  const sub = receipt.subagents
  if (sub && typeof sub.started === 'number') parts.push(sub.started + (sub.started === 1 ? ' sub-agent' : ' sub-agents'))
  const d = receipt.decisions
  if (d && typeof d.allowed === 'number') {
    const total = d.allowed + d.asked + d.stopped
    const notes = []
    if (d.asked) notes.push(d.asked + ' asked')
    if (d.stopped) notes.push(d.stopped + ' stopped')
    parts.push(total + (total === 1 ? ' decision' : ' decisions') + (notes.length ? ', ' + notes.join(', ') : ''))
  }
  parts.push('signed #' + receipt.sequence)
  const when = receipt.at ? resets(receipt.at) : ''
  return 'Work receipt, last finished session' + (when ? ' (' + when + ')' : '') + ': ' + parts.join(' · ')
}

function paneLines() {
  const lines = [{ text: 'This session', bold: true }]
  const burn = status && status.burn
  const ledger = status && status.ledger
  if (!burn && !ledger) {
    lines.push({ text: failed ? 'AgentGuard could not read its status. Run /agentguard again, or check that node is on your PATH.' : 'Reading AgentGuard\'s status…', dim: true })
    return lines
  }
  if (burn) {
    lines.push({ text: 'Sub-agents: ' + burn.burst.count + ' of ' + burn.burst.limit + ' in the last ' + burn.burst.windowActiveMinutes + ' active minutes', color: COLOR[level(burn.burst.count, burn.burst.limit)], truncate: true })
    lines.push({ text: '            ' + burn.sustained.count + ' of ' + burn.sustained.limit + ' in the last ' + burn.sustained.windowActiveMinutes + ' · ' + burn.spawns + ' in all', color: COLOR[level(burn.sustained.count, burn.sustained.limit)], truncate: true })
    const pastLimit = burn.tokens.limit > 0 && burn.tokens.used >= burn.tokens.limit
    lines.push(pastLimit
      ? { text: 'Tokens: ' + compact(burn.tokens.used) + '. This session passed its ' + compact(burn.tokens.limit) + ' token limit' +
          (burn.mode === 'shadow' ? '. Watching only, so nothing waits.' : ', so each new sub-agent waits for your yes.'), color: 'red' }
      : { text: 'Tokens: ' + compact(burn.tokens.used) + ' of the ' + compact(burn.tokens.limit) + ' session limit', color: COLOR[level(burn.tokens.used, burn.tokens.limit)] })
    lines.push({ text: burn.mode === 'shadow' ? 'Mode: watching only. Limits are recorded and nothing waits.' : 'Mode: at a limit, the next launch waits for your yes.', dim: burn.mode !== 'shadow', color: burn.mode === 'shadow' ? 'yellow' : null })
  }
  const share = subShare()
  if (share !== null) lines.push({ text: 'Since this session opened: ' + compact(live.main) + ' tokens in the main conversation, ' + compact(live.sub) + ' in sub-agents (' + share + '%)' })
  for (const line of formattedStatus().panel) lines.push({text: line, dim: true})
  lines.push({text: 'Main chat model: ' + (currentModel || 'unavailable') + '. Choose a model below to fill the prompt, then press Enter.', dim: true})
  lines.push({ text: ' ' })
  lines.push({ text: 'Launches, asks and stops, newest first (each one a signed row)', bold: true })
  const rows = (ledger && ledger.decisions) || []
  if (!rows.length) lines.push({ text: 'None in this session yet.', dim: true })
  for (const row of rows.slice(0, 12)) {
    const label = RESULT_PILL[row.result]
    lines.push({ parts: [
      { text: clock(row.at) + '  ' + (row.tool || 'tool') + '  ', dim: true },
      label ? pill(label[0], label[1]) : { text: row.result, dim: true },
      { text: '  #' + row.sequence, dim: true },
    ] })
  }
  lines.push({ text: ' ' })
  if (ledger && ledger.receipt && typeof ledger.receipt.sequence === 'number') lines.push({ text: receiptLine(ledger.receipt), truncate: true })
  if (ledger) {
    const base = 'Ledger: ' + grouped(ledger.ledger.entries) + ' signed rows'
    if (verified && verified.ok) lines.push({ text: base + ' · signatures verified at ' + clock(verified.at).slice(0, 5), color: 'green', truncate: true })
    else if (verified && !verified.ok) lines.push({ text: base + ' · signature check FAILED', color: 'red', truncate: true })
    else lines.push({ text: base + ' · press v to verify the signatures', dim: true, truncate: true })
  }
  return lines
}

async function refresh($, verify) {
  if (!sessionId || !active) return
  if (busy) {
    again = true
    againVerify = againVerify || verify
    return
  }
  busy = true
  try {
    await readUsage($)
    // The whole command, written out: node runs the plugin's own read-only
    // status script for this session. Nothing else is ever run.
    const run = verify
      ? await $.process.run(['node', $.plugin.root + '/runtime/mod-status.cjs', '--session', sessionId, '--verify', '--fields', 'pace,cost,cache,spend'], { timeoutMs: 15000 })
      : await $.process.run(['node', $.plugin.root + '/runtime/mod-status.cjs', '--fields', detailsOpen ? 'pace,cost,cache,spend' : statusFields, '--session', sessionId], { timeoutMs: 15000 })
    const answer = JSON.parse(run.stdout)
    if (answer && answer.ok) {
      status = answer
      failed = false
      const check = answer.ledger && answer.ledger.ledger
      if (check && check.verified !== null && check.verified !== undefined) verified = { ok: check.verified === true, rows: check.entries, at: answer.at }
    } else failed = true
    stale = false
  } catch {
    failed = true
  }
  busy = false
  $.ui.invalidate('ui.render')
  if (again) {
    const nextVerify = againVerify
    again = false
    againVerify = false
    await refresh($, nextVerify)
  }
}

function newSession(id) {
  if (typeof id !== 'string' || id === sessionId) return
  sessionId = id
  live.main = 0
  live.sub = 0
  status = null
  verified = null
  stamps.clear()
  usageSamples = []
  usage = null
  currentModel = null
  highPlanUsage = false
  compactThreshold = null
  thresholdAt = 0
  thresholdWindow = null
  liveContext = null
  compactWarned = false
}

// The counts and the gate's signed row for a launch, and the count at launch
// for its stamp. The stamp's word comes from the signed row alone.
async function launched($, id) {
  await refresh($, false)
  if (!active || typeof id !== 'string') return
  const burn = status && status.burn
  const window = burn ? leading(burn) : null
  stamps.set(id, { count: window ? window.count : null, limit: window ? window.limit : null })
  $.ui.invalidate('ui.render')
}

export function register(on, options = {}) {
  statusFields = typeof options.status_fields === 'string' ? options.status_fields : ''
  modelChoices = quickModels(options.quick_models)
  on('session.start', async ($, e, next) => {
    // AGENTGUARD_LIVE=0 turns the band and pane off; the gates enforce either way
    let setting = null
    try { setting = await $.env.get('AGENTGUARD_LIVE') } catch { setting = null }
    active = setting !== '0' && e.isInteractive !== false && (!e.surface || e.surface === 'terminal' || e.surface === 'desktop')
    await $.command.register({ name: 'agentguard', description: "Show AgentGuard's limits and signed decisions for this session", immediate: true })
    if (active) {
      try { newSession(await $.session.id()) } catch { sessionId = null }
      $.clock.every(REFRESH_MS, async () => {
        if (!active) return
        if (stale) return refresh($, false)
        await readUsage($)
        $.ui.invalidate('ui.render')
      })
      await refresh($, false)
    }
    return next(e)
  })

  // A new session id after /clear, /resume or /branch; the counts start over.
  // The event passes on unchanged; on any error in this hook, it passes on.
  on('classic.SessionStart', async ($, e, next) => {
    newSession(e.session_id)
    await refresh($, false)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A sub-agent launch, after the plugin's PreToolUse gates have written their
  // signed row and before Claude Code settles the permission: the band and the
  // launch's row are brought up to date, then Claude Code's own permission
  // decision is returned exactly as it is. This hook never answers allow, ask
  // or deny itself; on any error in it, the decision still passes on.
  on('tool.check', { tool: ['Task', 'Agent'] }, async ($, e, next) => {
    await launched($, e.tool_use_id)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Each request's tokens, split between the main conversation and sub-agents
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const used = result && result.usage
    if (used) {
      const tokens = (used.input_tokens || 0) + (used.output_tokens || 0) + (used.cache_read_input_tokens || 0) + (used.cache_creation_input_tokens || 0)
      if (e.agentId) live.sub += tokens
      else live.main += tokens
      stale = true
      $.ui.invalidate('ui.render')
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) await refresh($, false)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await readUsage($)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // Observation only. The host and the person retain the whole switch decision.
  on('classic.PreModelSwitch', async ($, e, next) => {
    thresholdAt = 0  // the new model has its own compaction point: read it at the next tick
    if (active) { try { $.ui.log(switchNotice(e)) } catch { /* display failure cannot affect a switch */ } }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agentguard' }, async ($) => {
    detailsOpen = true
    await $.ui.open({ id: PANE, title: 'AgentGuard', focus: true, closeOnEscape: true })
    await refresh($, true)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!active) return rest
    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(1, (e.props && e.props.bodyColumns) || 80)
    const line = Box({ flexDirection: 'row', flexWrap: 'nowrap', width, children: formattedStatus(width).parts.map(part => Text({...text(part), wrap: 'truncate-end'})) })
    return rest ? Box({ flexDirection: 'column', children: [line, rest] }) : line
  })

  // AgentGuard's word under Claude Code's own row for each sub-agent launch
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const row = await next(e)
    if (!active || !e.props || !SPAWN_TOOLS.includes(e.props.tool)) return row
    const stamp = stampFor(e.props)
    if (!stamp) return row
    const { Box, Text } = $.ui.resolve(e)
    const parts = [{ text: '  ⎿  ', dim: true }, pill(stamp.label[0], stamp.label[1]), { text: ' AgentGuard', color: TEAL, bold: true }]
    const facts = []
    if (stamp.seen && stamp.seen.count !== null && stamp.seen.limit) facts.push('sub-agents ' + stamp.seen.count + ' of ' + stamp.seen.limit + ' at launch')
    if (stamp.signed) facts.push('signed #' + stamp.signed.sequence)
    if (facts.length) parts.push({ text: ' · ' + facts.join(' · '), dim: true, truncate: true })
    const mark = Box({ flexDirection: 'row', children: parts.map((part) => Text(text(part))) })
    return row ? Box({ flexDirection: 'column', children: [row, mark] }) : mark
  })

  // While Claude works, the spinner carries the sub-agent count once one has run
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const burn = status && status.burn
    if (!active || !burn || !burn.spawns || !e.props) return next(e)
    const window = leading(burn)
    return next({ ...e, props: { ...e.props, suffix: ' · sub-agents ' + window.count + '/' + window.limit + (e.props.suffix || '') } })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        ...paneLines().map((line) => (line.parts ? Box({ flexDirection: 'row', children: line.parts.map((part) => Text(text(part))) }) : Text(text(line)))),
        Box({flexDirection: 'column', children: modelChoices.map(model => Button({
          key: 'model:' + model.id, label: model.label, hotkey: model.hotkey, plain: true,
          onPress: async () => {
            detailsOpen = false
            await $.ui.close({id: PANE})
            return $.prompt.fill({text: '/model ' + model.id, mode: 'replace'})
          },
        }))}),
        Box({
          flexDirection: 'row',
          columnGap: 3,
          children: [
            Button({ key: 'refresh', label: 'Refresh', hotkey: 'r', plain: true, onPress: () => refresh($, false) }),
            Button({ key: 'verify', label: 'Verify signatures', hotkey: 'v', plain: true, onPress: () => refresh($, true) }),
            Button({ key: 'close', label: 'Close', hotkey: 'c', plain: true, onPress: () => { detailsOpen = false; return $.ui.close({ id: PANE }) } }),
          ],
        }),
      ],
    })
  })
}
