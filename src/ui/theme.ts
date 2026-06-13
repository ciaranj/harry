// Single source of truth for the Harry palette + chrome glyphs. Tweak here to
// reshape the persona without hunting through component files.

export const theme = {
    role: {
        user: '#af5f00',        // dim amber
        assistant: '#ffaf00',   // bright amber
        system: 'yellow',
    },
    glyph: {
        user: '>',
        assistant: '●',
        system: '?',
        toolCall: '↳',
        prompt: '>',
        event: '·',             // UI event marker
    },
    accent: '#5fafaf',          // teal — tool calls, status stats, gauge calm
    inputPrompt: '#ffaf00',     // focus marker on the input line
    muted: 'gray',              // borders, reasoning, dim secondary text
    notification: 'magenta',
    danger: 'red',              // cancel confirm, gauge over-threshold
    review: 'cyan',             // review mode chrome — kept distinct on purpose
    event: 'dim gray',          // UI-only events (reset, compaction)
    reset: '#ff5f87',           // reset separator — warm magenta to stand out
    gauge: {
        calm: '#5fafaf',
        warn: 'yellow',
        danger: 'red',
        threshold: 'yellow',
    },
} as const;
