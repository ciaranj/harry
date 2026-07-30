import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchUrl, loadManifest, saveManifest } from './fetchUrl.js';
import { createSession, SessionStore } from '../../core/session.js';

// Several tests spy on global.fetch. Without restoring between tests the spies
// stack on global.fetch, so a later test's fresh spy sees inflated call counts
// (e.g. the TTL test counting 2 fetches for a single request).
afterEach(() => {
    vi.restoreAllMocks();
});

function createTestCtx(sessionId?: string) {
  const session = createSession(process.cwd());
  const sessionStore = new SessionStore(session, process.cwd());
  return { sessionStore, actualSessionId: session.id };
}

describe('fetchUrl', () => {
    it('should fetch a valid URL and return content', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/get' });

        expect(result.success).toBe(true);
        expect(typeof result.content).toBe('string');
        expect(result.status).toBe(200);
        expect(typeof result.totalBytes).toBe('number');
        expect(typeof result.truncated).toBe('boolean');
        expect(typeof result.unreadBytes).toBe('number');
    }, 15000);

    it('should return success=false for invalid URL', async () => {
        const result = await fetchUrl.execute({ url: 'https://thisdomaindoesnotexist12345.com' });

        expect(result.success).toBe(false);
        expect(result.status).toBe(0);
        expect(typeof result.content).toBe('string');
    }, 15000);

    it('should return content length info', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/get' });

        if (result.success) {
            expect(result.content.length).toBeGreaterThan(0);
        }
    }, 15000);

    it('should truncate very large responses by default', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000' });

        if (result.success) {
            expect(result.totalBytes).toBe(20000);
            expect(result.truncated).toBe(true);
            expect(result.unreadBytes).toBe(10000);
            expect(result.content.length).toBeGreaterThan(0);
        }
    }, 15000);

    // --- byte-range tests ---

    it('should respect start_byte and end_byte parameters', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000', start_byte: 0, end_byte: 999 });

        if (result.success) {
            expect(result.totalBytes).toBe(20000);
            expect(result.truncated).toBe(true);
            expect(result.unreadBytes).toBe(19000);
            expect(result.content.length).toBeGreaterThan(0);
        }
    }, 15000);

    it('should fetch a later byte range with start_byte', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000', start_byte: 10000 });

        if (result.success) {
            expect(result.totalBytes).toBe(20000);
            expect(result.truncated).toBe(false);
            expect(result.unreadBytes).toBe(0);
            expect(result.content.length).toBeGreaterThan(0);
        }
    }, 15000);

    it('should handle end_byte explicitly set', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000', start_byte: 0, end_byte: 4999 });

        if (result.success) {
            expect(result.totalBytes).toBe(20000);
            expect(result.truncated).toBe(true);
            expect(result.unreadBytes).toBe(15000);
            expect(result.content.length).toBeGreaterThan(0);
        }
    }, 15000);

    it('should return error response with truncated=false for non-200 status', async () => {
        const result = await fetchUrl.execute({ url: 'https://httpbin.org/status/404' });

        expect(result.success).toBe(false);
        expect(result.status).toBe(404);
        expect(result.truncated).toBe(false);
        expect(result.unreadBytes).toBe(0);
    }, 15000);

    // --- session-scoped cache tests ---

    it('should cache results and serve subsequent requests from cache', async () => {
        const sessionId = 'test-cache-session';
        const ctx = createTestCtx(sessionId);

        const fetchSpy = vi.spyOn(global, 'fetch');

        // First fetch: should hit the network
        const result1 = await fetchUrl.execute({ url: 'https://httpbin.org/get' }, ctx);
        expect(result1.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        fetchSpy.mockClear();

        // Second fetch of same URL: served from cache, no HTTP call
        const result2 = await fetchUrl.execute({ url: 'https://httpbin.org/get' }, ctx);
        expect(result2.success).toBe(true);
        expect(result2.content).toBe(result1.content);
        expect(fetchSpy).not.toHaveBeenCalled();
    }, 20000);

    it('should serve byte-range requests from cache without hitting server', async () => {
        const sessionId = 'test-range-cache-session';
        const ctx = createTestCtx(sessionId);

        const fetchSpy = vi.spyOn(global, 'fetch');

        // Full fetch first: should hit the network
        const result1 = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000' }, ctx);
        expect(result1.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        fetchSpy.mockClear();

        // Byte-range fetch: should come from cache, no HTTP call
        const result2 = await fetchUrl.execute({ url: 'https://httpbin.org/bytes/20000', start_byte: 0, end_byte: 999 }, ctx);
        expect(result2.success).toBe(true);
        expect(result2.totalBytes).toBe(20000);
        expect(result2.unreadBytes).toBe(19000);
        expect(result2.content.length).toBeGreaterThan(0);
        expect(fetchSpy).not.toHaveBeenCalled();
    }, 20000);

    it('should expire cache entries after TTL', async () => {
        const ctx = createTestCtx();

        // First fetch
        const result1 = await fetchUrl.execute({ url: 'https://httpbin.org/get' }, ctx);
        expect(result1.success).toBe(true);

        // Manually advance the manifest timestamp to simulate TTL expiry
        const manifest = loadManifest(ctx.actualSessionId, process.cwd(), 300);
        const fetchUrlUrl = 'https://httpbin.org/get';
        expect(manifest[fetchUrlUrl]).toBeDefined();
        expect(manifest[fetchUrlUrl].timestamp).toBeDefined();
        
        manifest[fetchUrlUrl].timestamp = Date.now() - 3600_000; // 1 hour ago
        saveManifest(ctx.actualSessionId, process.cwd(), manifest);

        // Verify the manifest was actually updated — entry should be pruned
        const updatedManifest = loadManifest(ctx.actualSessionId, process.cwd(), 300);
        expect(updatedManifest[fetchUrlUrl]).toBeUndefined();

        const fetchSpy = vi.spyOn(global, 'fetch');

        // Second fetch: should re-fetch because TTL expired
        const result2 = await fetchUrl.execute({ url: 'https://httpbin.org/get' }, ctx);
        expect(result2.success).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    }, 20000);

    // --- render tests ---

    it('renderCallText should show "Fetching" with the URL', () => {
        const text = fetchUrl.renderCallText({ url: 'https://example.com' });
        expect(text).toBe('Fetching https://example.com');
    });

    it('renderCallText should handle URLs with paths and query strings', () => {
        const text = fetchUrl.renderCallText({ url: 'https://api.example.com/data?key=value' });
        expect(text).toBe('Fetching https://api.example.com/data?key=value');
    });

    it('renderCallText should handle empty URL', () => {
        const text = fetchUrl.renderCallText({ url: '' });
        expect(text).toBe('Fetching ');
    });

    it('renderResult should show HTTP status and byte counts', () => {
        const result = fetchUrl.renderResult({
            success: true,
            content: 'hello',
            status: 200,
            totalBytes: 5,
            truncated: false,
            unreadBytes: 0,
        });
        expect(result.props.children).toContain('HTTP 200');
        expect(result.props.children).toContain('5 bytes total');
    });
});
