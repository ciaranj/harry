import { spawn } from 'node:child_process';
import React from 'react';
import { Text } from 'ink';
import { Tool, ToolCallContext } from '../types.js';

interface RunPythonArgs {
  code: string;
}

type PythonResult = { success: boolean; output: string };

function renderRunPythonCall(code: string): string {
  const snippet = code.slice(0, 60);
  return `Running Generated Python Script`;
}

export const runPython: Tool<RunPythonArgs, PythonResult> = {
  name: "python",
  description: "Runs code in an ipython interpreter and returns the result.",
  schema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The code to run in the ipython interpreter." }
    },
    required: ["code"]
  } as const,
  execute: async ({ code }: RunPythonArgs, _ctx?: ToolCallContext): Promise<PythonResult> => {
    return new Promise((resolve) => {
      const proc = spawn('ipython', ['--no-banner', '--no-confirm-exit', '-c', code]);
      let stdout = '', stderr = '';
      const maxOutput = 1024 * 1024; // 1MB cap to prevent OOM
      let timedOut = false;
      const timeoutMs = 60_000;
      let timer: ReturnType<typeof setTimeout> | null = null;

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
        if (Buffer.byteLength(stdout) > maxOutput) {
          stdout = stdout.slice(0, maxOutput) + '\n[OUTPUT TRUNCATED]';
          proc.kill();
        }
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (Buffer.byteLength(stderr) > maxOutput) {
          stderr = stderr.slice(0, maxOutput) + '\n[STDERR TRUNCATED]';
          proc.kill();
        }
      });

      const cleanupTimer = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      proc.on('close', (exitCode) => {
        cleanupTimer();
        if (timedOut) {
          resolve({ success: false, output: 'Python execution timed out (60s)' });
        } else if (exitCode !== 0 && stderr) {
          resolve({ success: false, output: stderr.trim() });
        } else {
          resolve({ success: true, output: stdout.trim() || '(no output)' });
        }
      });

      proc.on('error', (e) => {
        cleanupTimer();
        resolve({ success: false, output: `Failed to launch ipython: ${e.message}` });
      });

      timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeoutMs);
    });
  },
  renderCall: ({ code }: RunPythonArgs) => (
    <Text color="cyan">{renderRunPythonCall(code)}</Text>
  ),
  renderCallText: ({ code }: RunPythonArgs) =>
    renderRunPythonCall(code),
  renderResult: (result: PythonResult) => (
    <Text color={result.success ? "green" : "red"}>{result.output}</Text>
  )
};
