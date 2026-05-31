import { describe, it, expect, vi } from 'vitest';
import { parseSseStream, SseEvent, MAX_PARTIAL_JSON_BYTES, PARTIAL_JSON_TIMEOUT_MS } from './llm-sse-parser.js';

// ===================================================================
// Helpers
// ===================================================================

/** Create a ReadableStream from SSE data lines. */
function sseStream(lines: string[]): ReadableStream {
    const text = lines.join('\n') + '\n';
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        }
    });
}

/** Create a ReadableStream where each item in `chunks` is a separate write. */
function sseStreamFromChunks(chunks: string[]): ReadableStream {
    return new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
        }
    });
}

function makeLogger() {
    return {
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        child: vi.fn(),
    };
}

async function collectEvents(stream: ReadableStream, logger?) {
    const events: SseEvent[] = [];
    for await (const event of parseSseStream(stream, logger || makeLogger())) {
        events.push(event);
    }
    return events;
}

// ===================================================================
// Constants
// ===================================================================

describe('constants', () => {
    it('MAX_PARTIAL_JSON_BYTES should be 1 MB', () => {
        expect(MAX_PARTIAL_JSON_BYTES).toBe(1024 * 1024);
    });

    it('PARTIAL_JSON_TIMEOUT_MS should be 30 seconds', () => {
        expect(PARTIAL_JSON_TIMEOUT_MS).toBe(30_000);
    });
});

// ===================================================================
// Basic SSE parsing
// ===================================================================

