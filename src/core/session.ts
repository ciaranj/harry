import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventType, Message } from './types.js';

/** Generate a session ID as ISO timestamp + random hex + PID.
 *  Random component prevents collision when the process restarts
 *  within the same millisecond (e.g. crash recovery). */
function generateSessionId(): string {
    const now = new Date();
    const y = now.getFullYear();
    const mo = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const rand = randomBytes(4).toString('hex');
    return `${y}-${mo}-${d}T${h}${mi}${s}${ms}-${rand}-${process.pid}`;
}

export type SessionStats = {
    contextSize: number;
};

export type Session = {
    id: string;
    createdAt: string;
    updatedAt: string;
    version: number;
    messages: Message[];   // includes inline UI-only events (role: 'event')
    stats?: SessionStats;
};

const SESSIONS_ROOT = '.h/sessions';
const BACKUP_SUFFIX = '.bak';
const TEMP_SUFFIX = '.tmp';

/** Resolve the directory path for a session by ID. */
export function sessionDirPath(sessionId: string, cwd: string = process.cwd()): string {
    return path.join(cwd, SESSIONS_ROOT, sessionId);
}

/** Resolve the session.json file path for a session ID. */
function sessionFilePath(sessionId: string, cwd: string = process.cwd()): string {
    return path.join(sessionDirPath(sessionId, cwd), 'session.json');
}

/** Find the most recently updated non-empty session by scanning SESSIONS_ROOT.
 * Skips empty sessions (e.g. freshly reset ones) so that restarting
 * resumes the previous session with messages. */
export function findActiveSessionId(cwd: string = process.cwd()): string | null {
    const sessionsDir = path.join(cwd, SESSIONS_ROOT);
    if (!fs.existsSync(sessionsDir)) {
        return null;
    }
    let latest = '';
    let latestTime = 0;
    try {
        const entries = fs.readdirSync(sessionsDir);
        for (const entry of entries) {
            const sessionId = entry;
            const filePath = sessionFilePath(sessionId, cwd);

            try {
                // Read directly and handle ENOENT — avoids the existsSync/statSync/
                // readFileSync TOCTOU race where a file could be deleted between
                // statSync and readFileSync.
                const data = fs.readFileSync(filePath, 'utf-8');
                const stat = fs.statSync(filePath);

                if (stat.mtimeMs <= latestTime) continue;

                const parsed = JSON.parse(data);
                // Treat a session with only UI-only events (e.g. a lone reset
                // marker) as empty so a freshly reset session isn't resumed.
                const realMessages = Array.isArray(parsed.messages)
                    ? parsed.messages.filter((m: Message) => m.role !== 'event')
                    : [];
                if (realMessages.length === 0) continue;

                latestTime = stat.mtimeMs;
                latest = sessionId;
            } catch {
                // Skip individual session files that can't be read
                // (e.g., ENOENT, EACCES, JSON parse errors).
                // Don't let a single bad session kill the whole scan.
                continue;
            }
        }
    } catch {
        return null;
    }
    return latest || null;
}

export function createSession(directory: string = process.cwd()): Session {
    const now = new Date().toISOString();
    return {
        id: generateSessionId(),
        createdAt: now,
        updatedAt: now,
        version: 0,
        messages: []
    };
}

async function loadSessionFromFile(filePath: string): Promise<Session | null> {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        const data = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        
        if (!parsed.id || !parsed.createdAt || !parsed.updatedAt || parsed.version === undefined || !Array.isArray(parsed.messages)) {
            return null;
        }
        
        return parsed as Session;
    } catch (err) {
        console.error(`Failed to parse session file: ${err}`);
        return null;
    }
}

async function loadBackupFromFile(filePath: string): Promise<Session | null> {
    const backupPath = filePath + BACKUP_SUFFIX;
    try {
        if (!fs.existsSync(backupPath)) {
            return null;
        }
        const data = fs.readFileSync(backupPath, 'utf-8');
        const parsed = JSON.parse(data);
        
        if (!parsed.id || !parsed.createdAt || !parsed.updatedAt || parsed.version === undefined || !Array.isArray(parsed.messages)) {
            return null;
        }
        
        return parsed as Session;
    } catch (err) {
        console.error(`Failed to parse backup session file: ${err}`);
        return null;
    }
}

