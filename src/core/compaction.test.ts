import { describe, it, expect } from 'vitest';
import { NoOpCompactionStrategy, RunningMemoryStrategy, CompactionProgressCallback } from './compaction.js';
import { Message, createMessage } from './types.js';
import { SessionStore } from './session.js';
import { createSession } from './session.js';

function makeMsg(role: Message['role'], content?: string, reasoning?: string, tool_call_id?: string): Message {
    const msg = createMessage({ role, content });
    if (reasoning !== undefined) {
        (msg as Message & { reasoning_content: string }).reasoning_content = reasoning;
    }
    if (tool_call_id !== undefined) {
        msg.tool_call_id = tool_call_id;
    }
    return msg;
}

function makeStore(sessionId?: string): SessionStore {
    const session = createSession();
    if (sessionId) session.id = sessionId;
    return new SessionStore(session);
}

function makeStoreWithMessages(msgs: Message[], sessionId?: string): SessionStore {
    const session = createSession();
    if (sessionId) session.id = sessionId;
    session.messages = msgs;
    return new SessionStore(session);
}

function makeStoreWithStats(msgs: Message[], contextSize: number, sessionId?: string): SessionStore {
    const session = createSession();
    if (sessionId) session.id = sessionId;
    session.messages = msgs;
    session.stats = { contextSize };
    return new SessionStore(session);
}

describe('NoOpCompactionStrategy', () => {
    it('shouldTrigger always returns false', () => {
        const strategy = new NoOpCompactionStrategy();
        const store = makeStore();
        expect(strategy.shouldTrigger(store)).toBe(false);
    });

    it('doCompaction returns messages unchanged', async () => {
        const strategy = new NoOpCompactionStrategy();
        const expectedMessages = [
            makeMsg('system', 'You are helpful'),
            makeMsg('user', 'Hello'),
            makeMsg('assistant', 'Hi there'),
        ];
        const store = makeStoreWithMessages(expectedMessages);
        await strategy.doCompaction(store);
        const result = store.getMessages();
        expect(result.length).toBe(expectedMessages.length);
        result.forEach((msg, i) => {
            expect(msg.role).toBe(expectedMessages[i].role);
            expect(msg.content).toBe(expectedMessages[i].content);
        });
    });
});

