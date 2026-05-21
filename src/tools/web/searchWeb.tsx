import { AppConfig } from '../../core/config/index.js';

const appConfig = AppConfig.getInstance();

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';

interface SearchWebArgs {
  query: string;
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

type SearchWebResult = { success: boolean; results: SearchResult[] };

function renderSearchWebCall(query: string): string {
  return `Searching web for "${query}"`;
}

/** Wrap a fetch call with a timeout using AbortController. */
function fetchWithTimeout(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  if (signal?.aborted) {
    return Promise.reject(new Error('fetch aborted'));
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      controller?.abort();
      reject(new Error(`fetch_url timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timeoutHandle!);
    });
  });

  controller = new AbortController();
  signal?.addEventListener('abort', () => {
    controller?.abort();
  });

  return Promise.race([fetch(url, { signal: controller.signal }), timeoutPromise]) as Promise<Response>;
}

export const searchWeb: Tool<SearchWebArgs, SearchWebResult> = {
  name: "search_web",
  description: "Search the web using SearXNG.",
  schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query" }
    },
    required: ["query"]
  } as const,
  execute: async ({ query }: SearchWebArgs, _ctx?: ToolCallContext): Promise<SearchWebResult> => {
    try {
      const baseUrl = appConfig.getString('SEARXNG_URL', 'http://localhost:8888/');
      const url = new URL('/search', baseUrl);
      url.searchParams.append('q', query);
      url.searchParams.append('format', 'json');
      const timeoutMs = appConfig.getInt('WEB_FETCH_TIMEOUT_MS') || DEFAULT_TIMEOUT_MS;
      const res = await fetchWithTimeout(url.toString(), timeoutMs, _ctx?.abortSignal);
      const data = await res.json();
      if (data.error) return { success: false, results: [] };
      if (!data.results?.length) return { success: true, results: [] };
      const formattedResults: SearchResult[] = data.results.slice(0, 5).map((r: any) => ({
        title: r.title,
        url: r.url,
        content: r.content || ''
      }));
      return { success: true, results: formattedResults };
    } catch (error: any) {
      return { success: false, results: [] };
    }
  },
  renderCall: ({ query }: SearchWebArgs) => (
    <Text color="cyan">{renderSearchWebCall(query)}</Text>
  ),
  renderCallText: ({ query }: SearchWebArgs) =>
    renderSearchWebCall(query),
  renderResult: (result: SearchWebResult) => (
    <Text color="gray">
      {result.success && result.results.length > 0
        ? result.results.map((r: SearchResult, i: number) => `${i + 1}. ${r.title} (${r.url})`).join('\n')
        : result.success ? 'No results found.' : `Search failed: ${result.results}`}
    </Text>
  )
};
