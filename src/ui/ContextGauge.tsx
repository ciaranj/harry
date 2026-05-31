import React from 'react';
import { Text } from 'ink';
import { theme } from './theme.js';

interface ContextGaugeProps {
    used: number;
    cached: number;
    max: number;
    threshold?: number;
    cells?: number;
}

// 20-cell split bar: dim cached run, bright live run, dotted headroom with a
// tick at the compaction threshold. Fill colour escalates cyan→yellow→red as
// usage approaches the threshold so peripheral vision picks it up.
export function ContextGauge({
    used, cached, max, threshold = 0.8, cells = 20,
}: ContextGaugeProps) {
    const safeMax = Math.max(1, max);
    const usedFrac = Math.max(0, Math.min(1, used / safeMax));
    const fillColor = usedFrac >= threshold ? theme.gauge.danger : usedFrac >= 0.5 ? theme.gauge.warn : theme.gauge.calm;

    // Round usedCells against max, but split cached/live as a fraction of
    // *used* so cached stays visible even when total usage is small relative
    // to the window. Force a minimum of 1 cell for any non-zero portion so
    // tiny-but-present runs don't disappear into rounding.
    let usedCells = Math.min(cells, Math.round(usedFrac * cells));
    if (used > 0 && usedCells === 0) usedCells = 1;
    const safeUsed = Math.max(1, used);
    let cachedCells = Math.min(usedCells, Math.round((cached / safeUsed) * usedCells));
    if (cached > 0 && cachedCells === 0) cachedCells = 1;
    // Once we have ≥2 cells to play with, guarantee at least one live cell
    // whenever live content exists — otherwise a mostly-cached prompt looks
    // like it has zero live tokens.
    if (usedCells >= 2 && used > cached && cachedCells === usedCells) {
        cachedCells = usedCells - 1;
    }
    const liveCells = usedCells - cachedCells;
    const restCells = cells - usedCells;

    // Tick sits at the compaction threshold; once we've crossed it the red
    // fill is loud enough on its own, so drop the tick.
    const thresholdIdx = Math.round(threshold * cells);
    const tickOffset = thresholdIdx - usedCells;
    const showTick = tickOffset > 0 && tickOffset <= restCells;
    const beforeTick = showTick ? tickOffset - 1 : restCells;
    const afterTick  = showTick ? restCells - tickOffset : 0;

    const fmt = (n: number) =>
        n >= 10000 ? `${Math.round(n / 1000)}k`
        : n >= 1000 ? `${(n / 1000).toFixed(1)}k`
        : String(n);

    return (
        <Text>
            [<Text color={fillColor} dimColor>{'█'.repeat(cachedCells)}</Text>
            <Text color={fillColor}>{'█'.repeat(liveCells)}</Text>
            <Text color={theme.muted} dimColor>{'·'.repeat(beforeTick)}</Text>
            {showTick && <Text color={theme.gauge.threshold}>│</Text>}
            <Text color={theme.muted} dimColor>{'·'.repeat(afterTick)}</Text>
            ] <Text color={fillColor}>{fmt(used)}</Text>/<Text color={theme.muted} dimColor>{fmt(max)}</Text>
        </Text>
    );
}
