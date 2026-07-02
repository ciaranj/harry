import pino, { stdTimeFunctions } from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import { AppConfig } from './config/index.js';

const LOGS_DIR = '.h/logs';
const LOG_FILE = 'harry.log';

// Track the shared logger and transport so we can flush/close on process exit.
let _logger: pino.Logger | null = null;
let _transportDest: any = null;

function resolveLogDir(cwd: string): string {
    return path.join(cwd, LOGS_DIR);
}

function ensureLogDir(cwd: string): void {
    const dir = resolveLogDir(cwd);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/** Get the shared pino logger for the given cwd. */
export function getLoggerInstance(cwd: string): pino.Logger {
    if (!_logger) {
        const dir = resolveLogDir(cwd);
        ensureLogDir(cwd);
        _transportDest = pino.transport({
            target: 'pino/file',
            options: { destination: path.join(dir, LOG_FILE) },
        });
        // Read log level from config store (defaults to 'info')
        const logLevel = AppConfig.getInstance().getString('LOG_LEVEL') || 'info';
        _logger = pino(
            {
                level: logLevel,
                timestamp: stdTimeFunctions.isoTime,
                formatters: {
                    level: (label) => ({ level: label.toUpperCase() }),
                },
            },
            _transportDest
        );
    }
    return _logger;
}

/** Flush pending log data and close the transport. Call before process exit.
 *  Best-effort: never rejects, so callers can rely on it not overriding their
 *  own exit code. Both pino's and thread-stream's flush are callback-style
 *  (thread-stream's throws if invoked without a callback), so we promisify
 *  them rather than awaiting their return value. */
export async function closeLogger(): Promise<void> {
    if (!_logger) return;
    const logger = _logger;
    const dest = _transportDest;
    _logger = null;
    _transportDest = null;
    try {
        await new Promise<void>((resolve) => logger.flush(() => resolve()));
        if (dest && typeof dest.flush === 'function') {
            await new Promise<void>((resolve) => dest.flush(() => resolve()));
        }
    } catch {
        // Logger flush is best-effort; buffered entries may be lost, but a
        // flush failure must never crash shutdown.
    }
}

// Flush logs on process exit to avoid losing buffered entries.
// Use 'beforeExit' so the event loop can complete the async flush
// before the process actually terminates.
// Note: beforeExit fires synchronously; pino.flush(cb) is fire-and-forget.
// The callback swallows errors to avoid unhandled rejections during shutdown.
process.on('beforeExit', () => {
    if (_logger) {
        _logger.flush(() => {
            // Best-effort flush — logger may already be in an error state;
            // buffered entries may be lost on crash.
        });
    }
});
