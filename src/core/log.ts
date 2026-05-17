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

/** Flush pending log data and close the transport. Call before process exit. */
export async function closeLogger(): Promise<void> {
    if (_logger) {
        await _logger.flush();
        // Flush the underlying stream destination to ensure buffered data is written.
        if (_transportDest && typeof _transportDest.flush === 'function') {
            await _transportDest.flush();
        }
        _logger = null;
        _transportDest = null;
    }
}

// Flush logs on process exit to avoid losing buffered entries.
// Use 'beforeExit' so the event loop can complete the async flush
// before the process actually terminates.
process.on('beforeExit', () => { void _logger?.flush(); });
