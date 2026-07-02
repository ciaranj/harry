import { Message, isEventMessage } from './core/types.js';
import { systemPrompt } from './constants.js';
import { AppConfig } from './core/config/index.js';

const config = AppConfig.getInstance();

export interface LLMPayload {
    model: string | undefined;
    messages: { role: string; content?: string; reasoning_content?: string; tool_calls?: any[] }[];
    tools: any[];
    stream: boolean;
    cache_prompt: boolean;
}

/**
 * Builds the payload to be sent to the LLM.
 *
 * `systemPromptOverride`, when provided, fully replaces the default
 * interactive `systemPrompt` for this call (e.g. the standalone JOB MODE
 * prompt used by `harry -j`). Modes select a complete prompt rather than
 * mutating a shared one.
 */
export function buildLLMPayload(messages: Message[], tools: any[], systemPromptOverride?: string): LLMPayload {
    return {
        model: config.getString('MODEL'),
        messages: [
            { role: 'system', content: systemPromptOverride ?? systemPrompt },
            // UI-only events (resets, compaction markers) live inline in the
            // message stream for temporal ordering, but must never be sent to
            // the model. This is the single chokepoint that strips them.
            ...messages.filter(m => !isEventMessage(m))
        ],
        tools,
        stream: true,
        cache_prompt: true
    };
}
