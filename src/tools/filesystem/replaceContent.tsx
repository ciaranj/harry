import { readFile, writeFile } from 'node:fs/promises';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';

interface ReplaceContentArgs {
  path: string;
  search_string: string;
  replacement_string: string;
  replace_all?: boolean;
  use_regex?: boolean;
}

type ReplaceResult = { success: boolean; message: string };

function renderReplaceContentCall(path: string, search_string: string, replacement_string: string, use_regex?: boolean, replace_all?: boolean): string {
  const mode = use_regex ? "regex" : "literal";
  const scope = replace_all ? "all" : "first";
  return `Replacing in ${path} (${mode}, ${scope}) "${search_string.slice(0, 50)}..." → "${replacement_string.slice(0, 50)}..."`;
}

export const replaceContent: Tool<ReplaceContentArgs, ReplaceResult> = {
  name: "replace_content",
  description: "Replaces a specific block of text in a file with new content. Supports regex patterns and replacing all occurrences.",
  schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The path to the file to edit." },
      search_string: { type: "string", description: "The exact code snippet/block to find and replace, or regex pattern if use_regex is true." },
      replacement_string: { type: "string", description: "The new code snippet/block to insert." },
      replace_all: { type: "boolean", description: "If true, replaces all occurrences of search_string. If false, replaces only the first occurrence. Default is false.", default: false },
      use_regex: { type: "boolean", description: "If true, treats search_string as a regex pattern. Default is false.", default: false }
    },
    required: ["path", "search_string", "replacement_string"]
  } as const,
  execute: async ({ path: p, search_string, replacement_string, replace_all = false, use_regex = false }: ReplaceContentArgs, _ctx?: ToolCallContext): Promise<ReplaceResult> => {
    // Validate required fields before attempting any file I/O.
    const missing: string[] = [];
    if (!p || typeof p !== 'string' || p.trim() === '') missing.push('path');
    if (search_string === undefined || search_string === null) missing.push('search_string');
    if (replacement_string === undefined || replacement_string === null) missing.push('replacement_string');
    if (missing.length > 0) {
      return { success: false, message: `Missing required argument(s): ${missing.join(', ')}` };
    }

    // Guard: empty search_string with regex matches every position → exponential output.
    if (use_regex && search_string === '') {
      return { success: false, message: `Empty search string is not valid for regex mode.` };
    }

    try {
      const content = await readFile(p, 'utf-8');

      let newContent: string;
      let count: number;

      if (use_regex) {
        let regex: RegExp;

        try {
          regex = new RegExp(search_string, replace_all ? 'g' : '');
        } catch (error: any) {
          return {
            success: false,
            message: `Error: Invalid regular expression "${search_string}": ${error.message}`,
          };
        }

        const matches = content.match(regex);
        if (!matches || matches.length === 0) {
          return {
            success: false,
            message: `Error: Pattern "${search_string}" not found in "${p}".`,
          };
        }

        count = replace_all ? matches.length : 1;
        newContent = content.replace(regex, replacement_string);
      } else {
        if (!content.includes(search_string)) {
          return {
            success: false,
            message: `Error: Search string not found in "${p}".`,
          };
        }

        if (replace_all) {
          const parts = content.split(search_string);
          count = parts.length - 1;
          newContent = parts.join(replacement_string);
        } else {
          count = 1;
          newContent = content.replace(search_string, replacement_string);
        }
      }

      if (newContent === content) {
        return {
          success: false,
          message: `Error: Replacement produced no changes in "${p}".`,
        };
      }

      await writeFile(p, newContent, 'utf-8');

      return {
        success: true,
        message: `Successfully replaced ${count} occurrence(s) in ${p}`,
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Error: ${error?.message ?? String(error)}`,
      };
    }
  },
  renderCall: ({ path: p, search_string, replacement_string, use_regex, replace_all }: ReplaceContentArgs) => (
    <Text color="cyan">{renderReplaceContentCall(p, search_string, replacement_string, use_regex, replace_all)}</Text>
  ),
  renderCallText: ({ path: p, search_string, replacement_string, use_regex, replace_all }: ReplaceContentArgs) =>
    renderReplaceContentCall(p, search_string, replacement_string, use_regex, replace_all),
  renderResult: (result: ReplaceResult) => (
    <Text color={result.success ? "green" : "red"}>{result.message}</Text>
  )
};
