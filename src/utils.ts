import { Message } from './core/types.js';
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
 */
export function buildLLMPayload(messages: Message[], tools: any[]): LLMPayload {
    return {
        model: config.getString('MODEL'),
        messages: [
            { role: 'system', content: systemPrompt },
            ...messages
        ],
        tools,
        stream: true,
        cache_prompt: true
    };
}
