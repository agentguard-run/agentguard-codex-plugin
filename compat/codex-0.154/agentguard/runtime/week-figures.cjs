// CommonJS copy of packages/agentguard-burn/src/insights/week.ts: constants, dates, topWeekCause and weekFigures.
// Keep the strict contract and thresholds identical; tests share the Burn v1 fixture.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.lastCompletedWeekStart = exports.RELOAD_GROUPS = exports.WEEK_CAUSES = exports.SMALLER_MODEL = exports.WEEK_SCHEMA = void 0;
exports.weekStartOf = weekStartOf;
exports.isMonday = isMonday;
exports.topWeekCause = topWeekCause;
exports.weekFigures = weekFigures;
exports.WEEK_SCHEMA = 'agentguard.burn-week.v1';
exports.SMALLER_MODEL = 'claude-haiku-5-5';
const DAY = 86_400_000, WEEK = 7 * DAY;
exports.WEEK_CAUSES = ['history_resent', 'reread_files', 'subagent_fanout', 'reloads'];
exports.RELOAD_GROUPS = ['idle', 'model_switch', 'other'];
function weekStartOf(ms) {
    const date = new Date(ms);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
}
const lastCompletedWeekStart = (now = Date.now()) => weekStartOf(Date.parse(weekStartOf(now)) - WEEK);
exports.lastCompletedWeekStart = lastCompletedWeekStart;
function isMonday(date) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        return false;
    const at = Date.parse(date + 'T00:00:00.000Z');
    return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === date && new Date(at).getUTCDay() === 1;
}
/** Contract constants and tie order are copied in the plugin's weekly validator. */
function topWeekCause(figures) {
    const { tokens, usdMicros, causes, wrongModel, subagentTokens, reloadsByCause } = figures;
    if (!tokens.total)
        return null;
    const priced = usdMicros.total !== null;
    const size = (amount) => priced ? amount.usdMicros : amount.tokens;
    const candidates = [
        ['subagent_fanout', causes.subagent_fanout.tokens * 100 >= tokens.total * 20],
        ['reloads', priced && usdMicros.total > 0 && causes.reloads.usdMicros * 100 >= usdMicros.total * 15],
        ['history_resent', causes.history_resent.tokens * 100 >= tokens.total * 30],
        ['reread_files', causes.reread_files.tokens * 100 >= tokens.total * 10],
    ];
    let winner = null;
    for (const [cause, eligible] of candidates)
        if (eligible && (winner === null || size(causes[cause]) > size(causes[winner])))
            winner = cause;
    if (winner === 'subagent_fanout' && subagentTokens > 0 && wrongModel.tokens * 2 >= subagentTokens)
        return 'wrong_model';
    if (winner === 'reloads') {
        let group = 'idle';
        for (const candidate of exports.RELOAD_GROUPS)
            if (size(reloadsByCause[candidate]) > size(reloadsByCause[group]))
                group = candidate;
        if (group !== 'other')
            return group === 'idle' ? 'reloads_idle' : 'reloads_model_switch';
    }
    return winner;
}
/** Strict content-free contract: unknown keys and inconsistent arithmetic are errors. */
function weekFigures(value) {
    const fail = () => { throw new Error('Invalid weekly figures.'); };
    const exact = (v, keys) => {
        if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || !keys.every(k => Object.hasOwn(v, k)))
            return fail();
        return v;
    };
    const integer = (n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 1e13;
    const groups = ['total', 'useful', 'waste', 'unattributed'];
    const row = exact(value, ['tokens', 'usdMicros', 'causes', 'reloadsByCause', 'subagentTokens', 'wrongModel', 'topCause', 'basis']);
    const tokens = exact(row.tokens, groups), usd = exact(row.usdMicros, groups);
    const causes = exact(row.causes, exports.WEEK_CAUSES), reloads = exact(row.reloadsByCause, exports.RELOAD_GROUPS);
    const amounts = [...Object.values(causes), ...Object.values(reloads)].map(v => exact(v, ['tokens', 'usdMicros']));
    const wrong = exact(row.wrongModel, ['tokens', 'usdMicros', 'smallerUsdMicros']);
    if (![...Object.values(tokens), ...amounts.map(v => v.tokens), row.subagentTokens, wrong.tokens].every(integer))
        return fail();
    const dollars = [...Object.values(usd), ...amounts.map(v => v.usdMicros), wrong.usdMicros, wrong.smallerUsdMicros];
    if (!(dollars.every(v => v === null) || dollars.every(integer)))
        return fail();
    const f = value;
    if (f.basis !== 'estimated_api_list_price' || f.wrongModel.tokens > f.subagentTokens || f.subagentTokens > f.tokens.total)
        return fail();
    if (f.tokens.total !== f.tokens.useful + f.tokens.waste + f.tokens.unattributed
        || f.tokens.waste !== exports.WEEK_CAUSES.reduce((n, k) => n + f.causes[k].tokens, 0)
        || f.causes.reloads.tokens !== exports.RELOAD_GROUPS.reduce((n, k) => n + f.reloadsByCause[k].tokens, 0))
        return fail();
    if (f.usdMicros.total !== null && (f.usdMicros.total !== f.usdMicros.useful + f.usdMicros.waste + f.usdMicros.unattributed
        || f.usdMicros.waste !== exports.WEEK_CAUSES.reduce((n, k) => n + f.causes[k].usdMicros, 0)
        || f.causes.reloads.usdMicros !== exports.RELOAD_GROUPS.reduce((n, k) => n + f.reloadsByCause[k].usdMicros, 0)
        || f.wrongModel.smallerUsdMicros > f.wrongModel.usdMicros))
        return fail();
    if (f.topCause !== topWeekCause(f))
        return fail();
    return f;
}
