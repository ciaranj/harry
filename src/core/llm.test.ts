import { describe, it, expect, beforeEach, afterEach, vi, Mock, Mocked } from 'vitest';
import { NoOpCompactionStrategy } from './compaction.js';
import { Message, createMessage } from './types.js';
import { SessionStore } from './session.js';
import { createSession } from './session.js';

// ===================================================================
// Helpers
// ===================================================================

function makeStore(messages: Message[]): SessionStore {
    const session = createSession();
    session.messages = messages;
    return new SessionStore(session);
}

function messagesEqual(a: Message[], b: Message[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((msg, i) =>
        msg.role === b[i].role &&
        msg.content === b[i].content &&
        msg.reasoning_content === b[i].reasoning_content &&
        msg.tool_call_id === b[i].tool_call_id &&
        JSON.stringify(msg.tool_calls) === JSON.stringify(b[i].tool_calls)
    );
}

// ===================================================================
// NoOpCompactionStrategy tests (existing, kept)
// ===================================================================

describe('NoOpCompactionStrategy', () => {
    let strategy: NoOpCompactionStrategy;

    beforeEach(() => {
        strategy = new NoOpCompactionStrategy();
    });

    describe('shouldTrigger', () => {
        it('should always return false', () => {
            const messages: Message[] = [
                createMessage({ role: 'user', content: 'test' }),
                createMessage({ role: 'assistant', content: 'response' })
            ];

            const result = strategy.shouldTrigger(makeStore(messages));
            expect(result).toBe(false);
        });

        it('should return false even with many messages', () => {
            const messages: Message[] = Array(100).fill(null).map(() => createMessage({ role: 'user', content: 'test' }));

            const result = strategy.shouldTrigger(makeStore(messages));
            expect(result).toBe(false);
        });
    });

    describe('doCompaction', () => {
        it('should return messages unchanged', async () => {
            const messages: Message[] = [
                createMessage({ role: 'user', content: 'first' }),
                createMessage({ role: 'assistant', content: 'reply' }),
                createMessage({ role: 'user', content: 'second' })
            ];

            const store = makeStore(messages);
            await strategy.doCompaction(store);
            expect(messagesEqual(store.getMessages(), messages)).toBe(true);
        });

        it('should not modify empty message list', async () => {
            const store = makeStore([]);
            await strategy.doCompaction(store);
            expect(store.getMessages()).toEqual([]);
        });

        it('should handle messages with all fields', async () => {
            const messages: Message[] = [
                createMessage({ role: 'assistant', content: 'response', reasoning_content: 'reasoning' }),
                createMessage({ role: 'tool', tool_call_id: '1', content: 'tool result' })
            ];
            (messages[0] as Message & { tool_calls: any[] }).tool_calls = [{ id: '1', function: { name: 'test', arguments: '{}' } }];

            const store = makeStore(messages);
            await strategy.doCompaction(store);
            expect(messagesEqual(store.getMessages(), messages)).toBe(true);
        });
    });
});

// ===================================================================
// Injected dependencies — makeCallToLLM (deps-based) tests
// ===================================================================

// Set env before importing llm module
process.env.MODEL = 'test-model';
process.env.LLAMACPP_URL = 'http://localhost:8080/';

import {
    makeCallToLLM,
    MakeCallToLLMOptions,
    HttpClient,
    LLMConfig,
    ToolDispatcher,
    SleepFn,
    noopSleep,
} from './llm.js';
import { createDefaultConfigStore } from './config/index.js';
import { GuardrailConfigManager } from './config/index.js';

// ===================================================================
// Test utilities
// ===================================================================

function mockStreamResponse(
    bodyChunks: string[],
    status = 200,
    headers: Record<string, string> = {}
): Response {
    const body = new ReadableStream({
        start(controller) {
            for (const chunk of bodyChunks) {
                controller.enqueue(new TextEncoder().encode(chunk));
            }
            controller.close();
        }
    });

    return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream', ...headers } });
}

function mockSseChunk(content: string): string {
    const data = JSON.stringify({
        timings: { prompt_n: 100, cache_n: 50 },
        choices: [{ delta: { content } }]
    });
    return `data: ${data}\n\n`;
}

function mockToolCallSse(
    toolCallId: string,
    toolName: string,
    toolArgs: string
): string {
    const event = {
        timings: { prompt_n: 50, cache_n: 20 },
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: toolCallId,
                    type: 'function',
                    function: { name: toolName, arguments: toolArgs }
                }]
            },
            finish_reason: 'tool_calls'
        }]
    };
    return `data: ${JSON.stringify(event)}\n\n`;
}

