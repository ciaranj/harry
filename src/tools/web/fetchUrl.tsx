import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';
import { sessionDirPath } from '../../core/session.js';
import { AppConfig } from '../../core/config/index.js';

// ---------------------------------------------------------------------------
// Configurable limits
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 60_000;          // 60 seconds
const DEFAULT_CACHE_TTL_SECONDS = 300;       // 5 minutes

const appConfig = AppConfig.getInstance();

function getConfiguredLimits(): { maxBytes: number; timeoutMs: number; cacheTtlSeconds: number } {
  return {
    maxBytes: appConfig.getInt('FETCH_URL_MAX_BYTES') || DEFAULT_MAX_BYTES,
    timeoutMs: appConfig.getInt('FETCH_URL_TIMEOUT_MS') || DEFAULT_TIMEOUT_MS,
    cacheTtlSeconds: appConfig.getInt('FETCH_URL_CACHE_TTL_SECONDS') || DEFAULT_CACHE_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------------
// Session-scoped cache
// ---------------------------------------------------------------------------

const FETCH_CACHE_DIR = 'fetch_cache';

/** Resolve the directory where fetched URLs are cached for a session. */
function cacheDirPath(sessionId: string, cwd: string = process.cwd()): string {
  return path.join(sessionDirPath(sessionId, cwd), FETCH_CACHE_DIR);
}

interface CacheEntry {
  filePath: string;
  size: number;
  timestamp: number;  // epoch ms when cached
}

interface CacheManifest {
  [url: string]: CacheEntry;
}

/** Load the cache manifest for a session, pruning expired entries. */
export function loadManifest(sessionId: string, cwd: string, ttlSeconds: number): CacheManifest {
  try {
    const filePath = path.join(cacheDirPath(sessionId, cwd), 'manifest.json');
    if (!fs.existsSync(filePath)) return {};
    const manifest = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CacheManifest;
    const now = Date.now();
    const expiredUrls = Object.entries(manifest).filter(([_, entry]) => (now - entry.timestamp) > ttlSeconds * 1000);
    for (const [url] of expiredUrls) {
      const entry = manifest[url];
      try {
        if (fs.existsSync(entry.filePath)) fs.rmSync(entry.filePath, { force: true });
      } catch { /* best-effort */ }
      delete manifest[url];
    }
    if (expiredUrls.length > 0) {
      saveManifest(sessionId, cwd, manifest);
    }
    return manifest;
  } catch {
    return {};
  }
}

/** Persist the cache manifest for a session. */
export function saveManifest(sessionId: string, cwd: string, manifest: CacheManifest): void {
  const dirPath = cacheDirPath(sessionId, cwd);
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const filePath = path.join(dirPath, 'manifest.json');
    fs.writeFileSync(filePath, JSON.stringify(manifest), 'utf-8');
  } catch {
    // Silently ignore — cache is best-effort
  }
}

/** Get a cache file path for a URL. */
function cacheFilePath(sessionId: string, url: string, cwd: string = process.cwd()): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return path.join(cacheDirPath(sessionId, cwd), `${hash}.bin`);
}