export async function loadSession(directory: string = process.cwd()): Promise<Session | null> {
    // Find the most recently updated session
    const activeSessionId = findActiveSessionId(directory);
    if (!activeSessionId) {
        return null;
    }

    const filePath = sessionFilePath(activeSessionId, directory);
    
    await ensureSessionDir(directory);
    
    let session = await loadSessionFromFile(filePath);
    if (session) {
        return session;
    }
    
    const backupSession = await loadBackupFromFile(filePath);
    if (backupSession) {
        console.log('Loaded session from backup');
        return backupSession;
    }
    
    return null;
}

export async function saveSession(session: Session, directory: string = process.cwd(), checkVersion: boolean = true): Promise<void> {
    const filePath = sessionFilePath(session.id, directory);
    const tempPath = filePath + TEMP_SUFFIX;

    await ensureSessionDirForId(session.id, directory);

    session.updatedAt = new Date().toISOString();
    session.version += 1;

    // Version check: prevent silent data loss from concurrent writes
    if (checkVersion && fs.existsSync(filePath)) {
        const existingData = fs.readFileSync(filePath, 'utf-8');
        const existingSession = JSON.parse(existingData) as Session;
        if (existingSession.version !== session.version - 1) {
            throw new Error(`Version mismatch: expected ${session.version - 1}, got ${existingSession.version}. Session was modified by another process.`);
        }
    }

    const data = JSON.stringify(session, null, 2);
    fs.writeFileSync(tempPath, data, 'utf-8');
    fs.renameSync(tempPath, filePath);
}

async function ensureSessionDirForId(sessionId: string, directory: string = process.cwd()): Promise<void> {
    const sessionDir = sessionDirPath(sessionId, directory);
    if (!fs.existsSync(sessionDir)) {
        await fs.promises.mkdir(sessionDir, { recursive: true });
    }
}

async function ensureSessionDir(directory: string): Promise<void> {
    const sessionsDir = path.join(directory, SESSIONS_ROOT);
    if (!fs.existsSync(sessionsDir)) {
        await fs.promises.mkdir(sessionsDir, { recursive: true });
    }
}

export async function resetSession(directory: string = process.cwd()): Promise<Session> {
    const activeSessionId = findActiveSessionId(directory);
    
    try {
        if (activeSessionId) {
            const filePath = sessionFilePath(activeSessionId, directory);
            if (fs.existsSync(filePath)) {
                const oldData = fs.readFileSync(filePath, 'utf-8');
                const oldSession = JSON.parse(oldData) as Session;
                
                const archivePath = path.join(
                    sessionDirPath(activeSessionId, directory),
                    `archive_${oldSession.id}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`
                );
                fs.writeFileSync(archivePath, oldData);
                
                if (fs.existsSync(filePath + BACKUP_SUFFIX)) {
                    fs.unlinkSync(filePath + BACKUP_SUFFIX);
                }
            }
        }
    } catch (err) {
        console.error(`Failed to archive old session: ${err}`);
    }
    
    const newSession = createSession(directory);
    await saveSession(newSession, directory);
    return newSession;
}

export async function trySaveSession(session: Session, directory: string = process.cwd()): Promise<{ saved: boolean; error?: Error }> {
    const filePath = sessionFilePath(session.id, directory);
    const tempPath = filePath + TEMP_SUFFIX;

    try {
        // TOCTOU note: between the readFileSync above and the write in saveSession(),
        // another process could theoretically write a different version and cause
        // silent data loss. We accept this risk — in practice the session file is
        // only written by this single process during its lifetime, so the window is
        // extremely narrow and the likelihood of a conflicting write is negligible.
        const existingData = fs.readFileSync(filePath, 'utf-8');
        const existingSession = JSON.parse(existingData) as Session;

        if (existingSession.version !== session.version - 1) {
            return { saved: false, error: new Error('Version mismatch - session was modified by another process') }
        }

        await saveSession(session, directory);
        return { saved: true }
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            try {
                const data = JSON.stringify(session, null, 2);
                fs.writeFileSync(tempPath, data, 'utf-8');
                fs.renameSync(tempPath, filePath);
                return { saved: true }
            } catch (writeErr) {
                return { saved: false, error: writeErr as Error }
            }
        }
        return { saved: false, error: err as Error }
    }
}

// --- SessionStore: immutable session lifecycle manager ---

export type Listener = () => void;

export class SessionStore {
    private current: Session;
    private sessionDir: string;
    private directory: string;
    private listeners: Set<Listener> = new Set();

    constructor(initial: Session, directory: string = process.cwd()) {
        this.current = initial;
        this.directory = directory;
        this.sessionDir = sessionDirPath(initial.id, directory);
    }

    /** Returns a deep snapshot of the current session (safe to read, not to mutate). */
    getSnapshot(): Session {
        return { ...this.current, messages: [...this.current.messages] };
    }

