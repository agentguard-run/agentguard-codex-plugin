// Generated from agentguard-burn/src/insights/pace.ts.
/** Wall-clock ten-minute pace. Cached means cache reads; writes count as uncached. */
export function calculatePace(turns, now = Date.now()) {
    const latest = new Map();
    for (const turn of turns)
        latest.set(turn.id, turn);
    let cached = 0, uncached = 0;
    for (const turn of latest.values()) {
        if (turn.at > now || turn.at <= now - 600_000)
            continue;
        cached += turn.cacheReadTokens;
        uncached += turn.inputTokens + turn.cacheWriteTokens + turn.outputTokens;
    }
    return { cachedPerMinute: cached / 10, uncachedPerMinute: uncached / 10, totalPerMinute: (cached + uncached) / 10,
        projectedNextHour: (cached + uncached) * 6, intervalMinutes: 10 };
}
/** Forecast only observed host percentage consumption, never a token-to-quota conversion. */
export function forecastLimit(samples, now = Date.now()) {
    const valid = samples.filter(s => Number.isFinite(s.usedPercent) && s.usedPercent >= 0 && s.usedPercent <= 100 &&
        Number.isFinite(s.resetsAt) && s.resetsAt > now && s.observedAt <= now && s.observedAt >= now - 600_000);
    if (!valid.length)
        return { minutes: null, reason: 'host does not expose a usage window here' };
    const identity = (s) => `${s.source}:${s.pool ?? 'default'}:${s.name}:${s.windowMinutes ?? ''}:${s.resetsAt}`;
    const latest = new Map();
    for (const sample of valid)
        if (!latest.has(identity(sample)) || latest.get(identity(sample)).observedAt < sample.observedAt)
            latest.set(identity(sample), sample);
    let earliest;
    for (const current of latest.values()) {
        if (current.observedAt < now - 60_000)
            continue;
        const previous = valid.filter(s => identity(s) === identity(current) && s.observedAt < current.observedAt)
            .sort((a, b) => a.observedAt - b.observedAt)[0];
        if (current.usedPercent >= 100)
            return { minutes: 0, reason: 'host reports its usage window exhausted', source: current.source };
        if (!previous || previous.usedPercent >= current.usedPercent)
            continue;
        const rate = (current.usedPercent - previous.usedPercent) / ((current.observedAt - previous.observedAt) / 60_000);
        const minutes = (100 - current.usedPercent) / rate;
        if (minutes > (current.resetsAt - now) / 60_000)
            continue;
        if (!earliest || minutes < earliest.minutes)
            earliest = { minutes, source: current.source };
    }
    return earliest ? { ...earliest, reason: 'based on observed host usage percentage, not token weighting' }
        : { minutes: null, reason: 'host window present; insufficient rising samples before reset' };
}
export function formatCount(n) {
    return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`;
}
