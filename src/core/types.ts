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

export type Message = {
    id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content?: string;
    reasoning_content?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
};

/** UI-only event: non-LLM state changes visible to the user. */
export type Event = {
    id: string;
    type: 'reset' | 'compaction_start' | 'compaction_progress' | 'compaction_complete';
    content?: string;
    metadata?: Record<string, unknown>;
};

export type Stats = {
    tokens: number;
    tps: number;
    status: 'idle' | 'sending' | 'thinking' | 'generating' | 'tool_calling' | 'tool_running';
    contextSize: number;
    cachedContextSize: number;
};
