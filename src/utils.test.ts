import { describe, it, expect, beforeAll } from 'vitest';
import { buildLLMPayload } from './utils.js';
import { Message } from './core/types.js';

describe('buildLLMPayload', () => {
    beforeAll(() => {
        // Ensure MODEL is set for the test
        process.env.MODEL = 'test-model';
    });

    it('should include the tools array in the payload', () => {
        const tools = [{ type: 'function', function: { name: 'test_tool' } }];
        const payload = buildLLMPayload([], tools);

        expect(payload.tools).toEqual(tools);
    });

    it('should set stream and cache_prompt to true', () => {
        const payload = buildLLMPayload([], []);

        expect(payload.stream).toBe(true);
        expect(payload.cache_prompt).toBe(true);
    });

    it('filters out inline event messages so they never reach the LLM', () => {
        const messages: Message[] = [
            { id: '1', role: 'user', content: 'hello' },
            { id: '2', role: 'event', event: 'reset', content: 'Session reset' },
            { id: '3', role: 'assistant', content: 'hi' },
            { id: '4', role: 'event', event: 'compaction_complete', content: 'Compacted' },
        ];
        const payload = buildLLMPayload(messages, []);

        // system prompt + the two non-event messages, no events.
        expect(payload.messages.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
        expect(payload.messages.some(m => m.role === 'event')).toBe(false);
    });
});