function makeGuardrails(): GuardrailConfigManager {
    const store = createDefaultConfigStore();
    return new GuardrailConfigManager(store);
}

/** Create a mock pino logger that has debug, warn, error methods. */
function makeMockLogger() {
    return {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        child: vi.fn(() => makeMockLogger()),
    };
}

// Default fast retry for tests that need retries (10ms base instead of 1s)
const FAST_RETRY: Partial<MakeCallToLLMOptions> = { retryBaseDelayMs: 10, retryJitterFactor: 0 };

/**
 * Build partial deps (legacy helper, use buildFullDeps for full deps).
 * Only the given `opts` override the defaults.
 */
function buildDeps(
    overrides: Partial<MakeCallToLLMOptions> & {
        client?: HttpClient;
        config?: Partial<LLMConfig>;
        toolDispatcher?: ToolDispatcher;
        sleepFn?: SleepFn;
        message?: string;
        setStats?: ReturnType<typeof vi.fn>;
        store?: SessionStore;
        compactionStrategy?: NoOpCompactionStrategy;
        guardrails?: GuardrailConfigManager;
        sessionLogger?: ReturnType<typeof makeMockLogger>;
        signal?: AbortSignal;
    } = {}
): MakeCallToLLMOptions & { client: HttpClient; config: LLMConfig; toolDispatcher: ToolDispatcher } {
    const client = overrides.client ?? {
        fetchWithTimeout: vi.fn().mockResolvedValue(mockStreamResponse([mockSseChunk('default')])),
    };
    const config = overrides.config ?? {
        getLLMUrl: () => 'http://localhost:8080/v1/chat/completions',
        getTimeoutMs: () => 5000,
        getModel: () => 'test-model',
    };
    const toolDispatcher = overrides.toolDispatcher ?? {
        dispatchTool: vi.fn().mockResolvedValue('ok'),
    };

    return {
        client: client as HttpClient,
        config: config as LLMConfig,
        toolDispatcher: toolDispatcher as ToolDispatcher,
        ...overrides,
    };
}

/**
 * Build full deps for makeCallToLLM, nesting options properly.
 */
function buildFullDeps(overrides: {
    client?: HttpClient;
    config?: Partial<LLMConfig>;
    toolDispatcher?: ToolDispatcher;
    message?: string;
    setStats?: ReturnType<typeof vi.fn>;
    store?: SessionStore;
    compactionStrategy?: NoOpCompactionStrategy;
    guardrails?: GuardrailConfigManager;
    sessionLogger?: ReturnType<typeof makeMockLogger>;
    signal?: AbortSignal;
    options?: MakeCallToLLMOptions;
}) {
    const client = overrides.client ?? {
        fetchWithTimeout: vi.fn().mockResolvedValue(mockStreamResponse([mockSseChunk('default')])),
    };
    const config = overrides.config ?? {
        getLLMUrl: () => 'http://localhost:8080/v1/chat/completions',
        getTimeoutMs: () => 5000,
        getModel: () => 'test-model',
    };
    const toolDispatcher = overrides.toolDispatcher ?? {
        dispatchTool: vi.fn().mockResolvedValue('ok'),
    };
    const options = overrides.options ?? {};
    return {
        client: client as HttpClient,
        config: config as LLMConfig,
        toolDispatcher: toolDispatcher as ToolDispatcher,
        message: overrides.message,
        setStats: overrides.setStats ?? vi.fn(),
        store: overrides.store ?? makeStore([]),
        compactionStrategy: overrides.compactionStrategy ?? new NoOpCompactionStrategy(),
        guardrails: overrides.guardrails ?? makeGuardrails(),
        sessionLogger: overrides.sessionLogger ?? makeMockLogger(),
        signal: overrides.signal,
        options,
    };
}

// ===================================================================
// Tests — retry, abort, tool calls, stats, persistence
// ===================================================================

