import { StringDecoder } from 'node:string_decoder';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed SSE event from the LLM streaming response. */
export interface SseEvent {
    timings?: { prompt_n?: number; cache_n?: number };
    choices?: Array<{
        delta?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
            }>;
        };
        finish_reason?: string;
    }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1 MB hard cap on accumulated partial JSON to prevent memory exhaustion. */
export const MAX_PARTIAL_JSON_BYTES = 1024 * 1024;

/** 30 seconds — timeout for accumulating partial JSON fragments. */
export const PARTIAL_JSON_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Parses a SSE stream and yields parsed events.
 *
 * Handles partial lines across chunks via a buffer, and accumulates
 * incomplete JSON fragments that span multiple network chunks.
 *
 * Supports:
 * - Standard SSE data lines: `data: {...}`
 * - Standalone JSON objects (no `data:` prefix)
 * - Cross-chunk JSON fragments (accumulates until valid JSON)
 * - `[DONE]` sentinel (stops iteration)
 * - Hard cap on partial JSON size (resets with rolling window)
 * - Partial JSON timeout (resets accumulation after 30s of silence)
 */
export async function* parseSseStream(
    body: ReadableStream,
    logger: Logger
): AsyncIterable<SseEvent> {
    const decoder = new StringDecoder('utf8');
    let buffer = "";
    let partialJson = "";

    let partialJsonStart = Date.now();
    for await (const chunk of body) {
        const now = Date.now();
        if (partialJson && (now - partialJsonStart) > PARTIAL_JSON_TIMEOUT_MS) {
            partialJsonStart = now;
        }
        buffer += decoder.write(chunk);
        partialJsonStart = now;
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.trim()) continue;
            const trimmed = line.trim();
            const data = trimmed.startsWith('data: ') ? trimmed.slice(6).trim() : trimmed.trim();
            if (data === '[DONE]') return;

            if (data.startsWith('{') || data.startsWith('[')) {
                partialJson += data;
                if (Buffer.byteLength(partialJson) > MAX_PARTIAL_JSON_BYTES) {
                    logger.warn(
                        { partialLength: Buffer.byteLength(partialJson) },
                        'SSE partial JSON exceeded hard cap, resetting'
                    );
                    const lastBytes = 4096;
                    partialJson = partialJson.slice(-lastBytes);
                    continue;
                }
                try {
                    yield JSON.parse(partialJson) as SseEvent;
                    partialJson = "";
                } catch {
                    const truncated = partialJson.length > 120 ? partialJson.slice(0, 120) + '…' : partialJson;
                    logger.warn(
                        { data: String(data), partial: truncated },
                        'SSE partial JSON (cross-chunk fragment)'
                    );
                }
            } else if (partialJson) {
                partialJson += data;
                try {
                    yield JSON.parse(partialJson) as SseEvent;
                    partialJson = "";
                } catch {
                    const truncated = partialJson.length > 120 ? partialJson.slice(0, 120) + '…' : partialJson;
                    logger.warn(
                        { data: String(data), partial: truncated },
                        'SSE partial JSON (cross-chunk fragment)'
                    );
                }
            }
        }
    }
}
