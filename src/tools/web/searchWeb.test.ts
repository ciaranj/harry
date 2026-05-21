import { describe, it, expect, vi } from 'vitest';
import { searchWeb } from './searchWeb.js';

describe('searchWeb', () => {
    it('should return results when SEARXNG is configured', async () => {
        const searxngUrl = process.env.SEARXNG_URL;
        if (!searxngUrl) {
            expect(true).toBe(true);
            return;
        }

        const result = await searchWeb.execute({ query: 'test query' });

        expect(result.success).toBe(true);
        if (result.results.length > 0) {
            expect(result.results[0]).toHaveProperty('title');
            expect(result.results[0]).toHaveProperty('url');
            expect(result.results[0]).toHaveProperty('content');
        }
    }, 15000);

    it('should return success=true even with no results', async () => {
        const searxngUrl = process.env.SEARXNG_URL;
        if (!searxngUrl) {
            expect(true).toBe(true);
            return;
        }

        const result = await searchWeb.execute({ query: 'xyznonexistentquery12345abc' });

        expect(result.success).toBe(true);
    }, 15000);

    it('should handle special characters in query', async () => {
        const searxngUrl = process.env.SEARXNG_URL;
        if (!searxngUrl) {
            expect(true).toBe(true);
            return;
        }

        const result = await searchWeb.execute({ query: 'test & search "quotes"' });

        expect(result.success).toBe(true);
    }, 15000);

    // --- renderCallText tests ---

    it('renderCallText should show "Searching web for" with the query', () => {
        const text = searchWeb.renderCallText({ query: 'how to use vitest' });
        expect(text).toBe('Searching web for "how to use vitest"');
    });

    it('renderCallText should handle empty query', () => {
        const text = searchWeb.renderCallText({ query: '' });
        expect(text).toBe('Searching web for ""');
    });

    it('renderCallText should include special characters in the query', () => {
        const text = searchWeb.renderCallText({ query: 'test & "quotes"' });
        expect(text).toBe('Searching web for "test & "quotes""');
    });

    // --- timeout test ---

    it('should timeout when SEARXNG is slow to respond', async () => {
        vi.useFakeTimers();
        const fetchSpy = vi.spyOn(global, 'fetch');

        // Mock fetch to resolve after 120s (longer than the 60s default timeout)
        fetchSpy.mockImplementation(
            () => new Promise((resolve) =>
                setTimeout(() => resolve({ ok: true, json: () => Promise.resolve({ results: [] }) }), 120000)
            )
        );

        const result = searchWeb.execute({ query: 'timeout test' });
        // Advance time past the 60s timeout
        vi.advanceTimersByTime(61000);

        const resolved = await result;

        expect(resolved.success).toBe(false);
        expect(resolved.results).toEqual([]);
        fetchSpy.mockRestore();
        vi.useRealTimers();
    }, 5000);
});
