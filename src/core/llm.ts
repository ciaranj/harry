import React from 'react';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { Stats, Message, createMessage } from './types.js';
import { SessionStore } from './session.js';
import { CompactionStrategy } from './compaction.js';
import { buildLLMPayload } from '../utils.js';
import { AppConfig } from './config/index.js';


const appConfig = AppConfig.getInstance();
import { toolsByName, toolsToOpenAITools } from '../tools/index.js';
import type { GuardrailConfigManager } from '../core/config/index.js';
import pino from 'pino';
import type { Logger } from 'pino';

// ---------------------------------------------------------------------------
// MCP client — lazily initialized, properly typed
// ---------------------------------------------------------------------------

interface McpClient {
  connect(transport: McpTransport): Promise<void>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<{ content: unknown[] }>;
}

interface McpTransport {
  connect(client: McpClient): Promise<void>;
  disconnect(): Promise<void>;
}

let mcpClient: McpClient | null = null;
let mcpTransport: McpTransport | null = null;

export async function connectToServer(url: string, logger?: Logger): Promise<boolean> {
    try {
        // Clean up old connection before creating a new one
        if (mcpTransport) {
            try {
                await mcpTransport.disconnect();
            } catch {
                // Best-effort — old connection is about to be replaced anyway
            }
            mcpClient = null;
            mcpTransport = null;
        }
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        mcpClient = new Client({ name: "mcp-client-cli", version: "1.0.0" }) as unknown as McpClient;
        mcpTransport = new StreamableHTTPClientTransport(new URL(url)) as unknown as McpTransport;
        await mcpClient.connect(mcpTransport);
        return true;
    } catch (e) {
        logger?.error({ url, error: String(e) }, 'MCP connection failed');
        return false;
    }
}

// ---------------------------------------------------------------------------
// SSE stream parser — yields parsed SSE events
// ---------------------------------------------------------------------------