describe('RunningMemoryStrategy', () => {
    it('shouldTrigger returns false when context is below threshold', () => {
        const strategy = new RunningMemoryStrategy({ maxContextSize: 102400, threshold: 0.8 });
        const store = makeStoreWithStats([], 80000);
        expect(strategy.shouldTrigger(store)).toBe(false);
    });

    it('shouldTrigger returns true when context exceeds threshold', () => {
        const strategy = new RunningMemoryStrategy({ maxContextSize: 102400, threshold: 0.8 });
        const store = makeStoreWithStats([], 82000);
        expect(strategy.shouldTrigger(store)).toBe(true);
    });

    it('shouldTrigger respects custom threshold', () => {
        const strategy = new RunningMemoryStrategy({ maxContextSize: 100000, threshold: 0.5 });
        const storeBelow = makeStoreWithStats([], 49000);
        const storeAbove = makeStoreWithStats([], 51000);
        expect(strategy.shouldTrigger(storeBelow)).toBe(false);
        expect(strategy.shouldTrigger(storeAbove)).toBe(true);
    });

    it('doCompaction keeps recent turns with full fidelity', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 2, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [];

        for (let i = 0; i < 10; i++) {
            messages.push(makeMsg('user', `Old question ${i}`));
            messages.push(makeMsg('assistant', `Old answer ${i}`, `Old reasoning ${i}`));
        }
        messages.push(makeMsg('user', 'Recent question'));
        messages.push(makeMsg('assistant', 'Recent answer', 'Recent deep reasoning'));

        const store = makeStoreWithMessages(messages, 'test-session-1');
        await strategy.doCompaction(store);

        const lastMsg = store.getMessages()[store.getMessages().length - 1];
        expect(lastMsg?.role).toBe('assistant');
        expect(lastMsg?.content).toBe('Recent answer');
        expect(lastMsg?.reasoning_content).toBe('Recent deep reasoning');
    });

    it('doCompaction drops reasoning_content from older turns', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 2, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [];

        for (let i = 0; i < 8; i++) {
            messages.push(makeMsg('user', `Old question ${i}`));
            messages.push(makeMsg('assistant', `Old answer ${i}`, `Old reasoning ${i}`));
        }
        messages.push(makeMsg('user', 'Recent question'));
        messages.push(makeMsg('assistant', 'Recent answer', 'Recent deep reasoning'));

        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);

        const olderAssistants = store.getMessages().filter(
            (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.startsWith('Old answer'),
        );
        expect(olderAssistants.length).toBeGreaterThanOrEqual(6);

        const strippedCount = olderAssistants.filter((m) => m.reasoning_content === undefined).length;
        expect(strippedCount).toBeGreaterThanOrEqual(6);
    });

    it('doCompaction externalizes large tool outputs to per-session context.md', async () => {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const pathMod = await import('node:path');

        const tmpDir = fs.default.mkdtempSync(pathMod.default.join(os.default.tmpdir(), 'compaction-test-'));
        const originalCwd = process.cwd;
        Object.defineProperty(process, 'cwd', { value: () => tmpDir });

        const sessionId = 'test-session-uuid-1234';

        try {
            const strategy = new RunningMemoryStrategy({ recentTurns: 1, maxToolOutputSize: 100, maxContextSize: 102400 });
            const messages: Message[] = [
                makeMsg('user', 'Question'),
                makeMsg('assistant', 'Let me check...'),
                makeMsg('tool', 'x'.repeat(200), undefined, 'tool-call-abc'),
                makeMsg('tool', 'small', undefined, 'tool-call-def'),
                makeMsg('user', 'Follow up'),
                makeMsg('assistant', 'Done'),
            ];

            const store = makeStoreWithMessages(messages, sessionId);
            const result = await strategy.doCompaction(store);

            // Large tool output replaced with reference, role='tool' preserved
            const refMsg = store.getMessages().find((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Externalized to session context'));
            expect(refMsg).toBeDefined();
            expect(refMsg?.tool_call_id).toBe('tool-call-abc');

            // Small tool output unchanged
            const smallMsg = store.getMessages().find((m) => m.content === 'small');
            expect(smallMsg).toBeDefined();
            expect(smallMsg?.role).toBe('tool');

            // Per-session compacted tool outputs directory created with individual file
            const outputsDir = pathMod.default.join(tmpDir, '.h', 'sessions', sessionId, 'compacted_tool_outputs');
            expect(fs.default.existsSync(outputsDir)).toBe(true);
            expect(result.contextMdPath).toBe(outputsDir);
            // The externalized file uses UUID-based naming
            const outputFiles = fs.default.readdirSync(outputsDir);
            expect(outputFiles).toHaveLength(1);
            const outputFile = pathMod.default.join(outputsDir, outputFiles[0]);
            const outputContent = fs.default.readFileSync(outputFile, 'utf-8');
            expect(outputContent).toContain('x'.repeat(200));
        } finally {
            Object.defineProperty(process, 'cwd', { value: originalCwd });
            fs.default.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('doCompaction preserves tool_call_id on externalized tool messages', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 0, maxToolOutputSize: 10, maxContextSize: 102400 });
        const messages: Message[] = [
            makeMsg('tool', 'large output here beyond limit', undefined, 'tc-123'),
        ];

        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);

        const refMsg = store.getMessages().find(m => m.role === 'tool' && m.tool_call_id === 'tc-123');
        expect(refMsg).toBeDefined();
        expect(refMsg?.content).toContain('retrieve_tool_output');
    });

    it('doCompaction returns early when not enough messages', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 6, maxContextSize: 102400 });
        const messages = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);
        const result = store.getMessages();
        expect(result.length).toBe(messages.length);
        result.forEach((msg, i) => {
            expect(msg.role).toBe(messages[i].role);
            expect(msg.content).toBe(messages[i].content);
        });
    });

    it('doCompaction preserves user messages in older turns', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 1, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [
            makeMsg('user', 'First question'),
            makeMsg('assistant', 'First answer'),
            makeMsg('user', 'Second question'),
            makeMsg('assistant', 'Second answer'),
            makeMsg('user', 'Third question'),
            makeMsg('assistant', 'Third answer'),
        ];

        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);

        const userMessages = store.getMessages().filter((m) => m.role === 'user');
        expect(userMessages).toHaveLength(3);
        expect(userMessages[0].content).toBe('First question');
        expect(userMessages[1].content).toBe('Second question');
        expect(userMessages[2].content).toBe('Third question');
    });

    it('collapses earlier inline events in the compressed range into a single marker', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 1, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [
            { id: 'e1', role: 'event', event: 'reset', content: 'Session reset' },
            makeMsg('user', 'First question'),
            makeMsg('assistant', 'First answer'),
            { id: 'e2', role: 'event', event: 'compaction_complete', content: 'Compacted earlier' },
            makeMsg('user', 'Second question'),
            makeMsg('assistant', 'Second answer'),
            makeMsg('user', 'Third question'),
            makeMsg('assistant', 'Third answer'),
        ];

        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);

        const events = store.getMessages().filter(m => m.role === 'event');
        // Both earlier events collapse into exactly one history_compacted marker.
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('history_compacted');
        // The recent turn is preserved in full.
        expect(store.getMessages().some(m => m.content === 'Third answer')).toBe(true);
    });

    it('leaves no marker when the compressed range contains no events', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 1, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [
            makeMsg('user', 'First question'),
            makeMsg('assistant', 'First answer'),
            makeMsg('user', 'Second question'),
            makeMsg('assistant', 'Second answer'),
            makeMsg('user', 'Third question'),
            makeMsg('assistant', 'Third answer'),
        ];
        const store = makeStoreWithMessages(messages);
        await strategy.doCompaction(store);
        expect(store.getMessages().some(m => m.role === 'event')).toBe(false);
    });

    it('preserves a start event emitted via onProgress and lets complete patch it in place', async () => {
        // Mirrors the App wiring: onProgress appends/patches inline events on the store.
        const strategy = new RunningMemoryStrategy({ recentTurns: 1, maxToolOutputSize: 2000, maxContextSize: 102400 });
        const messages: Message[] = [
            makeMsg('user', 'First question'),
            makeMsg('assistant', 'First answer'),
            makeMsg('user', 'Second question'),
            makeMsg('assistant', 'Second answer'),
            makeMsg('user', 'Third question'),
            makeMsg('assistant', 'Third answer'),
        ];
        const store = makeStoreWithMessages(messages);
        strategy.onProgress = (phase) => {
            if (phase === 'start') store.appendEvent('compaction_start', 'Compacting…');
            else if (phase === 'complete') store.updateLastEvent(() => ({ event: 'compaction_complete', content: 'Done' }));
        };

        await strategy.doCompaction(store);

        const events = store.getMessages().filter(m => m.role === 'event');
        expect(events).toHaveLength(1);
        expect(events[0].event).toBe('compaction_complete');
        expect(events[0].content).toBe('Done');
    });

    it('doCompaction uses store to resolve compacted outputs path', async () => {
        const strategy = new RunningMemoryStrategy({ recentTurns: 0, maxToolOutputSize: 10, maxContextSize: 102400 });
        const messages: Message[] = [
            makeMsg('tool', 'large output', undefined, 'tc-1'),
        ];

        const sessionId = 'custom-session-id';
        const store = makeStoreWithMessages(messages, sessionId);
        const result = await strategy.doCompaction(store);

        expect(result.contextMdPath).toContain(sessionId);
    });

    it('shouldTrigger works when stats is undefined', () => {
        const strategy = new RunningMemoryStrategy({ maxContextSize: 102400, threshold: 0.8 });
        const session = createSession();
        session.stats = undefined;
        const store = new SessionStore(session);
        // undefined contextSize should not trigger
        expect(strategy.shouldTrigger(store)).toBe(false);
    });

    // -----------------------------------------------------------------------
    // onProgress callback
    // -----------------------------------------------------------------------

    it('emits start phase before processing', async () => {
        const phases: string[] = [];
        const strategy = new RunningMemoryStrategy({
            recentTurns: 0,
            maxToolOutputSize: 10,
            maxContextSize: 102400,
            onProgress: (phase, pct) => phases.push(phase),
        });

        const store = makeStoreWithMessages([
            makeMsg('tool', 'x'.repeat(20), undefined, 'tc-1'),
            makeMsg('tool', 'y'.repeat(20), undefined, 'tc-2'),
        ]);

        await strategy.doCompaction(store);
        expect(phases).toContain('start');
    });

    it('emits complete phase after processing', async () => {
        const phases: (string | undefined)[] = [];
        const strategy = new RunningMemoryStrategy({
            recentTurns: 0,
            maxToolOutputSize: 10,
            maxContextSize: 102400,
            onProgress: (phase, pct) => phases.push([phase, pct]),
        });

        const store = makeStoreWithMessages([
            makeMsg('tool', 'x'.repeat(20), undefined, 'tc-1'),
            makeMsg('tool', 'y'.repeat(20), undefined, 'tc-2'),
        ]);

        await strategy.doCompaction(store);
        const completePhase = phases.find(([p]) => p === 'complete');
        expect(completePhase).toBeDefined();
        expect(completePhase![1]).toBe(100);
    });

    it('calls onProgress in correct order', async () => {
        const order: string[] = [];
        const strategy = new RunningMemoryStrategy({
            recentTurns: 0,
            maxToolOutputSize: 10,
            maxContextSize: 102400,
            onProgress: (phase) => order.push(phase),
        });

        const store = makeStoreWithMessages([
            makeMsg('tool', 'large output here', undefined, 'tc-1'),
        ]);

        await strategy.doCompaction(store);
        expect(order).toEqual(['start', 'complete']);
    });

    it('does not emit phases when threshold not met (early return)', async () => {
        const phases: string[] = [];
        const strategy = new RunningMemoryStrategy({
            recentTurns: 6,
            maxContextSize: 102400,
            onProgress: (phase) => phases.push(phase),
        });

        const store = makeStoreWithMessages([makeMsg('user', 'hi'), makeMsg('assistant', 'hello')]);
        await strategy.doCompaction(store);
        expect(phases).toEqual([]);
    });

    it('noProgress callback is optional', async () => {
        const strategy = new RunningMemoryStrategy({
            recentTurns: 0,
            maxToolOutputSize: 10,
            maxContextSize: 102400,
        });

        const store = makeStoreWithMessages([makeMsg('tool', 'x'.repeat(20), undefined, 'tc-1')]);
        await strategy.doCompaction(store);
        // Should not throw
        expect(store.getMessages()).toBeDefined();
    });
});
