// Verified in Claude Code 2.1.293's bundled model catalog and resolver, and
// https://code.claude.com/docs/en/model-config on 2026-10-07. Aliases follow the
// host's provider/settings. Pin Haiku 5.5 because some providers keep haiku on 4.5.
const DEFAULTS = [
  {id: 'fable', label: 'Fable', hotkey: 'f'},
  {id: 'opus', label: 'Opus', hotkey: 'o'},
  {id: 'sonnet', label: 'Sonnet', hotkey: 's'},
  {id: 'claude-haiku-5-5', label: 'Haiku 5.5', hotkey: 'h'},
]
// Only recognized models participate in the suggestion ladder. A custom id
// can be selected by the person, but its price is never guessed from its name.
const GROUPS = [
  ['fable', 'claude-fable-5', 'claude-fable-5-1'],
  ['opus', 'claude-opus-5', 'claude-opus-5-5', 'claude-opus-4-8'],
  ['sonnet', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-sonnet-4-6'],
  ['haiku', 'claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-haiku-5-5'],
]
const group = id => GROUPS.findIndex(names => names.includes(String(id).replace(/\[1m\]$/, '')))

export function quickModels(value = '') {
  const rows = DEFAULTS.map(row => ({...row}))
  const ids = new Set(rows.map(row => row.id))
  for (const raw of String(value).slice(0, 4096).split(',')) {
    const id = raw.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,127}$/.test(id) || ids.has(id)) continue
    if (rows.length >= DEFAULTS.length + 9) break
    ids.add(id)
    rows.push({id, label: id, hotkey: String(rows.length - DEFAULTS.length + 1)})
  }
  return rows
}

export function nextCheaperQuickModel(current, rows) {
  const from = group(current)
  if (from < 0) return null
  return rows.filter(row => group(row.id) > from).sort((a, b) => group(a.id) - group(b.id))[0]?.id ?? null
}

export function switchNotice(event) {
  const cost = event.estimated_cache_write_usd
  if (event.pricing === 'catalog' && Number.isFinite(cost) && cost >= 0) {
    return `AgentGuard: switching re-sends this chat, ≈ $${cost.toFixed(2)} at API list price, not a bill.`
  }
  // Managed rates and an assumed fallback tier are not verified list prices.
  return 'AgentGuard: switching re-sends this chat. API list price is unavailable for this host estimate.'
}