/** Clean up stale cache files for a session (keeps only files referenced by manifest). */
function pruneCache(sessionId: string, cwd: string = process.cwd()): void {
  try {
    const dirPath = cacheDirPath(sessionId, cwd);
    if (!fs.existsSync(dirPath)) return;
    // Pass Infinity TTL so prune doesn't expire entries it's trying to keep
    const manifest = loadManifest(sessionId, cwd, Infinity);
    const manifestFiles = new Set(Object.values(manifest).map(e => path.basename(e.filePath)));
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (entry === 'manifest.json' || manifestFiles.has(entry)) continue;
      fs.rmSync(path.join(dirPath, entry), { force: true });
    }
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Streaming fetch → cache file
// ---------------------------------------------------------------------------

interface StreamResult {
  totalBytes: number;
  status: number;
  truncated: boolean;
  sizeLimitExceeded: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/**
 * Streams a fetch response to a file with size and timeout limits.
 * Returns the stream result (total bytes, whether truncated/timeout).
 * On error (non-2xx), cleans up the partial file.
 */
async function streamToCacheFile(
  url: string,
  filePath: string,
  maxBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(url, { signal });
  const contentLength = res.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

  let sizeLimitExceeded = false;

  // Non-2xx: stream body for side-effects, clean up file, return early
  if (!res.ok) {
    try {
      if (res.body) {
        for await (const _chunk of res.body) { /* drain */ }
      }
    } catch { /* ignore drain errors */ }
    const actualBytes = filePath && fs.existsSync(filePath) ? (await fsPromises.stat(filePath)).size : 0;
    if (filePath && fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    return {
      totalBytes: actualBytes,
      status: res.status,
      truncated: false,
      sizeLimitExceeded: false,
      timedOut: false,
      aborted: false,
    };
  }

  const writeStream = fs.createWriteStream(filePath);
  let bytesWritten = 0;

  // Build a timeout promise
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`fetch_url timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  // Build an abort promise
  let abortResolve: () => void;
  const abortPromise = new Promise<void>((resolve) => {
    abortResolve = resolve;
    signal?.addEventListener('abort', () => {
      resolve();
    });
  });

  // Wait for the stream to finish, timeout, or abort
  let timedOut = false;
  let aborted = false;
  let streamEnded = false;
  try {
    await Promise.race([
      (async () => {
        if (!res.body) {
          writeStream.end();
          streamEnded = true;
          return;
        }
        for await (const chunk of res.body) {
          // Check if aborted during streaming
          if (signal?.aborted) {
            aborted = true;
            writeStream.end();
            streamEnded = true;
            break;
          }
          // Check size limit before writing
          if (bytesWritten + chunk.byteLength > maxBytes) {
            // Write remaining bytes up to the limit, then stop
            const remaining = maxBytes - bytesWritten;
            if (remaining > 0) {
              writeStream.write(chunk.slice(0, remaining));
              bytesWritten += remaining;
            }
            sizeLimitExceeded = true;
            writeStream.end();
            streamEnded = true;
            break;
          }
          writeStream.write(chunk);
          bytesWritten += chunk.byteLength;
        }
        if (!streamEnded) {
          writeStream.end();
          streamEnded = true;
        }
      })(),
      timeoutPromise,
      abortPromise,
    ]);
  } catch (err: any) {
    timedOut = true;
    if (!writeStream.closed) {
      writeStream.destroy();
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  // Always wait for the write stream to flush — even if already ended,
  // the drain may not have completed yet (finish event could be missed)
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    if (!streamEnded) writeStream.end();
  });

  const actualBytes = fs.existsSync(filePath) ? (await fsPromises.stat(filePath)).size : 0;

  return {
    totalBytes: actualBytes,
    status: res.status,
    truncated: actualBytes > 0 && (sizeLimitExceeded || (totalBytes > 0 && actualBytes !== totalBytes)),
    sizeLimitExceeded,
    timedOut,
    aborted,
  };
}

// ---------------------------------------------------------------------------
// Read a byte range from a file
// ---------------------------------------------------------------------------

function readByteRange(filePath: string, start: number, limit: number): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const bytesRead = fs.readSync(fd, buffer, 0, limit, start);
    return buffer.toString('utf-8', 0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

interface FetchUrlArgs {
  url: string;
  start_byte?: number; // inclusive, 0-indexed
  end_byte?: number;   // inclusive, 0-indexed; defaults to start_byte + 9999 if start_byte set
}

interface FetchUrlResult {
  success: boolean;
  content: string;
  status: number;
  totalBytes: number;  // total response size in bytes
  truncated: boolean;  // was response truncated?
  unreadBytes: number; // bytes not returned
}

function renderFetchUrlCall(url: string): string {
  return `Fetching ${url}`;
}

export const fetchUrl: Tool<FetchUrlArgs, FetchUrlResult> = {
  name: "fetch_url",
  description: "Fetches the content of a URL and returns it as text. Supports byte-range pagination via start_byte/end_byte. A 10KB default limit applies; when truncated, unreadBytes tells you how much more is available to fetch with a higher start_byte. Results are cached in the session directory so partial re-fetches do not hit the server again.",
  schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "The URL to fetch." },
      start_byte: { type: "number", description: "Inclusive byte offset to start reading from (0-indexed). Defaults to 0." },
      end_byte: { type: "number", description: "Inclusive byte offset to end reading at (0-indexed). When not provided, reads a window of up to 10000 bytes starting from start_byte." }
    },
    required: ["url"]
  } as const,
  execute: async ({ url, start_byte, end_byte }: FetchUrlArgs, ctx?: ToolCallContext): Promise<FetchUrlResult> => {
    const { maxBytes, timeoutMs, cacheTtlSeconds } = getConfiguredLimits();

    // Resolve session-scoped cache path
    const cwd = process.cwd();
    let sessionId: string | null = null;
    let manifest: CacheManifest = {};
    if (ctx?.sessionStore) {
      const snap = ctx.sessionStore.getSnapshot();
      sessionId = snap.id;
      manifest = loadManifest(sessionId, cwd, cacheTtlSeconds);
    }

    const cachedFile = sessionId ? cacheFilePath(sessionId, url, cwd) : null;
    const cachedEntry = sessionId ? manifest[url] : undefined;

    // Determine whether we have a valid cache entry
    const hasCache = cachedEntry && fs.existsSync(cachedEntry.filePath) && cachedEntry.size > 0;

    // --- Cache hit: serve from file ---
    if (hasCache) {
      const cachedSize = cachedEntry.size;
      const byteStart = Math.max(0, Math.min(start_byte ?? 0, cachedSize));
      const limit = end_byte !== undefined
        ? Math.min(end_byte - byteStart + 1, cachedSize - byteStart)
        : 10000;
      const content = readByteRange(cachedEntry.filePath, byteStart, limit);
      const truncated = cachedSize > byteStart + limit;
      const unreadBytes = Math.max(0, cachedSize - (byteStart + limit));

      return {
        success: true,
        content,
        status: 200,
        totalBytes: cachedSize,
        truncated,
        unreadBytes,
      };
    }

    // --- Cache miss: fetch, stream to cache, then read ---
    try {
      // Ensure cache directory exists if we have a session
      if (sessionId) {
        fs.mkdirSync(cacheDirPath(sessionId, cwd), { recursive: true });
      }

      // Use a temp file when no session; session-scoped file otherwise
      const targetPath = cachedFile ?? fs.mkdtempSync(path.join(os.tmpdir(), 'harry-fetch-')) + '/temp.bin';
      const streamResult = await streamToCacheFile(
        url,
        targetPath,
        maxBytes,
        timeoutMs,
        ctx?.abortSignal,
      );

      if (streamResult.aborted) {
        return {
          success: false,
          content: `Error fetching URL "${url}": fetch aborted by client`,
          status: 0,
          totalBytes: 0,
          truncated: false,
          unreadBytes: 0,
        };
      }

      if (streamResult.timedOut) {
        return {
          success: false,
          content: `Error fetching URL "${url}": fetch_url timeout after ${timeoutMs}ms`,
          status: 0,
          totalBytes: 0,
          truncated: false,
          unreadBytes: 0,
        };
      }

      if (streamResult.sizeLimitExceeded) {
        return {
          success: false,
          content: `Error fetching URL "${url}": response exceeded max size limit of ${maxBytes} bytes`,
          status: 0,
          totalBytes: streamResult.totalBytes,
          truncated: true,
          unreadBytes: Math.max(0, streamResult.totalBytes - maxBytes),
        };
      }

      // Non-2xx HTTP status
      if (streamResult.status >= 400) {
        return {
          success: false,
          content: `Error fetching URL "${url}": HTTP ${streamResult.status}`,
          status: streamResult.status,
          totalBytes: streamResult.totalBytes,
          truncated: false,
          unreadBytes: 0,
        };
      }

      // Read the requested byte range from the file
      if (!fs.existsSync(targetPath)) {
        return {
          success: false,
          content: `Error fetching URL "${url}": no response body`,
          status: streamResult.status,
          totalBytes: 0,
          truncated: false,
          unreadBytes: 0,
        };
      }
      const fileStat = await fsPromises.stat(targetPath);
      const actualSize = fileStat.size;
      const byteStart = Math.max(0, Math.min(start_byte ?? 0, actualSize));
      const limit = end_byte !== undefined
        ? Math.min(end_byte - byteStart + 1, actualSize - byteStart)
        : 10000;
      const content = readByteRange(targetPath, byteStart, limit);
      const truncated = actualSize > byteStart + limit;
      const unreadBytes = Math.max(0, actualSize - (byteStart + limit));

      // Update cache manifest (session-scoped only)
      if (sessionId) {
        manifest[url] = { filePath: cachedFile!, size: actualSize, timestamp: Date.now() };
        saveManifest(sessionId, cwd, manifest);
        pruneCache(sessionId, cwd);
      }

      return {
        success: true,
        content,
        status: streamResult.status || 200,
        totalBytes: actualSize,
        truncated,
        unreadBytes,
      };
    } catch (error: any) {
      return {
        success: false,
        content: `Error fetching URL "${url}": ${error.message}`,
        status: 0,
        totalBytes: 0,
        truncated: false,
        unreadBytes: 0,
      };
    }
  },
  renderCall: ({ url }: FetchUrlArgs) => (
    <Text color="cyan">{renderFetchUrlCall(url)}</Text>
  ),
  renderCallText: ({ url }: FetchUrlArgs) =>
    renderFetchUrlCall(url),
  renderResult: (result: FetchUrlResult) => (
    <Text color={result.success ? "green" : "red"}>
      {result.status === 0
        ? result.content
        : `HTTP ${result.status} (${result.totalBytes} bytes total, ${result.content.length} returned${result.truncated ? `, ${result.unreadBytes} unread` : ''})`
      }
    </Text>
  )
};
