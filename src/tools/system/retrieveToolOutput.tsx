import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';
import fs from 'node:fs';
import path from 'node:path';

interface RetrieveToolOutputArgs {
  outputId: string;
  description?: string;
}

type RetrieveResult = { success: boolean; content: string };

function renderRetrieveCall(outputId: string, description?: string): string {
  return `Retrieving tool output: ${outputId}` + (description ? ` (${description})` : '');
}

export const retrieveToolOutput: Tool<RetrieveToolOutputArgs, RetrieveResult> = {
  name: 'retrieve_tool_output',
  description: 'Retrieve an externalized tool output from the session context. Use this when you need to review a large tool output that was previously externalized. Provide the output ID (e.g., "output-1") from the context reference in the conversation.',
  schema: {
    type: 'object',
    properties: {
      outputId: {
        type: 'string',
        description: 'The output identifier, e.g. "d6541ee4-3402-43e0-b726-36b390a81c32".'
      },
      description: {
        type: 'string',
        description: 'Optional description of what you expect to find.'
      }
    },
    required: ['outputId']
  } as const,
  execute: async ({ outputId, description }: RetrieveToolOutputArgs, ctx?: ToolCallContext): Promise<RetrieveResult> => {
    const outputsDir = ctx?.sessionStore?.compactedToolOutputsDirPath();
    if (!outputsDir) {
      return { success: false, content: 'Compacted tool outputs directory not found. No active session.' };
    }
    if (!fs.existsSync(outputsDir)) {
      return { success: false, content: 'Compacted tool outputs directory not found.' };
    }

    const outputPath = path.join(outputsDir, `${outputId}.txt`);

    // Prevent path traversal: resolve outputsDir first (once), then check that outputPath
    // resolves inside it. Using realpathSync on the directory before checking the file
    // avoids TOCTOU: the directory itself is canonical, and the file is constructed
    // deterministically from the resolved directory + outputId.
    const resolvedOutputsDir = (() => {
      try { return fs.realpathSync(outputsDir); } catch { return outputsDir; }
    })();

    const resolvedOutputPath = path.join(resolvedOutputsDir, `${outputId}.txt`);

    if (!resolvedOutputPath.startsWith(resolvedOutputsDir + path.sep)) {
      return { success: false, content: `Output ID "${outputId}" resolved outside session context.` };
    }

    if (!fs.existsSync(resolvedOutputPath)) {
      return { success: false, content: `No tool output found with ID "${outputId}" in session context.` };
    }

    try {
      const content = fs.readFileSync(resolvedOutputPath, 'utf-8');
      return { success: true, content };
    } catch (err) {
      return { success: false, content: `Failed to read tool output: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
  renderCall: ({ outputId, description }: RetrieveToolOutputArgs) => (
    <Text color="cyan">{renderRetrieveCall(outputId, description)}</Text>
  ),
  renderCallText: ({ outputId, description }: RetrieveToolOutputArgs) =>
    renderRetrieveCall(outputId, description),
  renderResult: (result: RetrieveResult) => (
    <Text color={result.success ? "green" : "red"}>{result.content}</Text>
  )
};