describe('parseSseStream — basic parsing', () => {
    it('should parse a single SSE event with data: prefix', async () => {
        const event: SseEvent = {
            timings: { prompt_n: 100, cache_n: 50 },
            choices: [{ delta: { content: 'hello' } }]
        };
        const events = await collectEvents(sseStream([`data: ${JSON.stringify(event)}`]));
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual(event);
    });

    it('should parse multiple SSE events', async () => {
        const events = [
            { timings: { prompt_n: 10 }, choices: [{ delta: { content: 'a' } }] },
            { timings: { prompt_n: 20 }, choices: [{ delta: { content: 'b' } }] }
        ];
        const lines = events.map(e => `data: ${JSON.stringify(e)}`);
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(2);
        expect(result).toEqual(events);
    });

    it('should stop on [DONE] sentinel', async () => {
        const lines = [
            'data: {"choices":[{"delta":{"content":"a"}}]}',
            'data: {"choices":[{"delta":{"content":"b"}}]}',
            '[DONE]'
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(2);
        expect(result[1].choices?.[0]?.delta?.content).toBe('b');
    });

    it('should emit all events before [DONE] even if [DONE] is not on its own line', async () => {
        const lines = [
            'data: {"choices":[{"delta":{"content":"x"}}]}',
            '[DONE]'
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
    });

    it('should handle empty lines between events', async () => {
        const events = [
            { timings: { prompt_n: 1 }, choices: [{ delta: { content: 'test' } }] }
        ];
        const lines = ['', `data: ${JSON.stringify(events[0])}`, ''];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
    });
});

// ===================================================================
// Partial line / cross-chunk JSON
// ===================================================================

describe('parseSseStream — partial lines and cross-chunk fragments', () => {
    it('should handle JSON split across multiple lines', async () => {
        // Simulate a line split: "data: {\"a" + "bc\"}"
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const half = Math.ceil(json.length / 2);
        const lines = [
            `data: ${json.slice(0, half)}`,
            `${json.slice(half)}`,
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(1);
    });

    it('should accumulate partial JSON across multiple network chunks', async () => {
        // Simulate: chunk1 = "data: {\"tim", chunk2 = "ings\":{\"prompt_n\":1}}"
        const json = JSON.stringify({ timings: { prompt_n: 42 } });
        const splitAt = 15;
        const lines = [
            `data: ${json.slice(0, splitAt)}`,
            `${json.slice(splitAt)}`,
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(42);
    });

    it('should handle a line split in the middle of a JSON object', async () => {
        // Line is split: "data: {\"choices\":[{}}"
        // becomes two lines: "data: {\"choices\":[{" and "}]"
        const json = JSON.stringify({ choices: [{ delta: { content: 'x' } }] });
        const splitAt = 10;
        const lines = [
            `data: ${json.slice(0, splitAt)}`,
            `${json.slice(splitAt)}`,
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
        expect(result[0].choices?.[0]?.delta?.content).toBe('x');
    });

    it('should handle multi-line split across more than two parts', async () => {
        const json = JSON.stringify({ timings: { prompt_n: 7, cache_n: 3 } });
        const parts = ['{', '"timings":{"prompt_n": 7', ', "cache_n": 3}}'];
        // These would come as separate network chunks, each as a separate "line"
        // In practice this is unlikely but tests the accumulation logic
        const result = await collectEvents(sseStreamFromChunks([
            `data: ${parts[0]}`,
            parts[1],
            parts[2],
            '\n'
        ]));
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(7);
        expect(result[0].timings?.cache_n).toBe(3);
    });

    it('should yield a complete event even when the next partial fragment arrives', async () => {
        // Line 1: complete event
        // Line 2: start of next event
        const json1 = JSON.stringify({ timings: { prompt_n: 1 }, choices: [{ delta: { content: 'ok' } }] });
        const json2 = '{"ti';
        const lines = [
            `data: ${json1}`,
            `data: ${json2}`,
        ];
        const result = await collectEvents(sseStream(lines));
        // The partial "data: {\"ti" should not be yielded (not valid JSON yet)
        expect(result).toHaveLength(1);
        expect(result[0].choices?.[0]?.delta?.content).toBe('ok');
    });
});

// ===================================================================
// Tool call deltas
// ===================================================================

describe('parseSseStream — tool call events', () => {
    it('should parse a tool call SSE event', async () => {
        const event: SseEvent = {
            timings: { prompt_n: 50, cache_n: 20 },
            choices: [{
                delta: {
                    tool_calls: [{
                        index: 0,
                        id: 'call-123',
                        type: 'function',
                        function: { name: 'read_files', arguments: '{"paths":[]}' }
                    }]
                },
                finish_reason: 'tool_calls'
            }]
        };
        const result = await collectEvents(sseStream([`data: ${JSON.stringify(event)}`]));
        expect(result).toHaveLength(1);
        expect(result[0].choices?.[0]?.delta?.tool_calls?.[0]?.function?.name).toBe('read_files');
        expect(result[0].choices?.[0]?.finish_reason).toBe('tool_calls');
    });

    it('should parse a reasoning content event', async () => {
        const event: SseEvent = {
            timings: { prompt_n: 10 },
            choices: [{ delta: { reasoning_content: 'Let me think...' } }]
        };
        const result = await collectEvents(sseStream([`data: ${JSON.stringify(event)}`]));
        expect(result).toHaveLength(1);
        expect(result[0].choices?.[0]?.delta?.reasoning_content).toBe('Let me think...');
    });

    it('should parse a timing-only event (no delta)', async () => {
        const event: SseEvent = { timings: { prompt_n: 500, cache_n: 100 } };
        const result = await collectEvents(sseStream([`data: ${JSON.stringify(event)}`]));
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(500);
        expect(result[0].choices).toBeUndefined();
    });
});

// ===================================================================
// Edge cases
// ===================================================================

describe('parseSseStream — edge cases', () => {
    it('should handle empty stream', async () => {
        const stream = new ReadableStream({
            start(controller) { controller.close(); }
        });
        const result = await collectEvents(stream);
        expect(result).toHaveLength(0);
    });

    it('should handle stream with only empty lines', async () => {
        const result = await collectEvents(sseStream(['', '', '']));
        expect(result).toHaveLength(0);
    });

    it('should handle stream with only [DONE]', async () => {
        const result = await collectEvents(sseStream(['[DONE]']));
        expect(result).toHaveLength(0);
    });

    it('should handle a stream that closes without [DONE]', async () => {
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const lines = [`data: ${json}`];
        // No [DONE], stream closes naturally
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
    });

    it('should handle non-JSON data lines when not in a partial fragment', async () => {
        // Standalone lines like "retry:5000" should be silently skipped
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const lines = [
            'retry:5000',
            `data: ${json}`,
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
    });

    it('should append non-JSON lines to an ongoing partial fragment', async () => {
        // Simulate a partial JSON fragment with a stray line in between
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const mid = json.slice(0, 10);
        const rest = json.slice(10);
        const lines = [
            `data: ${mid}`,
            '', // stray empty line between fragments
            rest,
        ];
        const result = await collectEvents(sseStream(lines));
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(1);
    });

    it('should handle data: without JSON prefix (bare JSON)', async () => {
        // Some SSE implementations omit the "data: " prefix
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const result = await collectEvents(sseStream([json]));
        expect(result).toHaveLength(1);
    });

    it('should handle whitespace in data: lines', async () => {
        // Some implementations have leading/trailing whitespace
        const json = JSON.stringify({ timings: { prompt_n: 1 } });
        const result = await collectEvents(sseStream([`  data:  ${json}  `]));
        expect(result).toHaveLength(1);
    });
});

// ===================================================================
// Hard cap
// ===================================================================

describe('parseSseStream — hard cap', () => {
    it('should reset partial JSON when exceeding MAX_PARTIAL_JSON_BYTES', async () => {
        const logger = makeLogger();
        // Create a partial JSON that exceeds the cap
        const largeFragment = '{"a":"' + 'x'.repeat(MAX_PARTIAL_JSON_BYTES + 100) + '"';
        const lines = [
            `data: ${largeFragment.slice(0, 10)}`,
            `${largeFragment.slice(10)}`,
            // The partial will exceed 1MB, get capped, then continue accumulating
            // Eventually it will become valid JSON
        ];

        // For simplicity, test that the cap logic fires by creating a fragment
        // that stays above the cap across lines
        const veryLongString = 'x'.repeat(MAX_PARTIAL_JSON_BYTES + 500);
        const partialData = `{"partial":"${veryLongString}`;
        const lines2 = [
            `data: ${partialData.slice(0, partialData.length - 5)}`,
            `${partialData.slice(partialData.length - 5)}"}`,
        ];

        await collectEvents(sseStream(lines2), logger);
        // The warn should have been called at least once
        expect(logger.warn).toHaveBeenCalled();
    });
});

// ===================================================================
// Streaming behavior
// ===================================================================

describe('parseSseStream — streaming behavior', () => {
    it('should yield events one at a time (async iterable)', async () => {
        const events = [
            { timings: { prompt_n: 1 }, choices: [{ delta: { content: 'a' } }] },
            { timings: { prompt_n: 2 }, choices: [{ delta: { content: 'b' } }] },
            { timings: { prompt_n: 3 }, choices: [{ delta: { content: 'c' } }] }
        ];
        const lines = events.map(e => `data: ${JSON.stringify(e)}`);
        const stream = sseStream(lines);

        const collected: SseEvent[] = [];
        for await (const event of parseSseStream(stream, makeLogger())) {
            collected.push(event);
        }

        expect(collected).toHaveLength(3);
        expect(collected[0].choices?.[0]?.delta?.content).toBe('a');
        expect(collected[1].choices?.[0]?.delta?.content).toBe('b');
        expect(collected[2].choices?.[0]?.delta?.content).toBe('c');
    });

    it('should yield events even when multiple arrive in a single network chunk', async () => {
        const e1 = JSON.stringify({ timings: { prompt_n: 1 }, choices: [{ delta: { content: 'x' } }] });
        const e2 = JSON.stringify({ timings: { prompt_n: 2 }, choices: [{ delta: { content: 'y' } }] });
        // Both events in one chunk
        const stream = sseStreamFromChunks([`data: ${e1}\ndata: ${e2}\n`]);
        const result = await collectEvents(stream);
        expect(result).toHaveLength(2);
    });

    it('should handle a chunk that ends mid-line', async () => {
        // First chunk ends in the middle of a data line
        const json = JSON.stringify({ timings: { prompt_n: 42 } });
        const split = json.length - 5;
        const stream = sseStreamFromChunks([
            `data: ${json.slice(0, split)}`,
            `${json.slice(split)}\n\n`,
        ]);
        const result = await collectEvents(stream);
        expect(result).toHaveLength(1);
        expect(result[0].timings?.prompt_n).toBe(42);
    });
});