interface SseEvent {
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

/**
 * Parses a SSE stream and yields parsed events.
 * Handles partial lines across chunks via a buffer, and accumulates
 * incomplete JSON fragments that span multiple network chunks.
 */
const MAX_PARTIAL_JSON_BYTES = 1024 * 1024; // 1 MB hard cap on accumulated partial JSON

async function* parseSseStream(
    body: ReadableStream,
    logger: Logger
): AsyncIterable<SseEvent> {
    const decoder = new StringDecoder('utf8');
    let buffer = "";
    let partialJson = "";

    for await (const chunk of body) {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.trim()) continue;
            const trimmed = line.trim();
            const data = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed;
            if (data === '[DONE]') return;

            if (data.startsWith('{') || data.startsWith('[')) {
                partialJson += data;
                // Hard cap to prevent memory exhaustion on very long cross-chunk fragments
                if (Buffer.byteLength(partialJson) > MAX_PARTIAL_JSON_BYTES) {
                    logger.warn(
                        { partialLength: Buffer.byteLength(partialJson) },
                        'SSE partial JSON exceeded hard cap, resetting'
                    );
                    // Keep the last 4KB as a rolling window to avoid losing the tail end of a large fragment
                    const lastBytes = 4096;
                    partialJson = partialJson.slice(-lastBytes);
                    continue;
                }
                try {
                    yield JSON.parse(partialJson) as SseEvent;
                    partialJson = "";
                } catch {
                    // incomplete JSON fragment — accumulate more data.
                    // Log for observability; track how often this actually occurs.
                    const truncated = partialJson.length > 120 ? partialJson.slice(0, 120) + '…' : partialJson;
                    logger.warn(
                        { data: String(data), partial: truncated },
                        'SSE partial JSON (cross-chunk fragment)'
                    );
                }
            } else {
                partialJson += data;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// HTTP request with timeout
// ---------------------------------------------------------------------------

interface LlmRequestOptions {
    fetchUrl: string;
    body: string;
    signal?: AbortSignal;
    timeoutMs: number;
}

async function fetchWithTimeout(opts: LlmRequestOptions): Promise<Response> {
    const { fetchUrl, body, signal, timeoutMs } = opts;

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`LLM request timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    const fetchPromise = fetch(fetchUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal
    });

    const res = await Promise.race([fetchPromise, timeoutPromise]) as Response;

    // Clean up timeout — race resolved, no longer needed
    if (timeoutHandle) clearTimeout(timeoutHandle);

    return res;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function dispatchTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: { guardrails?: GuardrailConfigManager; sessionStore?: SessionStore }
): Promise<string> {
    const tool = toolsByName[name];
    if (tool) {
        const result = await tool.execute(args as never, ctx);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    if (mcpClient) {
        const result = await mcpClient.callTool({ name, arguments: args as Record<string, unknown> });
        return JSON.stringify(result.content);
    }
    return "Error: Tool not found and MCP client not connected";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolCallAccumulator {
    index?: number;
    id?: string;
    type?: string;
    function: { name?: string; arguments: string };
}

function updateLastAssistantMessage(
    msgs: Message[],
    updater: (msg: Message) => Message
): Message[] {
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'assistant') {
        msgs[msgs.length - 1] = updater(last);
    } else {
        msgs.push(updater(createMessage({ role: 'assistant', content: '' })));
    }
    return msgs;
}

function appendContent(lastMsg: Message, content: string): Message {
    return { ...lastMsg, content: (lastMsg.content || '') + content };
}

function appendReasoning(lastMsg: Message, reasoning: string): Message {
    return { ...lastMsg, reasoning_content: (lastMsg.reasoning_content || '') + reasoning };
}

function setToolCalls(lastMsg: Message, toolCalls: ToolCallAccumulator[]): Message {
    // Validate that each tool call has a name before type assertion.
    // Missing name would produce invalid tool calls in the LLM payload.
    return { ...lastMsg, tool_calls: toolCalls.map(tc => ({
        index: tc.index,
        id: tc.id,
        type: tc.type,
        function: { name: tc.function.name ?? '', arguments: tc.function.arguments ?? '' }
    })) as Message['tool_calls'] };
}

function logStats(logger: pino.Logger, startTime: bigint, label: string, stats: Stats): void {
    const ns = Number(process.hrtime.bigint() - startTime) / 1e9;
    const duration = ns.toFixed(3);
    logger.debug({ duration: `${duration}s`, tps: stats.tps, label }, `LLM round-trip: ${label}`);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface MakeCallToLLMOptions {
    /** Maximum number of LLM round-trips in the auto-loop (default: 100). */
    maxLoops?: number;
}

export async function makeCallToLLM(
    message: string | undefined,
    tools: any[],
    setStats: React.Dispatch<React.SetStateAction<Stats>>,
    store: SessionStore,
    compactionStrategy: CompactionStrategy,
    guardrails: GuardrailConfigManager,
    sessionLogger: pino.Logger,
    signal?: AbortSignal,
    options?: MakeCallToLLMOptions
) {
    const maxLoops = options?.maxLoops ?? 100;
    const logger = sessionLogger;

    let loopCount = 0;

    while (loopCount < maxLoops) {
        loopCount++;

        // --- Build payload ---
        if (message) {
            store.updateMessages(msgs => [...msgs, createMessage({ role: 'user', content: message })]);
        }
        message = undefined;

        const startTime = process.hrtime.bigint();
        const tokenCount = { value: 0 };
        let didToolCall = false;
        const toolCallsAccum: ToolCallAccumulator[] = [];

        const currentStats: Stats = {
            tokens: 0,
            tps: 0,
            status: 'sending' as const,
            contextSize: 0,
            cachedContextSize: 0
        };
        setStats(() => currentStats);
        store.setStats({ contextSize: currentStats.contextSize });

        const payload = buildLLMPayload(store.getMessages(), toolsToOpenAITools(tools));
        const body = JSON.stringify(payload);
        const chatUrl = new URL('/v1/chat/completions', appConfig.getString('LLAMACPP_URL', 'http://localhost:8080/'));
        const fetchUrl = String(chatUrl);
        const timeoutMs = appConfig.getInt('LLM_TIMEOUT_MS') || 600_000;

        let res: Response;
        try {
            res = await fetchWithTimeout({ fetchUrl, body, signal, timeoutMs });
        } catch (e) {
            const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
            logger.error({ durationMs, url: fetchUrl }, `LLM call failed: ${String(e)}`);
            throw e;
        }

        if (res.status !== 200) {
            const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
            let responseBody = '';
            try { responseBody = await res.text(); } catch { /* ignore */ }
            logger.error({ status: res.status, url: fetchUrl, durationMs: durationMs }, `LLM API error`);
            throw new Error(`LLM error: ${res.status}`);
        }

        // --- Stream processing ---
        if (!res.body) {
            throw new Error("No response body");
        }

 
        let finishReason: string | undefined;
        let streamCompleted = false;

        try {
            for await (const event of parseSseStream(res.body, logger)) {
                if (signal?.aborted) throw new Error("Aborted");

                const choice = event.choices?.[0];
                const delta = choice?.delta;
                if (!delta && !event.timings) continue;

                // Update context/timing stats
                if (event.timings && event.timings.prompt_n !== undefined) {
                    const ctxSize = event.timings.prompt_n + (event.timings.cache_n ?? 0);
                    const cacheSize = event.timings.cache_n ?? 0;
                    currentStats.contextSize = ctxSize;
                    currentStats.cachedContextSize = cacheSize;
                    setStats({ ...currentStats });
                    store.setStats({ contextSize: ctxSize });
                }

                if (!delta) continue;

                tokenCount.value++;
                const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
                const tps = elapsed > 0 ? tokenCount.value / elapsed : 0;

                // --- Reasoning (per-token update for streaming display) ---
                if (delta.reasoning_content) {
                    currentStats.tokens = tokenCount.value;
                    currentStats.tps = 0;
                    currentStats.status = 'thinking';
                    setStats({ ...currentStats });

                    store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => appendReasoning(last, delta.reasoning_content!)));
                }

                // --- Tool calls (buffered — one update at the end) ---
                if (delta.tool_calls) {
                    currentStats.tokens = tokenCount.value;
                    currentStats.tps = tps;
                    currentStats.status = 'tool_calling';
                    setStats({ ...currentStats });

                    for (const tc of delta.tool_calls) {
                        if (!toolCallsAccum[tc.index]) {
                            toolCallsAccum[tc.index] = {
                                id: tc.id ?? randomUUID(),
                                type: tc.type,
                                function: { name: tc.function?.name, arguments: '' }
                            };
                        }
                        if (tc.function?.arguments) {
                            toolCallsAccum[tc.index].function.arguments += tc.function.arguments;
                        }
                    }
                }

                // --- Content (per-token update for streaming display) ---
                if (delta.content) {
                    currentStats.tokens = tokenCount.value;
                    currentStats.tps = tps;
                    currentStats.status = 'generating';
                    setStats({ ...currentStats });

                    store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => appendContent(last, delta.content!)));
                }

                // --- Finish ---
                if (choice?.finish_reason === 'tool_calls') {
                    finishReason = 'tool_calls';
                }
            }
        } catch (e) {
            if (signal?.aborted) throw new Error("Aborted");
            throw e;
        }
        streamCompleted = true;

        // --- Tool execution loop (only if stream completed normally) ---
        if (streamCompleted && finishReason === 'tool_calls' && toolCallsAccum.length > 0) {
            currentStats.status = 'tool_running';
            setStats({ ...currentStats });

            // Finalize tool calls on the assistant message
            store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => setToolCalls(last, toolCallsAccum)));

            for (const tc of toolCallsAccum) {
                try {
                    const args = JSON.parse(tc.function.arguments || '{}');
                    const result = await dispatchTool(tc.function.name || '', args, { guardrails, sessionStore: store });
                    logger.debug({ tool: tc.function.name, tool_call_id: tc.id }, `Tool executed in ${Number(process.hrtime.bigint() - startTime) / 1e6}ms`);
                    store.updateMessages(msgs => [...msgs, createMessage({ role: 'tool', tool_call_id: tc.id, content: String(result) })]);
                } catch (err) {
                    logger.error({ tool: tc.function.name, tool_call_id: tc.id, error: String(err) }, `Tool failed`);
                    store.updateMessages(msgs => [...msgs, createMessage({ role: 'tool', tool_call_id: tc.id, content: String(err) })]);
                }
            }
            didToolCall = true;
        }

        // --- Persistence & compaction ---
        currentStats.contextSize = currentStats.contextSize; // no-op, but keeps intent clear
        try {
            await store.persist();
        } catch (persistErr) {
            logger.error({ error: String(persistErr) }, 'Failed to persist session (non-fatal)');
        }

        if (compactionStrategy.shouldTrigger(store)) {
            try {
                await compactionStrategy.doCompaction(store);
                await store.persist();
            } catch (compactErr) {
                logger.error({ error: String(compactErr) }, 'Compaction failed (non-fatal)');
            }
        }

        // --- End of round-trip ---
        logStats(logger, startTime, 'complete', currentStats);
        currentStats.tokens = tokenCount.value;
        currentStats.tps = 0;
        currentStats.status = 'idle';
        setStats({ ...currentStats });

        if (!didToolCall) break;
    }

    if (loopCount >= maxLoops) {
        logger.warn({ loopCount }, "LLM auto-loop hit max iteration limit");
        throw new Error("Too many loops");
    }
}
