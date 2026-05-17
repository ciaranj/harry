import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { Message, createMessage, Stats } from './types.js';
import { AppConfig } from './config/index.js';
import { SessionStore } from './session.js';
import { randomUUID } from 'node:crypto';


const appConfig = AppConfig.getInstance();

export interface CompactionConfig {
    /** When context reaches this fraction of MAX_CONTEXT_SIZE, trigger compaction (default: 0.8) */
    threshold?: number;
    /** Number of recent assistant turns to keep uncompressed (default: 6) */
    recentTurns?: number;
    /** Tool outputs larger than this byte count are externalized to CONTEXT.md (default: 2000) */
    maxToolOutputSize?: number;
    /** Max context size in bytes — overrides MAX_CONTEXT_SIZE from env for testing (default: from constants) */
    maxContextSize?: number;
}

export interface CompactionResult {
    /** Path to the directory where externalized tool outputs were written. */
    contextMdPath?: string;
}

export interface CompactionStrategy {
    shouldTrigger(store: SessionStore): boolean;
    doCompaction(store: SessionStore): Promise<CompactionResult>;
}

export class NoOpCompactionStrategy implements CompactionStrategy {
    shouldTrigger(_store: SessionStore): boolean {
        return false;
    }

    async doCompaction(_store: SessionStore): Promise<CompactionResult> {
        return {};
    }
}

export class RunningMemoryStrategy implements CompactionStrategy {
    private config: Required<CompactionConfig>;

    constructor(config?: CompactionConfig) {
        this.config = {
            threshold: config?.threshold ?? appConfig.getFloat('AUTO_COMPACTION_THRESHOLD', 0.8),
            recentTurns: config?.recentTurns ?? 5,
            maxToolOutputSize: config?.maxToolOutputSize ?? 2000,
            maxContextSize: config?.maxContextSize ?? appConfig.getInt('MAX_CONTEXT_SIZE', 262144),
        };
    }

    shouldTrigger(store: SessionStore): boolean {
        const snapshot = store.getSnapshot();
        const thresholdBytes = this.config.threshold * this.config.maxContextSize;
        return (snapshot.stats?.contextSize ?? 0) > thresholdBytes;
    }

 

    async doCompaction(store: SessionStore): Promise<CompactionResult> {
        const messages = store.getMessages();
        if (messages.length <= this.config.recentTurns * 4) {
            return {};
        }

        const outputsDir = store.compactedToolOutputsDirPath();
        if (!fs.existsSync(outputsDir)) {
            fs.mkdirSync(outputsDir, { recursive: true });
        }

        // Keep recent turns uncompressed — find the Nth-to-last assistant message
        let recentStartIndex = messages.length;
        let assistantCount = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === 'assistant') {
                assistantCount++;
                if (assistantCount >= this.config.recentTurns) {
                    recentStartIndex = i;
                    break;
                }
            }
        }

        const recentMessages = messages.slice(recentStartIndex);
        const olderMessages = messages.slice(0, recentStartIndex);

        // Compress older messages: drop reasoning, externalize large tool outputs
        const compressed: Message[] = [];

        for (const msg of olderMessages) {
            if (msg.role === 'user') {
                compressed.push(msg);
            } else if (msg.role === 'assistant') {
                const cleanMsg: Message = {
                    id: msg.id,  // preserve original ID for deduplication
                    role: 'assistant',
                    content: msg.content ?? '',
                };
                if (cleanMsg.content) {
                    compressed.push(cleanMsg);
                }
            } else if (msg.role === 'tool') {
                const contentLength = msg.content?.length ?? 0;
                if (contentLength > this.config.maxToolOutputSize && !msg.content?.startsWith("[Externalized to session context → ")) {
                    const outputId = `${randomUUID()}`;
                    let finalPath = path.join(outputsDir, `${outputId}.txt`);

                    // Atomic write: try exclusive create first, then retry with unique suffixes.
                    // Each retry uses a new UUID to avoid TOCTOU races from stale existence checks.
                    for (let attempt = 0; attempt < 10; attempt++) {
                        try {
                            if (attempt > 0) {
                                const retryId = `${randomUUID()}`;
                                finalPath = path.join(outputsDir, `${retryId}.txt`);
                            }
                            await fsPromises.writeFile(finalPath, msg.content ?? '', { flag: 'wx', encoding: 'utf-8' });
                            break;
                        } catch (e: unknown) {
                            if ((e as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 9) {
                                continue; // retry with new UUID
                            }
                            throw e;
                        }
                    }

                    // Extract the UUID from the actual path for the retrieve message
                    const actualOutputId = path.basename(finalPath).replace('.txt', '');
                    compressed.push({
                        id: msg.id,  // preserve original ID for deduplication
                        role: 'tool',
                        content: `[Externalized to session context → use retrieve_tool_output("${actualOutputId}") to retrieve]`,
                        tool_call_id: msg.tool_call_id,
                    });
                } else {
                    compressed.push(msg);
                }
            }
        }

        // Combine: compressed older + recent uncompressed (full fidelity)
        const newMessages = [...compressed, ...recentMessages];

        // Bump version so trySaveSession's version check succeeds after compaction.
        store.incrementVersion();

        // Mutate the store directly — the store notifies its subscribers
        store.updateMessages(() => newMessages);

        return { contextMdPath: outputsDir };
    }
}
