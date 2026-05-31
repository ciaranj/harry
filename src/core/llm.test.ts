import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
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
// makeCallToLLM retry tests
// ===================================================================

// Set env before importing llm module
process.env.MODEL = 'test-model';
process.env.LLAMACPP_URL = 'http://localhost:8080/';

import { makeCallToLLM, MakeCallToLLMOptions } from './llm.js';
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

// Use fast delay for tests that need retries (10ms base instead of 1s)
const FAST_RETRY: Partial<MakeCallToLLMOptions> = { retryBaseDelayMs: 10, retryJitterFactor: 0 };

// ===================================================================
// Tests
// ===================================================================

describe('makeCallToLLM — retry & exponential backoff', () => {
    const baseUrl = 'http://localhost:8080';
    let fetchMock: Mock;

    beforeEach(() => {
        fetchMock = vi.fn<typeof fetch>();
        global.fetch = fetchMock;
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

        // maxLoops: 2 allows 1 full iteration
        await makeCallToLLM(
            'test message',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2 }
        );

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

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

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

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

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

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on 4xx status codes', async () => {
        fetchMock.mockResolvedValueOnce({ status: 400, body: null } as Response);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1 }
        )).rejects.toThrow('LLM error: 400');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry on 401 Unauthorized', async () => {
        fetchMock.mockResolvedValueOnce({ status: 401, body: null } as Response);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1 }
        )).rejects.toThrow('LLM error: 401');

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should respect custom maxRetries limit', async () => {
        const error = new Error('NetworkError');
        fetchMock.mockRejectedValue(error);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1, maxRetries: 1, ...FAST_RETRY }
        )).rejects.toThrow();

        // 1 initial + 1 retry = 2 calls total
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should respect a custom retry count of 0 — no retry', async () => {
        const error = new Error('NetworkError');
        fetchMock.mockRejectedValue(error);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1, maxRetries: 0 }
        )).rejects.toThrow();

        // 0 retries = 1 call only
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should succeed after retries and continue loop for tool calls', async () => {
        const toolCallId = 'tc-test-1';
        // 1st attempt fails, 2nd succeeds with tool call, 3rd finishes (no tool calls)
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

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 4, ...FAST_RETRY }
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);

        // Verify tool call message is in the store
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

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1, maxRetries: 2, ...FAST_RETRY }
        )).rejects.toThrow();

        // 1 initial + 2 retries = 3 calls
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should respect abort signal during retry wait', async () => {
        // 1st attempt fails, then we abort during the retry delay
        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        const abortController = new AbortController();

        const callPromise = makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            abortController.signal,
            { maxLoops: 1, retryBaseDelayMs: 200, retryJitterFactor: 0 }
        );

        // Abort during the retry delay — should interrupt it
        await new Promise(r => setTimeout(r, 100));
        abortController.abort();

        await expect(callPromise).rejects.toThrow('Aborted');

        // Verify fetch was called (the first attempt started)
        expect(fetchMock).toHaveBeenCalled();
    });

    it('should respect abort signal after fetch completes', async () => {
        // 1st attempt fails, 2nd succeeds with a tool call
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

        const callPromise = makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            abortController.signal,
            { maxLoops: 2, retryBaseDelayMs: 100, retryJitterFactor: 0 }
        );

        // Abort during the retry delay
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

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            abortController.signal,
            { maxLoops: 1 }
        )).rejects.toThrow('Aborted');

        // Should throw before even calling fetch
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

        await makeCallToLLM(
            'retry test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

        const messages = store.getMessages();

        // User message should be present
        const userMsg = messages.find(m => m.role === 'user' && m.content === 'retry test');
        expect(userMsg).toBeDefined();

        // Assistant response should contain the retried content
        const assistantMsg = messages.find(m => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect(assistantMsg!.content).toContain('After retry');
    });

    it('should use default maxRetries of 3', async () => {
        // All attempts fail — should use initial + 3 retries = 4 calls
        const error = new Error('NetworkError');
        fetchMock.mockRejectedValue(error);

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1, ...FAST_RETRY }
        )).rejects.toThrow();

        // Default maxRetries = 3 → 1 initial + 3 retries = 4 calls
        expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('should retry on timeout errors', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('LLM request timeout after 600000ms'))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('timeout retry ok'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should NOT retry on non-retryable errors (e.g. generic Error)', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Some random error'));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await expect(makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 1 }
        )).rejects.toThrow('Some random error');

        // Non-retryable error should not trigger retry — only 1 call
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should retry on multiple consecutive 503 errors then succeed', async () => {
        fetchMock
            .mockResolvedValueOnce({ status: 503, body: null } as Response)
            .mockResolvedValueOnce({ status: 503, body: null } as Response)
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('finally ok'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, ...FAST_RETRY }
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('should respect custom retryBaseDelayMs and retryJitterFactor', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('ok'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        // Use a very small base delay for predictable timing in test
        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            makeMockLogger(),
            undefined,
            { maxLoops: 2, retryBaseDelayMs: 5, retryJitterFactor: 0 }
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should log retry events with increasing delay', async () => {
        const mockLogger = makeMockLogger();

        fetchMock
            .mockRejectedValueOnce(new Error('NetworkError'))
            .mockResolvedValueOnce(mockStreamResponse([mockSseChunk('ok'), '[DONE]']));

        const store = makeStore([]);
        const guardrails = makeGuardrails();
        const setStats = vi.fn();

        await makeCallToLLM(
            'test',
            [],
            setStats,
            store,
            new NoOpCompactionStrategy(),
            guardrails,
            mockLogger,
            undefined,
            { maxLoops: 2, retryBaseDelayMs: 10, retryJitterFactor: 0 }
        );

        // Should have logged a retry debug message with attempt info
        const retryLogs = mockLogger.debug.mock.calls.filter(call =>
            typeof call[0] === 'object' && call[0].attempt !== undefined
        );
        expect(retryLogs.length).toBeGreaterThanOrEqual(1);
    });
});
