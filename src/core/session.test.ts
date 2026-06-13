import { describe, it, expect } from 'vitest';
import { createSession } from './session.js';
import { SessionStore } from './session.js';
import { Message, createMessage } from './types.js';

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

// ---------------------------------------------------------------------------
// resolveConflict — dedup uses stable UUIDs, not role+index
// ---------------------------------------------------------------------------

describe('SessionStore.resolveConflict', () => {
    it('deduplicates overlapping messages by UUID and appends local-only', () => {
        // Remote has two messages with IDs
        const remoteMsg1 = createMessage({ role: 'user', content: 'remote-q1' });
        const remoteMsg2 = createMessage({ role: 'assistant', content: 'remote-a1' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg1, remoteMsg2];

        // Local has: one overlaps (same ID), one unique
        const overlapping = createMessage({ role: 'user', content: 'local-q1-same-as-remote' }); // same ID as remoteMsg1
        const localOnly = createMessage({ role: 'user', content: 'local-only' });
        const localSession = createSession();
        localSession.messages = [overlapping, localOnly];

        // Manually set overlapping.id to remoteMsg1.id so they match
        overlapping.id = remoteMsg1.id;

        const store = makeStoreWithMessages(localSession.messages, 'local-id');

        store.resolveConflict(remoteSession);

        const result = store.getMessages();

        // Should have remote messages + local-only
        expect(result).toHaveLength(3);
        expect(result[0].id).toBe(remoteMsg1.id);
        expect(result[1].id).toBe(remoteMsg2.id);
        expect(result[2].id).toBe(localOnly.id);
    });

    it('all-local messages appended when no overlap', () => {
        const remoteMsg = createMessage({ role: 'user', content: 'remote' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg];

        const localMsg1 = createMessage({ role: 'user', content: 'local-1' });
        const localMsg2 = createMessage({ role: 'assistant', content: 'local-2' });
        const localSession = createSession();
        localSession.messages = [localMsg1, localMsg2];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        expect(result).toHaveLength(3);
        expect(result[0].id).toBe(remoteMsg.id);
        expect(result[1].id).toBe(localMsg1.id);
        expect(result[2].id).toBe(localMsg2.id);
    });

    it('no local messages appended when all overlap', () => {
        const remoteMsg = createMessage({ role: 'user', content: 'remote' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg];

        const localSession = createSession();
        const localMsg = createMessage({ role: 'user', content: 'local' });
        localMsg.id = remoteMsg.id; // same ID = overlap
        localSession.messages = [localMsg];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('remote');
    });

    it('handles old sessions without IDs (undefined) — appends local as distinct', () => {
        // Simulate loaded session from disk where id is missing
        const remoteSession = createSession();
        const msg = { role: 'user' as const, content: 'old-disk-msg' } as Message;
        remoteSession.messages = [msg];

        const localSession = createSession();
        const localMsg = createMessage({ role: 'user', content: 'new-msg' });
        localSession.messages = [localMsg];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        // undefined id !== undefined id → Set.has returns false → local appended
        // This is acceptable: old sessions get duplicated during transition, then
        // new messages get proper IDs and dedup resumes correctly
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('old-disk-msg');
        expect(result[1].content).toBe('new-msg');
    });

    it('preserves tool_call_id and reasoning_content on non-overlapping messages', () => {
        const remoteMsg = createMessage({ role: 'tool', tool_call_id: 'tc-123', content: 'remote-tool-result' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg];

        const localMsg = createMessage({
            role: 'user',
            content: 'local-followup',
            reasoning_content: 'thinking out loud'
        });
        const localSession = createSession();
        localSession.messages = [localMsg];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        expect(result).toHaveLength(2);
        expect(result[0].tool_call_id).toBe('tc-123');
        expect(result[1].reasoning_content).toBe('thinking out loud');
    });

    it('uses stable UUIDs, not role+index — different content same role stays distinct', () => {
        const remoteMsg = createMessage({ role: 'user', content: 'remote-same-role' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg];

        // Local has same role, different content, different ID
        const localMsg = createMessage({ role: 'user', content: 'local-same-role-diff-content' });
        const localSession = createSession();
        localSession.messages = [localMsg];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        // Both should be present because IDs differ
        expect(result).toHaveLength(2);
        expect(result[0].content).toBe('remote-same-role');
        expect(result[1].content).toBe('local-same-role-diff-content');
    });

    it('does not duplicate messages when called twice with same remote', () => {
        const remoteMsg = createMessage({ role: 'user', content: 'remote' });
        const remoteSession = createSession();
        remoteSession.messages = [remoteMsg];

        const localMsg = createMessage({ role: 'assistant', content: 'local' });
        const localSession = createSession();
        localSession.messages = [localMsg];

        const store = makeStoreWithMessages(localSession.messages);
        store.resolveConflict(remoteSession);
        store.resolveConflict(remoteSession);

        const result = store.getMessages();
        expect(result).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// SessionStore events — appendEvent, updateLastEvent, getEvents
// ---------------------------------------------------------------------------

describe('SessionStore events', () => {
    it('appendEvent adds an event and notifies listeners', () => {
        const store = makeStore();
        let notified = false;
        const unsub = store.subscribe(() => { notified = true; unsub(); });

        store.appendEvent('reset', 'Session reset');

        expect(notified).toBe(true);
        expect(store.getEvents()).toHaveLength(1);
        expect(store.getEvents()[0].type).toBe('reset');
        expect(store.getEvents()[0].content).toBe('Session reset');
    });

    it('appendEvent stores metadata when provided', () => {
        const store = makeStore();
        store.appendEvent('compaction_progress', 'Compacting…', { pct: 50 });
        const events = store.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('compaction_progress');
        expect(events[0].metadata).toEqual({ pct: 50 });
    });

    it('appendEvent generates unique UUIDs', () => {
        const store = makeStore();
        store.appendEvent('reset', 'Reset 1');
        store.appendEvent('compaction_start', 'Compact');
        const events = store.getEvents();
        expect(events[0].id).not.toBe(events[1].id);
    });

    it('getEvents returns empty array when no events', () => {
        const store = makeStore();
        expect(store.getEvents()).toHaveLength(0);
    });

    it('getEvents returns empty for sessions without events field', () => {
        const session = createSession();
        session.events = undefined;
        const store = new SessionStore(session);
        expect(store.getEvents()).toHaveLength(0);
    });

    it('updateLastEvent replaces the last event', () => {
        const store = makeStore();
        store.appendEvent('compaction_start', 'Compacting…');
        store.updateLastEvent(() => ({
            type: 'compaction_complete',
            content: 'Done',
        }));
        const events = store.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('compaction_complete');
        expect(events[0].content).toBe('Done');
    });

    it('updateLastEvent with partial update preserves other fields', () => {
        const store = makeStore();
        store.appendEvent('compaction_progress', 'Compacting…', { pct: 50 });
        store.updateLastEvent(() => ({ content: 'Still going…' }));
        const events = store.getEvents();
        expect(events[0].content).toBe('Still going…');
        expect(events[0].type).toBe('compaction_progress');
        expect(events[0].metadata).toEqual({ pct: 50 });
    });

    it('updateLastEvent does nothing when no events exist', () => {
        const store = makeStore();
        store.updateLastEvent(() => ({ content: 'nope' }));
        expect(store.getEvents()).toHaveLength(0);
    });

    it('updateLastEvent notifies listeners', () => {
        const store = makeStore();
        store.appendEvent('compaction_start', 'Start');
        let notified = false;
        const unsub = store.subscribe(() => { notified = true; unsub(); });

        store.updateLastEvent(() => ({ content: 'Updated' }));

        expect(notified).toBe(true);
        expect(store.getEvents()[0].content).toBe('Updated');
    });

    it('multiple appends then updates keeps correct event list', () => {
        const store = makeStore();
        store.appendEvent('reset', 'Reset');
        store.appendEvent('compaction_start', 'Start');
        store.appendEvent('compaction_progress', 'Progress', { pct: 30 });
        store.updateLastEvent(() => ({ content: '75%' }));

        const events = store.getEvents();
        expect(events).toHaveLength(3);
        expect(events[0].type).toBe('reset');
        expect(events[1].type).toBe('compaction_start');
        expect(events[2].type).toBe('compaction_progress');
        expect(events[2].content).toBe('75%');
    });

    it('events are included in getSnapshot', () => {
        const store = makeStore();
        store.appendEvent('reset', 'Reset');
        const snapshot = store.getSnapshot();
        expect(snapshot.events).toHaveLength(1);
        expect(snapshot.events![0].type).toBe('reset');
    });
});
