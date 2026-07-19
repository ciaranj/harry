import React from 'react';
import { randomUUID } from 'node:crypto';
import { Stats, Message, createMessage } from './types.js';
import { SessionStore } from './session.js';
import { CompactionStrategy } from './compaction.js';
import { buildLLMPayload } from '../utils.js';
import { AppConfig } from './config/index.js';
import { parseSseStream } from './llm-sse-parser.js';

import pino from 'pino';
import type { Logger } from 'pino';
import type { GuardrailConfigManager } from './config/index.js';

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
// Tool dispatch
// ---------------------------------------------------------------------------

export async function dispatchTool(
    name: string,
    args: Record<string, unknown>,
    ctx?: { guardrails?: GuardrailConfigManager; sessionStore?: SessionStore; abortSignal?: AbortSignal }
): Promise<string> {
    const { toolsByName, toolsToOpenAITools } = await import('../tools/index.js');
    const tool = toolsByName[name];
    if (tool) {
        const result = await tool.execute(args as never, ctx);
        return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    }
    if (mcpClient) {
        const result = await mcpClient.callTool({ name, arguments: args as Record<string, unknown> });
        return JSON.stringify(result.content);
    }
    throw new Error(`Tool not found: ${name} (MCP client not connected)`);
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

function logStats(logger: Logger, startTime: bigint, label: string, stats: Stats): void {
    const ns = Number(process.hrtime.bigint() - startTime) / 1e9;
    const duration = ns.toFixed(3);
    logger.debug({ duration: `${duration}s`, tps: stats.tps, label }, `LLM round-trip: ${label}`);
}

// ---------------------------------------------------------------------------
// HttpClient — abstraction over fetch+timeout
// ---------------------------------------------------------------------------

export interface HttpClient {
    fetchWithTimeout(opts: {
        url: string;
        body: string;
        signal?: AbortSignal;
        timeoutMs: number;
    }): Promise<Response>;
}

/** Default implementation wrapping native fetch with a timeout. */
export function createDefaultHttpClient(): HttpClient {
    async function fetchWithTimeout(opts: {
        url: string;
        body: string;
        signal?: AbortSignal;
        timeoutMs: number;
    }): Promise<Response> {
        const { url, body, signal, timeoutMs } = opts;

        if (signal?.aborted) {
            throw new Error("LLM request aborted");
        }

        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        let aborted = false;
        let fetchController: AbortController | null = null;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                if (!aborted) {
                    fetchController?.abort();
                    reject(new Error(`LLM request timeout after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            if (signal?.aborted) {
                clearTimeout(timeoutHandle!);
            }
            signal?.addEventListener('abort', () => {
                aborted = true;
                clearTimeout(timeoutHandle!);
            });
        });

        if (signal) {
            fetchController = new AbortController();
            signal.addEventListener('abort', () => {
                fetchController?.abort();
            });
        }

        const fetchPromise = fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: fetchController?.signal
        });

        const res = await Promise.race([fetchPromise, timeoutPromise]) as Response;

        aborted = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);

        return res;
    }
    return { fetchWithTimeout };
}

// ---------------------------------------------------------------------------
// LLMConfig — abstraction over AppConfig reads
// ---------------------------------------------------------------------------

export interface LLMConfig {
    getLLMUrl(): string;
    getTimeoutMs(): number;
    getModel(): string;
}

/** Default implementation reading from AppConfig singleton. */
export function createDefaultLLMConfig(): LLMConfig {
    const config = AppConfig.getInstance();
    return {
            getLLMUrl: () => {
            const raw = config.getString('LLAMACPP_URL') || 'http://localhost:8080/';
            return new URL('/v1/chat/completions', raw).toString();
        },
        getTimeoutMs: () => config.getInt('LLM_TIMEOUT_MS') || 600_000,
        getModel: () => config.getString('MODEL') ?? ''
    };
}

// ---------------------------------------------------------------------------
// ToolDispatcher — abstraction over tool execution
// ---------------------------------------------------------------------------

export interface ToolDispatcher {
    dispatchTool(
        name: string,
        args: Record<string, unknown>,
        ctx?: { guardrails?: GuardrailConfigManager; sessionStore?: SessionStore; abortSignal?: AbortSignal }
    ): Promise<string>;
}

/** Default implementation using built-in dispatch. */
export function createDefaultToolDispatcher(): ToolDispatcher {
    return { dispatchTool };
}

// ---------------------------------------------------------------------------
// SleepFn — injectable sleep for test determinism
// ---------------------------------------------------------------------------

export type SleepFn = (ms: number) => Promise<void>;

/** Real sleep using setTimeout. */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Deterministic sleep that resolves immediately. */
export function noopSleep(_ms: number): Promise<void> {
    return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Retry helpers — exported for independent testing
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is retryable (transient network / server errors).
 */
export function isRetryableError(err: unknown): boolean {
    if (err instanceof Error) {
        // Network-level failures
        if (err.message.includes('fetch') || err.message.includes('NetworkError') || err.message.includes('ECONNREFUSED')) {
            return true;
        }
        // Timeout errors are retryable
        if (err.message.includes('timeout') || err.message.includes('timed out')) {
            return true;
        }
        // HTTP 5xx errors
        if (err.message.startsWith('LLM error: 5')) {
            return true;
        }
    }
    // If the error message contains common transient indicators
    if (typeof err === 'string' && /timeout|network|5\d\d|refused|reset/i.test(err)) {
        return true;
    }
    return false;
}

/**
 * Calculate the backoff delay for a given retry attempt (0-indexed).
 */
export function computeBackoff(attempt: number, baseDelayMs: number, jitterFactor: number): number {
    const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * jitterFactor * baseDelayMs * Math.pow(2, attempt);
    return exponentialDelay + jitter;
}

// ---------------------------------------------------------------------------
// SseEventParser — abstraction over SSE parsing
// ---------------------------------------------------------------------------

export interface SseEventParser {
    parseSseStream(body: ReadableStream<Uint8Array>, logger: Logger): AsyncIterable<any>;
}

/** Default implementation wrapping parseSseStream. */
function createDefaultSseEventParser(): SseEventParser {
    return { parseSseStream: (body, logger) => parseSseStream(body, logger) };
}

// ---------------------------------------------------------------------------
// Options types
// ---------------------------------------------------------------------------

export interface MakeCallToLLMOptions {
    /** Maximum number of LLM round-trips in the auto-loop (default: 100). */
    maxLoops?: number;
    /** Maximum number of retries per LLM round-trip before failing (default: 3). */
    maxRetries?: number;
    /** Base delay in ms for exponential backoff (default: 1000). */
    retryBaseDelayMs?: number;
    /** Maximum jitter factor to spread retry times (0-1, default: 0.25). */
    retryJitterFactor?: number;
    /** Full system-prompt override replacing the default (e.g. JOB MODE). */
    systemPrompt?: string;
}

/** All dependencies for a single makeCallToLLM invocation. */
export interface MakeCallToLLMDeps {
    /** HTTP client for fetching LLM responses. */
    client: HttpClient;
    /** Configuration source (url, timeout, model). */
    config: LLMConfig;
    /** User message to send (undefined = continue tool-call loop). */
    message: string | undefined;
    /** OpenAI-format tools array. */
    tools: any[];
    /** Callback to update stats in the UI. Accepts Stats or a reducer fn. */
    setStats: React.Dispatch<React.SetStateAction<Stats>>;
    /** Session store for messages and persistence. */
    store: SessionStore;
    /** Strategy for context compaction. */
    compactionStrategy: CompactionStrategy;
    /** Tool dispatcher for executing tool calls. */
    toolDispatcher: ToolDispatcher;
    /** Logger for the session. */
    sessionLogger: Logger;
    /** Optional abort signal. */
    signal?: AbortSignal;
    /** Retry and loop options. */
    options?: MakeCallToLLMOptions;
}

// ---------------------------------------------------------------------------
// streamOneTurn — one LLM fetch + SSE stream, with retry
// ---------------------------------------------------------------------------

interface RetryOpts {
    maxRetries: number;
    baseDelayMs: number;
    jitterFactor: number;
}

interface StreamOneTurnResult {
    toolCalls: ToolCallAccumulator[];
    finishReason: string | undefined;
    stats: Stats;
}

async function streamOneTurn(
    body: string,
    client: HttpClient,
    url: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    startTime: bigint,
    setStats: React.Dispatch<React.SetStateAction<Stats>>,
    store: SessionStore,
    logger: Logger,
    retryOpts: RetryOpts,
    sleepFn: SleepFn,
): Promise<StreamOneTurnResult> {
    const { maxRetries, baseDelayMs, jitterFactor } = retryOpts;
    const tokenCount = { value: 0 };
    const toolCalls: ToolCallAccumulator[] = [];
    let finishReason: string | undefined;

    const prevContextSize = store.getSnapshot().stats?.contextSize ?? 0;
    const prevCachedContextSize = store.getSnapshot().stats?.cachedContextSize ?? 0;

    const stats: Stats = { tokens: 0, tps: 0, status: 'sending', contextSize: prevContextSize, cachedContextSize: prevCachedContextSize };
    setStats(() => ({ ...stats }));
    store.setStats({ contextSize: prevContextSize, cachedContextSize: prevCachedContextSize });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (signal?.aborted) throw new Error("Aborted");

        let res: Response;
        try {
            res = await client.fetchWithTimeout({ url, body, signal, timeoutMs });
        } catch (e) {
            if (signal?.aborted) throw new Error("Aborted");
            const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
            const isR = isRetryableError(e);
            logger[isR ? 'warn' : 'error']({ attempt, durationMs, url }, isR ? `LLM call failed (retryable): ${String(e)}` : `LLM call failed: ${String(e)}`);
            if (!isR || attempt >= maxRetries) throw e;
            const fetchDelayMs = computeBackoff(attempt, baseDelayMs, jitterFactor);
            logger.debug({ attempt, nextAttempt: attempt + 1, delayMs: fetchDelayMs }, `Retrying LLM call in ${Math.round(fetchDelayMs)}ms`);
            await sleepFn(fetchDelayMs);
            continue;
        }

        if (signal?.aborted) throw new Error("Aborted");

        if (res.status !== 200) {
            const durationMs = Number(process.hrtime.bigint() - startTime) / 1e6;
            const retryable = /^5\d\d$/.test(String(res.status));
            try { await res.text(); } catch { /* ignore */ }
            logger[retryable ? 'warn' : 'error']({ status: res.status, url, durationMs, retryable }, `LLM API error`);
            if (!retryable || attempt >= maxRetries) throw new Error(`LLM error: ${res.status}`);
            const httpDelayMs = computeBackoff(attempt, baseDelayMs, jitterFactor);
            logger.debug({ attempt, nextAttempt: attempt + 1, delayMs: httpDelayMs, status: res.status }, `Retrying LLM call in ${Math.round(httpDelayMs)}ms`);
            await sleepFn(httpDelayMs);
            continue;
        }

        if (!res.body) throw new Error("No response body");

        try {
            for await (const event of parseSseStream(res.body, logger)) {
                if (signal?.aborted) throw new Error("Aborted");

                const choice = event.choices?.[0];
                const delta = choice?.delta;
                if (!delta && !event.timings) continue;

                if (event.timings && event.timings.prompt_n !== undefined) {
                    const ctxSize = event.timings.prompt_n + (event.timings.cache_n ?? 0);
                    stats.contextSize = ctxSize;
                    stats.cachedContextSize = event.timings.cache_n ?? 0;
                    setStats({ ...stats });
                    store.setStats({ contextSize: ctxSize });
                }

                if (!delta) continue;

                tokenCount.value++;
                const elapsed = Number(process.hrtime.bigint() - startTime) / 1e9;
                const tps = elapsed > 0 ? tokenCount.value / elapsed : 0;

                if (delta.reasoning_content) {
                    stats.tokens = tokenCount.value;
                    stats.tps = 0;
                    stats.status = 'thinking';
                    setStats({ ...stats });
                    store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => appendReasoning(last, delta.reasoning_content!)));
                }

                if (delta.tool_calls) {
                    stats.tokens = tokenCount.value;
                    stats.tps = tps;
                    stats.status = 'tool_calling';
                    setStats({ ...stats });
                    for (const tc of delta.tool_calls) {
                        if (!toolCalls[tc.index]) {
                            toolCalls[tc.index] = { id: tc.id ?? randomUUID(), type: tc.type, function: { name: tc.function?.name, arguments: '' } };
                        }
                        if (tc.function?.arguments) {
                            toolCalls[tc.index].function.arguments += tc.function.arguments;
                        }
                    }
                }

                if (delta.content) {
                    stats.tokens = tokenCount.value;
                    stats.tps = tps;
                    stats.status = 'generating';
                    setStats({ ...stats });
                    store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => appendContent(last, delta.content!)));
                }

                if (choice?.finish_reason === 'tool_calls') {
                    finishReason = 'tool_calls';
                }
            }
        } catch (e) {
            if (signal?.aborted) throw new Error("Aborted");
            const isR = isRetryableError(e);
            if (!isR || attempt >= maxRetries) throw e;
            const streamDelayMs = computeBackoff(attempt, baseDelayMs, jitterFactor);
            logger.debug({ attempt, nextAttempt: attempt + 1, delayMs: streamDelayMs }, `Retrying stream in ${Math.round(streamDelayMs)}ms`);
            await sleepFn(streamDelayMs);
            continue;
        }

        break;
    }

    return { toolCalls, finishReason, stats };
}

// ---------------------------------------------------------------------------
// executeToolCalls — dispatch all tool calls and append results to store
// ---------------------------------------------------------------------------

async function executeToolCalls(
    toolCalls: ToolCallAccumulator[],
    store: SessionStore,
    toolDispatcher: ToolDispatcher,
    signal: AbortSignal | undefined,
    logger: Logger,
    startTime: bigint
): Promise<void> {
    store.updateMessages(msgs => updateLastAssistantMessage(msgs, last => setToolCalls(last, toolCalls)));

    for (const tc of toolCalls) {
        try {
            const args = JSON.parse(tc.function.arguments || '{}');
            const result = await toolDispatcher.dispatchTool(tc.function.name || '', args, { sessionStore: store, abortSignal: signal });
            logger.debug({ tool: tc.function.name, tool_call_id: tc.id }, `Tool executed in ${Number(process.hrtime.bigint() - startTime) / 1e6}ms`);
            store.updateMessages(msgs => [...msgs, createMessage({ role: 'tool', tool_call_id: tc.id, content: String(result) })]);
        } catch (err) {
            logger.error({ tool: tc.function.name, tool_call_id: tc.id, error: String(err) }, `Tool failed`);
            store.updateMessages(msgs => [...msgs, createMessage({ role: 'tool', tool_call_id: tc.id, content: String(err) })]);
        }
    }
}

// ---------------------------------------------------------------------------
// persistAndCompact — side-effects after each loop iteration
// ---------------------------------------------------------------------------

async function persistAndCompact(
    store: SessionStore,
    compactionStrategy: CompactionStrategy,
    logger: Logger
): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Make a call to the LLM, handling the tool-call loop, retries, and
 * post-turn side effects (persistence, compaction).
 *
 * All external dependencies are injected via `deps` for testability.
 */
export async function makeCallToLLM(deps: MakeCallToLLMDeps): Promise<void> {
    const {
        client, config, message, tools, setStats, store,
        compactionStrategy, toolDispatcher, sessionLogger,
        signal, options
    } = deps;

    const maxLoops = options?.maxLoops ?? 100;
    const fetchUrl = config.getLLMUrl();
    const timeoutMs = config.getTimeoutMs();
    const retryOpts: RetryOpts = {
        maxRetries: options?.maxRetries ?? 3,
        baseDelayMs: options?.retryBaseDelayMs ?? 1000,
        jitterFactor: options?.retryJitterFactor ?? 0.25,
    };

    let loopCount = 0;
    let lastDidToolCall = false;
    // Consumed on the first iteration only; subsequent iterations are driven by
    // tool-call results, so we clear it to avoid re-appending the same user
    // message on every loop.
    let pendingMessage = message;

    while (loopCount < maxLoops) {
        loopCount++;

        if (pendingMessage) {
            store.updateMessages(msgs => [...msgs, createMessage({ role: 'user', content: pendingMessage })]);
            pendingMessage = undefined;
        }

        const openAITools = (tools ?? []).map(t => ({
            type: 'function' as const,
            function: {
                name: t.name,
                description: t.description,
                parameters: t.schema
            }
        }));
        const body = JSON.stringify(buildLLMPayload(store.getMessages(), openAITools, options?.systemPrompt));

        const startTime = process.hrtime.bigint();
        const { toolCalls, finishReason, stats } = await streamOneTurn(
            body, client, fetchUrl, timeoutMs, signal, startTime, setStats, store, sessionLogger, retryOpts, sleep
        );

        const didToolCall = finishReason === 'tool_calls' && toolCalls.length > 0;

        if (didToolCall) {
            stats.status = 'tool_running';
            setStats({ ...stats });
            await executeToolCalls(toolCalls, store, toolDispatcher, signal, sessionLogger, startTime);
        }

        await persistAndCompact(store, compactionStrategy, sessionLogger);

        logStats(sessionLogger, startTime, 'complete', stats);
        stats.tps = 0;
        stats.status = 'idle';
        setStats({ ...stats });

        lastDidToolCall = didToolCall;
        if (!didToolCall) break;
    }

    // "Too many loops" only if the loop exhausted its budget due to tool calls
    // (i.e., the last iteration that ran was a tool call)
    if (loopCount >= maxLoops && lastDidToolCall) {
        sessionLogger.warn({ loopCount }, "LLM auto-loop hit max iteration limit");
        throw new Error("Too many loops");
    }
}

// ---------------------------------------------------------------------------
// Convenience: create default deps from the existing globals
// ---------------------------------------------------------------------------

export function createDefaultDeps(
    base: Omit<MakeCallToLLMDeps, 'client' | 'config' | 'toolDispatcher'>
): MakeCallToLLMDeps {
    return {
        client: createDefaultHttpClient(),
        config: createDefaultLLMConfig(),
        toolDispatcher: createDefaultToolDispatcher(),
        ...base,
    };
}

// ---------------------------------------------------------------------------

