import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';
import { resolveCanonicalPath } from './shared.js';

interface WriteToFileArgs {
  path: string;
  content: string;
  mode?: "overwrite" | "append";
}

type WriteToFileResult = { success: boolean; message: string };

function renderWriteToFileCall(path: string, content: string, mode?: string): string {
  const action = mode === 'append' ? 'Appending to' : 'Writing';
  return `${action} ${path} (${content.length} bytes)`;
}

/** Ensure the parent directory of a file path exists. */
async function ensureParentDir(_p: string): Promise<void> {
  // mkdir -p is idempotent; no need for the TOCTOU stat check
  await mkdir(path.dirname(_p), { recursive: true });
}

export const writeToFile: Tool<WriteToFileArgs, WriteToFileResult> = {
  name: "write_to_file",
  description: "Creates a new file or overwrites an existing file with the provided content. Use mode='append' to append to an existing file.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The path to the file to write." },
      content: { type: "string", description: "The full content to write into the file." },
      mode: { type: "string", enum: ["overwrite", "append"], description: "Whether to overwrite or append to an existing file. Default is 'overwrite'.", default: "overwrite" }
    },
    required: ["path", "content"]
  } as const,
  execute: async ({ path: p, content, mode = 'overwrite' }: WriteToFileArgs, _ctx?: ToolCallContext): Promise<WriteToFileResult> => {
    // Canonicalize the path so symlinks are resolved and we can validate
    // the file lives inside the working directory.
    const { canonical, withinBounds } = resolveCanonicalPath(p);
    if (!withinBounds) {
      return { success: false, message: `Path "${p}" resolves outside the working directory (${canonical})` };
    }

    try {
      // Ensure parent directory exists before writing
      await ensureParentDir(canonical);

      if (mode === 'append') {
        await appendFile(canonical, content, 'utf-8');
        return { success: true, message: `Successfully appended to ${p}` };
      }
      await writeFile(canonical, content, 'utf-8');
      return { success: true, message: `Successfully wrote to ${p}` };
    } catch (error: any) {
      return { success: false, message: `Error writing to file at "${p}": ${error.message}` };
    }
  },
  renderCall: ({ path: p, content, mode }: WriteToFileArgs) => (
    <Text color="cyan">{renderWriteToFileCall(p, content, mode)}</Text>
  ),
  renderCallText: ({ path: p, content, mode }: WriteToFileArgs) =>
    renderWriteToFileCall(p, content, mode),
  renderResult: (result: WriteToFileResult) => (
    <Text color={result.success ? "green" : "red"}>{result.message}</Text>
  )
};
