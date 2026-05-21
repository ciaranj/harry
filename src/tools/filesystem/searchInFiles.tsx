import { spawn } from 'node:child_process';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';

/**
 * Run grep via spawn (no shell), returning { stdout, stderr, code }.
 * Arguments are passed as an array, so no shell interpretation occurs.
 */
const runGrep = (args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn('grep', args);
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];

    child.stdout.on('data', (d: Buffer) => stdoutParts.push(d.toString()));
    child.stderr.on('data', (d: Buffer) => stderrParts.push(d.toString()));

    child.on('close', (code: number | null) => {
      resolve({ stdout: stdoutParts.join(''), stderr: stderrParts.join(''), code });
    });

    child.on('error', (err: Error) => reject(err));
  });

interface SearchInFilesArgs {
  pattern: string;
  path?: string;
  literal?: boolean;
}

type SearchInFilesResult = { success: boolean; matches: string[]; truncated: boolean };

function renderSearchInFilesCall(pattern: string, path?: string, literal?: boolean): string {
  const mode = literal ? ' (literal)' : '';
  return `Searching for "${pattern}"${mode} in ${path || '.'}`;
}

// LLM-friendly output limits: cap per-file matches, total output lines, and line length to avoid context window bloat.
const MAX_MATCHES_PER_FILE = 5;
const MAX_TOTAL_OUTPUT_LINES = 30; // includes headers, blank lines, and match content
const MAX_LINE_LENGTH = 200; // truncate individual match lines beyond this

export function parseGrepOutput(stdout: string, stderrNote: string = ''): SearchInFilesResult {
  if (!stdout.trim() && !stderrNote) return { success: true, matches: [], truncated: false };

  const rawLines = stdout.trim().split('\n');
  const totalMatches = rawLines.length;

  // Group by file (grep format: "filepath:linenum:content")
  // Greedy (.+) backtracks to find the last ':digits:' pattern,
  // correctly handling filenames containing colons.
  const fileGroups = new Map<string, string[]>();
  for (const line of rawLines) {
    const match = line.match(/^(.+):(\d+):(.*)$/);
    if (!match) continue;
    const [, filePath, _linenum, lineContent] = match;
    if (!fileGroups.has(filePath)) fileGroups.set(filePath, []);
    fileGroups.get(filePath)!.push(lineContent);
  }

  // Build capped, grouped output
  const outputLines: string[] = [];
  let totalOutputLines = 0;
  let anyTruncated = false;

  // Summary header
  const summary = `Found ${totalMatches} matches across ${fileGroups.size} files.`;
  outputLines.push(summary);
  if (stderrNote) {
    outputLines.push(stderrNote);
    totalOutputLines++;
  }
  outputLines.push('');
  totalOutputLines += 2;

  for (const [filePath, fileMatches] of fileGroups) {
    if (totalOutputLines >= MAX_TOTAL_OUTPUT_LINES) break;

    const capped = fileMatches.slice(0, MAX_MATCHES_PER_FILE);
    if (fileMatches.length > MAX_MATCHES_PER_FILE) anyTruncated = true;

    const matchLabel = fileMatches.length === 1 ? 'match' : 'matches';
    outputLines.push(`${filePath} (${fileMatches.length} ${matchLabel})`);
    totalOutputLines++;

    for (const match of capped) {
      if (totalOutputLines >= MAX_TOTAL_OUTPUT_LINES) break;
      const display = match.length > MAX_LINE_LENGTH ? `${match.substring(0, MAX_LINE_LENGTH)}[...]` : match;
      outputLines.push(`  ${display}`);
      totalOutputLines++;
    }

    outputLines.push(''); // blank line between files
    totalOutputLines++;
  }

  const truncated = anyTruncated || rawLines.length > MAX_TOTAL_OUTPUT_LINES;

  return { success: true, matches: outputLines, truncated };
}

export const searchInFiles: Tool<SearchInFilesArgs, SearchInFilesResult> = {
  name: "search_in_files",
  description: "Search for a pattern in the codebase using grep.",
  schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "The regex pattern to search for." },
      path: { type: "string", description: "The directory or file to search in." },
      literal: { type: "boolean", description: "If true, treat pattern as a literal string (no regex). Defaults to false." }
    },
    required: ["pattern"]
  } as const,
  execute: async ({ pattern, path: searchPath = '.', literal = false }: SearchInFilesArgs, _ctx?: ToolCallContext): Promise<SearchInFilesResult> => {
    try {
      const excludedDirs = ['.h', '.git'];
      const excludeArgs = excludedDirs.flatMap(dir => ['--exclude-dir', dir]);

      // Build the arguments array — passed directly to execvp, no shell interpretation.
      // -I: skip binary files (prevents garbled output)
      // --no-messages: suppress permission errors to stderr (surfaced below)
      // -F: literal string match (when literal=true), -E: extended regex (default)
      const modeFlag = literal ? ['-F'] : ['-E'];
      const args = [
        '-rn',
        ...modeFlag,
        '-I',
        '--no-messages',
        ...excludeArgs,
        pattern,
        searchPath,
      ];

      const { stdout, stderr, code } = await runGrep(args);

      // Surface stderr warnings (e.g., permission denied, broken symlinks)
      // so the LLM knows when files/dirs were skipped.
      const stderrNote = stderr.trim()
        ? `\n[Note: ${stderr.trim()}]`
        : '';

      if (code === 0) {
        // grep found matches — normal exit
        return parseGrepOutput(stdout, stderrNote);
      } else if (code === 1) {
        // exit code 1 means no matches found.
        return { success: true, matches: [], truncated: false };
      } else if (code === 2 && stdout.trim()) {
        // exit code 2 means grep found matches but also hit errors (e.g., missing dirs).
        return parseGrepOutput(stdout, stderrNote);
      } else {
        return { success: false, matches: [], truncated: false };
      }
    } catch (error: any) {
      return { success: false, matches: [], truncated: false };
    }
  },
  renderCall: ({ pattern, path: searchPath, literal }: SearchInFilesArgs) => (
    <Text color="cyan">{renderSearchInFilesCall(pattern, searchPath, literal)}</Text>
  ),
  renderCallText: ({ pattern, path: searchPath, literal }: SearchInFilesArgs) =>
    renderSearchInFilesCall(pattern, searchPath, literal),
  renderResult: (result: SearchInFilesResult) => (
    <Text color="gray">
      {result.success && result.matches.length > 0
        ? `${result.matches.join('\n')}${result.truncated ? '\n(truncated)' : ''}`
        : result.success ? 'No matches found.' : `Search failed.`}
    </Text>
  )
};