    /** Returns a shallow copy of messages — caller should not mutate in place. */
    getMessages(): Message[] {
         return [...this.current.messages];
    }

    /**
     * Update messages immutably. `updater` receives a copy of the current
     * message list and must return the new message list.
     * Returns the updated message array.
     */
    updateMessages(updater: (msgs: Message[]) => Message[]): Message[] {
        const next = updater([...this.current.messages]);
        this.current = { ...this.current, messages: next, updatedAt: new Date().toISOString() };
        this.notifyListeners();
        return next;
    }

    /** Increment the session version. Called after structural changes like compaction. */
    incrementVersion(): void {
        this.current = { ...this.current, version: this.current.version + 1, updatedAt: new Date().toISOString() };
        this.notifyListeners();
    }

    /** Update stats immutably. Only updates fields that are non-undefined in `partial`. */
    setStats(partial: Partial<Session['stats']>): void {
        if (!partial || Object.keys(partial).length === 0) return;
        // Filter out undefined values — spread of Partial<T> into T is unsafe for TS
        const defined: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(partial)) {
            if (v !== undefined) defined[k] = v;
        }
        this.current = {
            ...this.current,
            stats: { ...this.current.stats, ...defined } as SessionStats,
            updatedAt: new Date().toISOString(),
        };
        this.notifyListeners();
    }

    /**
     * Append a UI event as an inline message (role: 'event'). It stays
     * temporally ordered with the conversation but is filtered out of the LLM
     * payload (see buildLLMPayload). Notifies listeners.
     */
    appendEvent(event: EventType, content: string, metadata?: Record<string, unknown>): void {
        const msg: Message = {
            id: randomUUID(),
            role: 'event',
            event,
            content,
            metadata,
        };
        this.current = {
            ...this.current,
            messages: [...this.current.messages, msg],
            updatedAt: new Date().toISOString(),
        };
        this.notifyListeners();
    }

    /**
     * Patch the most recent event message (for realtime updates like progress %).
     * Searches from the end — the last event message need not be the last message
     * overall. Notifies listeners.
     */
    updateLastEvent(updater: (prev: Message) => Partial<Message>): void {
        const msgs = this.current.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'event') {
                const updated = { ...msgs[i], ...updater(msgs[i]) } as Message;
                this.current = {
                    ...this.current,
                    messages: [...msgs.slice(0, i), updated, ...msgs.slice(i + 1)],
                    updatedAt: new Date().toISOString(),
                };
                this.notifyListeners();
                return;
            }
        }
    }

    /** Get the inline event messages, in order. */
    getEvents(): Message[] {
        return this.current.messages.filter(m => m.role === 'event');
    }

    /** Persist the current session to disk. */
    async persist(): Promise<void> {
        await saveSession(this.current, this.directory);
    }

    /**
     * Reset: archive the old session and create a fresh one.
     * Returns the new session (already saved).
     */
    async reset(): Promise<Session> {
        const newSession = await resetSession(this.directory);
        this.current = newSession;
        this.sessionDir = sessionDirPath(newSession.id, this.directory);
        this.appendEvent('reset', 'Session reset');
        return newSession;
    }

    /**
     * Resolve a conflict when another process wrote to disk.
     * Merges the remote session's messages into this store, keeping ours as a suffix.
     */
    resolveConflict(remote: Session): void {
        // Take remote messages (authoritative), then append any messages we had that aren't in remote.
        // Uses stable UUIDs assigned at message creation time, not role+index which shift on edits.
        const remoteMsgIds = new Set(remote.messages.map(m => m.id));
        const localOnly = this.current.messages.filter(
            m => !remoteMsgIds.has(m.id)
        );
        this.current = {
            ...remote,
            messages: [...remote.messages, ...localOnly],
            updatedAt: new Date().toISOString(),
        };
        this.notifyListeners();
    }

    /** Resolve the file path for the session's context.md. */
    contextFilePath(): string {
        return path.join(this.sessionDir, 'context.md');
    }

    /** Resolve the path for the compacted tool outputs directory. */
    compactedToolOutputsDirPath(): string {
        return path.join(this.sessionDir, 'compacted_tool_outputs');
    }

    // --- Subscriber system ---

    /**
     * Register a listener that is called whenever the store's state changes.
     * Returns an unsubscribe function.
     */
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Notify all registered listeners. */
    private notifyListeners(): void {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // Swallow listener errors to prevent a crashing listener from
                // breaking the entire update cycle (e.g., LLM loop, UI render).
            }
        }
    }
}
