import { randomUUID } from 'node:crypto';

/** Create a new message with a stable UUID. */
export function createMessage(
    props: Omit<Message, 'id'>
): Message {
    return {
        id: randomUUID(),
        ...props
    };
}

export interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
    name?: string;  // deprecated alias for tc.function.name
}

/**
 * UI-only event kinds. These live inline in the message stream (role: 'event')
 * so they stay temporally ordered with the conversation, but they are filtered
 * out of the LLM payload (see buildLLMPayload).
 *
 * 'history_compacted' is the single marker compaction leaves behind when it
 * collapses one or more earlier events that fell inside the compressed range.
 */
export type EventType =
    | 'reset'
    | 'compaction_start'
    | 'compaction_progress'
    | 'compaction_complete'
    | 'history_compacted';

export type Message = {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system' | 'event';
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** Present iff role === 'event'. The kind of UI-only event. */
    event?: EventType;
    /** Free-form metadata, currently used by events (e.g. { pct } for progress). */
    metadata?: Record<string, unknown>;
};

/** True for messages that are UI-only and must never reach the LLM. */
export function isEventMessage(m: Message): boolean {
    return m.role === 'event';
}

export type Stats = {
    tokens: number;
    tps: number;
    status: 'idle' | 'sending' | 'thinking' | 'generating' | 'tool_calling' | 'tool_running';
    contextSize: number;
    cachedContextSize: number;
};