describe('makeCallToLLM — deps-based integration', () => {
    let fetchMock: Mocked<HttpClient>['fetchWithTimeout'];
    let loggerMock: ReturnType<typeof makeMockLogger>;

    beforeEach(() => {
        fetchMock = vi.fn();
        global.fetch = vi.fn();
        loggerMock = makeMockLogger();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllTimers();
    });

    it('should succeed on first attempt without retry', async () => {
        fetchMock.mockResolvedValueOnce(mockStreamResponse([
            mockSseChunk('Hello'),
            '[DONE]'
        ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();
        const toolDispatcher = { dispatchTool: vi.fn().mockResolvedValue('ok') };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'test message',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, maxRetries: 0 },
        });

        await makeCallToLLM(deps);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(setStats).toHaveBeenCalled();
    });

    it('should retry on network-level fetch error', async () => {
        const error = new Error('NetworkError: ECONNREFUSED');
        fetchMock
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce(mockStreamResponse([
                mockSseChunk('Retry worked'),
                '[DONE]'
            ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should retry on 5xx status codes', async () => {
        fetchMock
            .mockResolvedValueOnce({ status: 500, body: null } as Response)
            .mockResolvedValueOnce(mockStreamResponse([
                mockSseChunk('500 retry ok'),
                '[DONE]'
            ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should retry on 502 Bad Gateway', async () => {
        fetchMock
            .mockResolvedValueOnce({ status: 502, body: null } as Response)
            .mockResolvedValueOnce(mockStreamResponse([
                mockSseChunk('ok'),
                '[DONE]'
            ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on 4xx status codes', async () => {
        fetchMock.mockResolvedValueOnce({ status: 400, body: null } as Response);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow('LLM error: 400');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 401 Unauthorized', async () => {
        fetchMock.mockResolvedValueOnce({ status: 401, body: null } as Response);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow('LLM error: 401');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should respect custom maxRetries limit', async () => {
        const error = new Error('NetworkError');
        fetchMock.mockRejectedValue(error);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1, maxRetries: 1, ...FAST_RETRY },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should respect a custom retry count of 0 — no retry', async () => {
        const error = new Error('NetworkError');
        fetchMock.mockRejectedValue(error);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1, maxRetries: 0 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should succeed after retries and continue loop for tool calls', async () => {
        const toolCallId = 'tc-test-1';
        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'))
            .mockResolvedValueOnce(mockStreamResponse([
                mockToolCallSse(toolCallId, 'read_files', '{"paths":[]}'),
                '[DONE]'
            ]))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('done'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();
        const toolDispatcher = {
            dispatchTool: vi.fn().mockResolvedValue('tool result'),
        };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 4, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);

        expect(fetchMock).toHaveBeenCalledTimes(3);

        const messages = store.getMessages();
        const toolCallMsg = messages.find(m => m.role === 'assistant' && m.tool_calls);
        expect(toolCallMsg).toBeDefined();
        expect(toolCallMsg!.tool_calls).toHaveLength(1);
        expect(toolCallMsg!.tool_calls![0].function.name).toBe('read_files');
    });

    it('should throw after exhausting retries on persistent failure', async () => {
        fetchMock.mockRejectedValue(new Error('NetworkError'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1, maxRetries: 2, ...FAST_RETRY },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should respect abort signal during retry wait', async () => {
        fetchMock.mockRejectedValueOnce(new Error('NetworkError'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const abortController = new AbortController();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            signal: abortController.signal,
            options: { maxLoops: 1, retryBaseDelayMs: 200, retryJitterFactor: 0 },
        });

        const callPromise = makeCallToLLM(deps);
        await new Promise(r => setTimeout(r, 100));
        abortController.abort();

        await expect(callPromise).rejects.toThrow('Aborted');
        expect(fetchMock).toHaveBeenCalled();
    });

    it('should respect abort signal after fetch completes', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'))
            .mockResolvedValueOnce(mockStreamResponse([
                mockSseChunk('after retry'),
                '[DONE]'
            ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const abortController = new AbortController();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            signal: abortController.signal,
            options: { maxLoops: 2, retryBaseDelayMs: 100, retryJitterFactor: 0 },
        });

        const callPromise = makeCallToLLM(deps);
        await new Promise(r => setTimeout(r, 50));
        abortController.abort();

        await expect(callPromise).rejects.toThrow('Aborted');
    });

    it('should not retry when signal is already aborted', async () => {
        const abortController = new AbortController();
        abortController.abort();

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            signal: abortController.signal,
            options: { maxLoops: 1 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow('Aborted');
        expect(fetchMock).toHaveBeenCalledTimes(0);
    });

    it('should preserve message content after successful retry', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'))
            .mockResolvedValueOnce(mockStreamResponse([
                mockSseChunk('After retry'),
                '[DONE]'
            ]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'retry test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);

        const messages = store.getMessages();
        const userMsg = messages.find(m => m.role === 'user' && m.content === 'retry test');
        expect(userMsg).toBeDefined();

        const assistantMsg = messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toContain('After retry');
    });

    it('should use default maxRetries of 3', async () => {
        fetchMock.mockRejectedValue(new Error('NetworkError'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1, ...FAST_RETRY },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('should retry on timeout errors', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('LLM request timeout after 600000ms'))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('timeout retry ok'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2, ...FAST_RETRY },
        });

        await makeCallToLLM(deps);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on non-retryable errors (e.g. generic Error)', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Some random error'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 1 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow('Some random error');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should call tool dispatcher and append tool result messages on tool_calls finish', async () => {
        // maxLoops: 2 so the first iteration's tool call completes and the loop exits normally
        const toolCallId = 'tc-tool-test-1';
        fetchMock
            .mockResolvedValueOnce(mockStreamResponse([
                mockToolCallSse(toolCallId, 'read_files', '{"path":"test.txt"}'),
                '[DONE]'
            ]))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('ok')]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();
        const toolDispatcher = {
            dispatchTool: vi.fn().mockResolvedValue('file contents: hello'),
        };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'read test.txt',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await makeCallToLLM(deps);

        expect(toolDispatcher.dispatchTool).toHaveBeenCalledWith(
            'read_files',
            { path: 'test.txt' },
            expect.objectContaining({ sessionStore: store })
        );

        const messages = store.getMessages();
        const toolResultMsg = messages.find(m => m.role === 'tool');
        expect(toolResultMsg).toBeDefined();
        expect(toolResultMsg!.content).toBe('file contents: hello');
    });

    it('should append the initial user message only once across tool-call loops', async () => {
        // Regression: the loop used to re-append `message` on every iteration
        // because it was never consumed, so after a tool call the original user
        // message reappeared as a fresh user message on the next turn.
        const toolCallId = 'tc-once-1';
        fetchMock
            .mockResolvedValueOnce(mockStreamResponse([
                mockToolCallSse(toolCallId, 'read_files', '{"path":"test.txt"}'),
                '[DONE]'
            ]))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('done')]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const toolDispatcher = {
            dispatchTool: vi.fn().mockResolvedValue('file contents: hello'),
        };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'read test.txt',
            setStats: vi.fn(),
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await makeCallToLLM(deps);

        const userMsgs = store.getMessages().filter(
            m => m.role === 'user' && m.content === 'read test.txt'
        );
        expect(userMsgs).toHaveLength(1);
    });

    it('should handle tool failure gracefully', async () => {
        // maxLoops: 2 so the first iteration's tool call completes and the loop exits normally
        const toolCallId = 'tc-fail-1';
        fetchMock
            .mockResolvedValueOnce(mockStreamResponse([
                mockToolCallSse(toolCallId, 'read_files', '{"path":"nope.txt"}'),
                '[DONE]'
            ]))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('ok')]));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();
        const toolDispatcher = {
            dispatchTool: vi.fn().mockRejectedValue(new Error('file not found')),
        };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'read nope.txt',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await makeCallToLLM(deps);

        const messages = store.getMessages();
        const toolResultMsg = messages.find(m => m.role === 'tool');
        expect(toolResultMsg).toBeDefined();
        expect(toolResultMsg!.content).toContain('file not found');
    });

    it('should hit max loops and throw "Too many loops"', async () => {
        const toolCallId = 'tc-loop-1';
        fetchMock
            .mockResolvedValueOnce(mockStreamResponse([mockToolCallSse(toolCallId, 'noop', '{}'), '[DONE]']))
            .mockResolvedValueOnce(mockStreamResponse([mockToolCallSse(toolCallId, 'noop', '{}'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();
        const toolDispatcher = {
            dispatchTool: vi.fn().mockResolvedValue('ok'),
        };

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            toolDispatcher,
            message: 'start',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await expect(makeCallToLLM(deps)).rejects.toThrow('Too many loops');
    });

    it('should set context size stats from SSE timings', async () => {
        const timingsChunk = `data: ${JSON.stringify({
            timings: { prompt_n: 200, cache_n: 100 },
            choices: [{ delta: { content: 'hi' } }]
        })}\n\n`;

        fetchMock.mockResolvedValueOnce(mockStreamResponse([timingsChunk, '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await makeCallToLLM(deps);

        // setStats should have been called with contextSize=prompt_n+cache_n=300
        const calls = setStats.mock.calls;
        const lastCall = calls[calls.length - 1];
        expect(lastCall[0].contextSize).toBe(300);
        expect(lastCall[0].cachedContextSize).toBe(100);
    });

    it('should handle reasoning_content in SSE stream', async () => {
        const reasoningChunk = `data: ${JSON.stringify({
            timings: { prompt_n: 10, cache_n: 5 },
            choices: [{ delta: { reasoning_content: 'thinking about it' } }]
        })}\n\n`;
        const contentChunk = `data: ${JSON.stringify({
            choices: [{ delta: { content: 'answer' } }]
        })}\n\n`;

        fetchMock.mockResolvedValueOnce(mockStreamResponse([reasoningChunk, contentChunk, '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const deps = buildFullDeps({
            client: { fetchWithTimeout: fetchMock },
            message: 'test',
            setStats,
            store,
            compactionStrategy: new NoOpCompactionStrategy(),
            guardrails,
            sessionLogger: loggerMock,
            options: { maxLoops: 2 },
        });

        await makeCallToLLM(deps);

        const messages = store.getMessages();
        const assistantMsg = messages.find(m => m.role === 'assistant');
        expect(assistantMsg!.reasoning_content).toContain('thinking about it');
        expect(assistantMsg!.content).toContain('answer');
        // The last setStats before the final idle status reflects the generating phase
        expect(setStats.mock.calls.at(-2)[0].status).toBe('generating');
    });
});

// ===================================================================
// Unit tests for exported helpers
// ===================================================================

import { isRetryableError, computeBackoff, sleep } from './llm.js';

describe('isRetryableError', () => {
    it('should retry on fetch errors', () => {
        expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    });

    it('should retry on NetworkError', () => {
        expect(isRetryableError(new Error('NetworkError: timeout'))).toBe(true);
    });

    it('should retry on ECONNREFUSED', () => {
        expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    });

    it('should retry on timeout errors', () => {
        expect(isRetryableError(new Error('LLM request timeout after 600000ms'))).toBe(true);
    });

    it('should retry on 5xx LLM errors', () => {
        expect(isRetryableError(new Error('LLM error: 500'))).toBe(true);
    });

    it('should retry on string with network indicators', () => {
        expect(isRetryableError('network reset')).toBe(true);
        expect(isRetryableError('timeout occurred')).toBe(true);
        expect(isRetryableError('503 service unavailable')).toBe(true);
    });

    it('should NOT retry on non-retryable errors', () => {
        expect(isRetryableError(new Error('Some random error'))).toBe(false);
        expect(isRetryableError('some random string')).toBe(false);
    });
});

describe('computeBackoff', () => {
    it('should return exponential delay for attempt 0', () => {
        const result = computeBackoff(0, 1000, 0);
        expect(result).toBe(1000); // no jitter with factor 0
    });

    it('should double delay for attempt 1', () => {
        const result = computeBackoff(1, 1000, 0);
        expect(result).toBe(2000);
    });

    it('should double delay for attempt 2', () => {
        const result = computeBackoff(2, 1000, 0);
        expect(result).toBe(4000);
    });

    it('should add jitter proportional to factor', () => {
        const result = computeBackoff(0, 1000, 1); // max jitter
        expect(result).toBeGreaterThanOrEqual(1000);
        expect(result).toBeLessThanOrEqual(2000);
    });
});

describe('sleep / noopSleep', () => {
    it('sleep should resolve after the given delay', async () => {
        const start = Date.now();
        await sleep(50);
        expect(Date.now() - start).toBeGreaterThanOrEqual(40);
    });

    it('noopSleep should resolve immediately', async () => {
        const start = Date.now();
        await noopSleep(5000);
        expect(Date.now() - start).toBeLessThan(100);
    });
});
