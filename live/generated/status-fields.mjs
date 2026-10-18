// Generated from agentguard-burn/src/insights/status-fields.ts.
import { forecastLimit } from './pace.mjs';
import { STATUS_TEXT } from './status-text.mjs';
// Display order is most useful first. Remove from the opposite end on overflow.
export const STATUS_FIELDS = ['pace', 'cost', 'cache', 'spend'];
export function parseStatusFields(value = '') {
    const names = [...new Set(String(value).slice(0, 1024).split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
    return { fields: STATUS_FIELDS.filter(field => names.includes(field)),
        unknown: names.filter(name => !STATUS_FIELDS.includes(name)).map(name => name.replace(/[^a-z0-9_]/g, '').slice(0, 32) || '?') };
}
export function statusColor(used, limit = 100) {
    return limit > 0 && used / limit >= .9 ? 'red' : limit > 0 && used / limit >= .7 ? 'yellow' : null;
}
export function statusCount(n) {
    if (!Number.isFinite(n))
        return '0';
    for (const [size, unit] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
        if (n >= size)
            return (n / size).toFixed(n >= size * 10 ? 0 : 1).replace(/\.0$/, '') + unit;
    }
    return String(Math.round(n));
}
function money(value, range) {
    return Math.abs(value.max - value.min) < .000001 ? `$${value.min.toFixed(2)}` : `$${value.min.toFixed(2)} ${range} $${value.max.toFixed(2)}`;
}
function duration(minutes) {
    const n = Math.max(0, Math.round(minutes / 10) * 10);
    return '~' + (n >= 60 ? `${Math.floor(n / 60)}h` : '') + (n % 60 || n < 60 ? `${n % 60}m` : '');
}
export function statusPlans(windows = []) {
    const latest = new Map();
    for (const window of windows)
        if (Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100 &&
            (!latest.has(window.name) || latest.get(window.name).observedAt <= window.observedAt))
            latest.set(window.name, window);
    return [...latest.values()].sort((a, b) => b.usedPercent - a.usedPercent);
}
export function statusPlan(windows = []) {
    return statusPlans(windows)[0];
}
export function statusPace(windows = [], now = Date.now()) {
    const plan = statusPlan(windows);
    if (!plan)
        return null;
    const same = windows.filter(w => w.name === plan.name && w.resetsAt === plan.resetsAt && w.pool === plan.pool && w.source === plan.source &&
        w.windowMinutes === plan.windowMinutes && w.observedAt >= now - 600000 && w.observedAt <= now &&
        w.resetsAt > now && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100);
    if (!same.some(w => w.observedAt < plan.observedAt && w.usedPercent < plan.usedPercent))
        return null;
    const minutes = forecastLimit(same, now).minutes;
    return minutes !== null && minutes < (plan.resetsAt - now) / 60000 ? minutes : null;
}
export function formatStatusFields(input) {
    const words = STATUS_TEXT[input.lang ?? 'en'], selected = parseStatusFields(input.fields);
    const plans = statusPlans(input.windows), plan = plans[0], pace = statusPace(input.windows, input.now);
    const planName = (window) => window.name === 'five_hour' ? words.fiveHour : window.name === 'seven_day' ? words.weekly : window.name.replace(/[^a-zA-Z0-9_]/g, '').replace(/_/g, ' ');
    const age = (window) => {
        const elapsed = (input.now ?? Date.now()) - window.observedAt;
        return elapsed > 60000 ? words.ago.replace('{minutes}', String(Math.floor(elapsed / 60000))) : '';
    };
    const ctx = input.context && Number.isFinite(input.context.tokens) && input.context.tokens >= 0 &&
        Number.isFinite(input.context.threshold) && input.context.threshold > 0 ? input.context : null;
    const left = ctx ? Math.max(0, Math.round(100 - (100 * ctx.tokens) / ctx.threshold)) : null;
    const optional = new Map();
    if (pace !== null)
        optional.set('pace', { text: `${words.limit} ${duration(pace)}`, color: pace < 30 ? 'yellow' : null });
    if (input.cost)
        optional.set('cost', { text: `≈${money(input.cost, words.range)} ${words.list}` });
    if (input.cache && input.cache.tokens > 0)
        optional.set('cache', { text: `${words.cache} ${statusCount(input.cache.tokens)}${input.cache.usd ? ` (≈${money(input.cache.usd, words.range)} ${words.list})` : ''}` });
    if (input.spend && input.spend.capCents >= 0)
        optional.set('spend', { text: `${words.spend} $${(input.spend.usedCents / 100).toFixed(2)} ${words.of} $${(input.spend.capCents / 100).toFixed(2)} ${words.list} ${words.today}`,
            color: input.spend.capCents === 0 ? 'red' : statusColor(input.spend.usedCents, input.spend.capCents) });
    const enabled = selected.fields.filter(field => optional.has(field));
    const dropped = [];
    const width = Math.max(1, Number.isFinite(input.width) ? Math.floor(input.width) : 200);
    function parts(short = 0) {
        const out = [{ text: 'AgentGuard ', background: '#2abcb4', color: '#04201e', bold: true }];
        const burn = input.burn;
        if (!burn) {
            out.push({ text: input.failed ? ` ${words.unavailable} · /agentguard` : ` ${words.starting}`, dim: true });
            return out;
        }
        const ratio = (w) => w.limit ? w.count / w.limit : 0;
        const win = ratio(burn.sustained) > ratio(burn.burst) ? burn.sustained : burn.burst;
        const color = statusColor(win.count, win.limit);
        out.push({ text: ` ${short > 1 ? 'a' : words.agents} ${win.count}${short ? '/' : ` ${words.of} `}${win.limit}`, color, dim: !color });
        const add = (text, extra = {}) => out.push({ text: ` · ${text}`, dim: !extra.color, ...extra });
        const label = short > 1 ? 't' : words.tokens, limit = statusCount(burn.tokens.limit);
        // A session past its ceiling keeps counting. "24B of 5B" reads as broken, so say what the state is.
        if (burn.tokens.limit > 0 && burn.tokens.used >= burn.tokens.limit) {
            const past = (short ? words.pastShort : words.pastLimit).replace('{limit}', limit);
            add(`${label} ${statusCount(burn.tokens.used)}, ${past}${!short && burn.mode !== 'shadow' ? `: ${words.waits}` : ''}`, { color: 'red' });
        }
        else
            add(`${label} ${statusCount(burn.tokens.used)}${short ? '/' : ` ${words.of} `}${limit}`, { color: statusColor(burn.tokens.used, burn.tokens.limit) });
        if (ctx && left !== null) {
            // The colour follows the number shown, so "30%" is always yellow and "10%" always red.
            const color = left <= 10 ? 'red' : left <= 30 ? 'yellow' : null;
            add(short > 1 ? `ac ${left}%` : `${left}% ${short ? words.compactShort : words.compact}`, color ? { color } : {});
        }
        if (typeof input.share === 'number' && Number.isFinite(input.share))
            add(`${Math.round(input.share)}% ${short ? words.sub : words.share}`);
        if (plan)
            add(`${short && plan.name === 'five_hour' ? '5h' : planName(plan)} ${Math.round(plan.usedPercent)}%${age(plan) ? ` (${age(plan)})` : ''}`, { color: statusColor(plan.usedPercent) });
        for (const field of enabled)
            if (!dropped.includes(field)) {
                const { text, ...style } = optional.get(field);
                add(text, { ...style, field });
            }
        if (burn.mode === 'shadow')
            add(words.watching, { color: 'yellow' });
        if (short < 2)
            add('/agentguard');
        return out;
    }
    let output = parts();
    const length = () => output.reduce((sum, part) => sum + [...part.text].length, 0);
    for (const field of [...enabled].reverse()) {
        if (length() <= width)
            break;
        dropped.push(field);
        output = parts();
    }
    for (let short = 1; length() > width && short <= 2; short++)
        output = parts(short);
    // Extremely narrow host slots cannot hold every value. Preserve the data in
    // parts and ask the host to clip one row rather than wrap or invent numbers.
    const fullText = output.map(part => part.text).join('');
    const text = [...fullText].slice(0, width).join('');
    const panel = [
        ...(ctx && left !== null ? [words.contextLine.replace('{used}', Math.round(ctx.tokens).toLocaleString('en-US'))
                .replace('{threshold}', Math.round(ctx.threshold).toLocaleString('en-US')).replace('{left}', String(left))] : []),
        ...plans.map(window => `${words.plan} ${Math.round(window.usedPercent)}% (${planName(window)}). ${words.reset} ${Number.isFinite(window.resetsAt) ? new Date(window.resetsAt).toISOString() : words.none}.${age(window) ? ` ${words.lastRead} ${age(window)}.` : ''}`),
        pace !== null ? `${words.limit} ${duration(pace)}.` : words.paceEmpty,
        input.cost ? `${words.costLead} ≈ ${money(input.cost, words.range)} ${words.costFull}.` : words.costEmpty,
        input.cache && input.cache.tokens > 0 ? `${words.cacheLead} ${input.cache.tokens.toLocaleString('en-US')} ${words.tokens}${input.cache.usd ? ` (≈ ${money(input.cache.usd, words.range)} ${words.costFull})` : ''}.` : words.cacheEmpty,
        input.spend ? `${words.spendLead} $${(input.spend.usedCents / 100).toFixed(2)} ${words.of} $${(input.spend.capCents / 100).toFixed(2)} ${words.list} ${words.today}. ${words.reset} ${new Date(input.spend.resetsAt).toISOString()}.` : words.spendEmpty,
        `${words.enabled} ${selected.fields.join(', ') || words.none}. ${words.change}`,
        selected.unknown.length ? `${words.unknown} ${selected.unknown.join(', ')}.` : null,
        dropped.length ? `${words.hidden} ${dropped.join(', ')}.` : null,
    ].filter((line) => line !== null);
    return { text, parts: output, panel, enabled: selected.fields, unknown: selected.unknown, dropped, clipped: fullText !== text };
}
