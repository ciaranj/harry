import { useState } from 'react';
import { useInput, useStdin } from 'ink';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { MutableRefObject } from 'react';
import { AppConfig } from '../core/config/index.js';

const appConfig = AppConfig.getInstance();

interface TtyHandlers { disable: () => void; enable: () => void; }

function launchEditor(filePath: string, tty: TtyHandlers): Error | undefined {
    const configured = appConfig.getString('VISUAL', '') || appConfig.getString('EDITOR', '');
    if (configured) {
        // User-configured editor — assumed to be a GUI/visual tool, no TTY work.
        const [cmd, ...args] = configured.trim().split(/\s+/);
        return spawnSync(cmd, [...args, filePath], { stdio: 'inherit' }).error;
    }
    switch (process.platform) {
        case 'darwin': {
            // TextEdit via AppleScript — GUI app, no TTY work needed.
            // open -W waits for the app to quit, not the window to close —
            // modern macOS keeps apps alive after closing the last window.
            // AppleScript lets us wait until our specific document is closed.
            const safe = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const script = [
                'set prevApp to ""',
                'tell application "System Events"',
                '  set prevApp to name of first application process whose frontmost is true',
                'end tell',
                'tell application "TextEdit"',
                '  activate',
                `  set theDoc to (open POSIX file "${safe}")`,
                '  set theName to name of theDoc',
                '  repeat',
                '    delay 0.3',
                '    if not (exists document theName) then exit repeat',
                '  end repeat',
                'end tell',
                'tell application prevApp to activate',
            ].join('\n');
            return spawnSync('osascript', ['-e', script], { stdio: 'pipe' }).error;
        }
        case 'win32':
            // Notepad — GUI app, no TTY work needed.
            return spawnSync('notepad.exe', [filePath], { stdio: 'inherit' }).error;
        default: {
            // Terminal editor (vim) — needs full TTY handoff.
            tty.disable();
            const result = spawnSync('vim', [filePath], { stdio: 'inherit' });
            process.stdout.write('\x1b[2J\x1b[H');
            tty.enable();
            return result.error;
        }
    }
}

interface UseEditorInputOptions {
    input: string;
    setInput: (v: string) => void;
    setNotification: (msg: string) => void;
    isProcessing: boolean;
    suppressNextInputChange: MutableRefObject<boolean>;
    /** When false, the Ctrl-E handler is inactive (e.g. headless job mode,
        where activating raw mode on a non-TTY stdin would throw). */
    enabled?: boolean;
}

export function useEditorInput({
    input,
    setInput,
    setNotification,
    isProcessing,
    suppressNextInputChange,
    enabled = true,
}: UseEditorInputOptions): { isEditing: boolean; textInputKey: number } {
    const [isEditing, setIsEditing] = useState(false);
    const [textInputKey, setTextInputKey] = useState(0);
    const { setRawMode: inkSetRawMode } = useStdin();

    useInput((char, key) => {
        if (isProcessing || !key.ctrl || char !== 'e' || isEditing) return;

        setIsEditing(true);
        suppressNextInputChange.current = true;

        const dir = mkdtempSync(join(tmpdir(), 'harry-editor-'));
        const filePath = join(dir, 'input.txt');
        writeFileSync(filePath, input, 'utf-8');

        const editorError = launchEditor(filePath, {
            disable: () => inkSetRawMode(false),
            enable:  () => inkSetRawMode(true),
        });

        if (editorError) {
            setNotification(`Editor failed: ${editorError.message}`);
        } else {
            try {
                const edited = readFileSync(filePath, 'utf-8').trimEnd();
                setInput(edited);
                setTextInputKey(k => k + 1);
            } catch { /* ignore */ }
        }
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }

        setIsEditing(false);
    }, { isActive: enabled });

    return { isEditing, textInputKey };
}
