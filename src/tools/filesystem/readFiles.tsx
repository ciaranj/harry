import { readFile, stat as fsStat } from 'node:fs/promises';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';

interface ReadFileLineRange {
  path: string;
  start: number;
  end: number;
}

interface ReadFilesArgs {
  paths: ReadFileLineRange[];
}

interface FileReadResult {
  path: string;
  success: boolean;
  content?: string;
  error?: string;
  lineCount?: number;
  /** True when the 20KB cumulative limit was reached; content may be partial. */
  truncated: boolean;
  /** Unread bytes remaining in the file after truncation (0 when not truncated). */
  unreadBytes: number;
}

const MAX_BYTES = 20 * 1024; // 20KB cumulative byte limit across all files


export const readFiles: Tool<ReadFilesArgs, FileReadResult[]> = {
  name: "read_files",
  description: "Read the contents of one or more files and return them in a single call. A cumulative 20KB (20,480 byte) limit applies across all files in one call. When the limit is reached, the current file and all subsequent files are marked as truncated with remaining unread byte counts.",
  schema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items:
            {
              type: "object",
              properties: {
                path: { type: "string", description: "File path." },
                start: { type: "number", description: "Starting line number (1-indexed, inclusive)." },
                end: { type: "number", description: "Ending line number (1-indexed, inclusive)." }
              },
              required: ["path"]
            },
        description: "List of filepaths with optional line ranges to read."
      }
    },
    required: ["paths"]
  } as const,
  execute: async ({ paths }: ReadFilesArgs, _ctx?: ToolCallContext): Promise<FileReadResult[]> => {
    if (paths.length === 0) return [];

    const results: FileReadResult[] = [];
    // Cache per-path content to avoid re-reading the same file multiple times
    const cache = new Map<string, string>();
    let totalBytesRead = 0;
    let limitReached = false;

    for (const entry of paths) {
      // Once limit is reached, all subsequent files are truncated (no content)
      if (limitReached) {
        // Try to get file size for unread byte report
        let fileStatSize = 0;
        try {
          fileStatSize = (await fsStat(entry.path)).size ?? 0;
        } catch { /* file may have been deleted */ }
        results.push({
          path: entry.path,
          success: true,
          content: undefined,
          error: undefined,
          truncated: true,
          unreadBytes: fileStatSize,
        });
        continue;
      }

      if (entry.start === undefined || entry.end === undefined) {
        // Full file read
        try {
          let content = cache.get(entry.path);
          if (content === undefined) {
            content = await readFile(entry.path, 'utf-8');
            cache.set(entry.path, content);
          }
          const byteLen = Buffer.byteLength(content, 'utf-8');
          const truncated = totalBytesRead + byteLen > MAX_BYTES;
          const actualBytes = truncated ? Math.max(0, MAX_BYTES - totalBytesRead) : byteLen;

          totalBytesRead += actualBytes;

          results.push({
            path: entry.path,
            success: true,
            content: truncated ? content.slice(0, Math.floor(actualBytes)) : content,
            error: undefined,
            lineCount: undefined,
            truncated,
            unreadBytes: truncated ? byteLen - actualBytes : 0,
          });

          if (truncated) limitReached = true;
        } catch (error: any) {
          results.push({
            path: entry.path,
            success: false,
            content: undefined,
            error: error.message,
            truncated: false,
            unreadBytes: 0,
          });
        }
      } else {
        // Line-range read
        const { path: p, start, end } = entry;
        try {
          let content = cache.get(p);
          if (content === undefined) {
            content = await readFile(p, 'utf-8');
            cache.set(p, content);
          }
          const allLines = content.split('\n');
          const s = Math.max(1, start);
          const e = Math.min(allLines.length, end);
          if (s > e || s > allLines.length) {
            results.push({
              path: p,
              success: false,
              content: undefined,
              error: `Line range ${start}-${end} is out of bounds for file with ${allLines.length} lines`,
              truncated: false,
              unreadBytes: 0,
            });
            continue;
          }
          const excerpt = allLines.slice(s - 1, e).join('\n');
          const byteLen = Buffer.byteLength(excerpt, 'utf-8');
          const truncated = totalBytesRead + byteLen > MAX_BYTES;
          const actualBytes = truncated ? Math.max(0, MAX_BYTES - totalBytesRead) : byteLen;

          totalBytesRead += actualBytes;

          results.push({
            path: p,
            success: true,
            content: truncated ? excerpt.slice(0, Math.floor(actualBytes)) : excerpt,
            error: undefined,
            lineCount: truncated ? undefined : e - s + 1,
            truncated,
            unreadBytes: truncated ? byteLen - actualBytes : 0,
          });

          if (truncated) limitReached = true;
        } catch (error: any) {
          results.push({
            path: p,
            success: false,
            content: undefined,
            error: error.message,
            truncated: false,
            unreadBytes: 0,
          });
        }
      }
    }

    return results;
  },
  renderCall: ({ paths }: ReadFilesArgs) => (
    <Text color="cyan">{renderReadFilesCall(paths)}</Text>
  ),
  renderCallText: ({ paths }: ReadFilesArgs) =>
    renderReadFilesCall(paths),
  renderResult: (results: FileReadResult[]) => (
    <Text color="gray">
      {results.map((r: FileReadResult) =>
        r.success
          ? `${r.path}: OK${r.truncated ? ` (truncated: ${r.unreadBytes} unread)` : r.lineCount ? ` (${r.lineCount} lines)` : ` (${(r.content?.length ?? 0)} bytes)`}`
          : `${r.path}: FAILED (${r.error})`
      ).join("\n")}
    </Text>
  )
};

function renderReadFilesCall(paths: ReadFileLineRange[]): string {
  return "Reading " + paths.map((p) =>
    typeof p === 'string' ? p : (p.start != null && p.end != null ? `${p.path}:${p.start}-${p.end}` : p.path)
  ).join(", ");
}
