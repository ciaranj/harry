import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Text, Box, Static, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { ScrollView, type ScrollViewRef } from 'ink-scroll-view';
import { Marked } from 'marked';
import MarkedTerminalRenderer, { markedTerminal } from 'marked-terminal';

// marked-terminal's listitem renderer drops inline formatting (**bold**, *em*,
// `code`) inside list items: its `list` method calls `this.listitem(...)` on
// the Renderer *instance*, bypassing extension-level overrides. The only way
// to intercept is to patch the Renderer prototype before constructing it.
// Walking the token's children with parseInline restores inline styling.
(MarkedTerminalRenderer as any).prototype.listitem = function (token: any) {
    let body = '';
    for (const tok of token.tokens || []) {
        if ((tok.type === 'text' || tok.type === 'paragraph') && Array.isArray(tok.tokens)) {
            body += this.parser.parseInline(tok.tokens);
            if (tok.type === 'paragraph') body += '\n';
        } else {
            body += this.parser.parse([tok]);
        }
    }
    // '\n* ' matches marked-terminal's BULLET_POINT marker so the list-level
    // renderer can later convert it for ordered lists.
    return '\n* ' + body.replace(/\n+$/, '');
};
import { Message, Stats } from '../core/types.js';
import { SessionStore } from '../core/session.js';
import type pino from 'pino';
import { CompactionStrategy, RunningMemoryStrategy } from '../core/compaction.js';
import { classifyJobOutcome, type JobConfig } from '../core/job.js';
import type { MakeCallToLLMDeps } from '../core/llm.js';
import { makeCallToLLM, createDefaultHttpClient, createDefaultLLMConfig, createDefaultToolDispatcher } from '../core/llm.js';
import { tools as defaultTools } from '../tools/index.js';
import type { GuardrailConfigManager } from '../core/config/index.js';
import { AppConfig } from '../core/config/index.js';
import { ContextGauge } from './ContextGauge.js';
import { theme } from './theme.js';
import { useEditorInput } from './useEditorInput.js';

const appConfig = AppConfig.getInstance();
const MAX_CONTEXT_SIZE = appConfig.getInt('MAX_CONTEXT_SIZE', 262144);
const COMPACTION_THRESHOLD = appConfig.getFloat('AUTO_COMPACTION_THRESHOLD', 0.8);


// --- Markdown rendering via marked-terminal ---
// marked-terminal's width affects table layout and (when reflowText is true)
// paragraph wrapping. We cache one Marked instance per width so width changes
// (terminal resize) take effect without rebuilding on every render.
const renderers = new Map<number, Marked>();
function getRenderer(width: number): Marked {
    let r = renderers.get(width);
    if (!r) {
        r = new Marked();
        r.use({ gfm: true, breaks: true } as any);
        r.use(markedTerminal({
            width,
            reflowText: true,
            showSectionPrefix: false,
            emoji: false,
        }) as any);
        renderers.set(width, r);
    }
    return r;
}

function renderMarkdown(text: string, width: number): string {
    try {
        return String(getRenderer(width).parse(text)).replace(/\n+$/, '');
    } catch {
        return text;
    }
}

interface ToolsByName { [name: string]: any }

// Width of the left gutter that holds the role-prefix marker (e.g. `> ` or `* `).
// Subtracted from `width` when rendering markdown so wrapped lines line up.
const PREFIX_GUTTER = 2;

const MessageView = React.memo(function MessageView({ msg, width, toolsByName, showReasoning = false }: { msg: Message; width: number; toolsByName: ToolsByName; showReasoning?: boolean }) {
    // Tool result messages aren't rendered directly (their effect is shown via the tool call line above)
    if (msg.role === 'tool') return null;

    // Inline UI-only events render as chrome, not conversation. A reset gets a
    // bold separator; everything else is a dim one-liner with the event glyph.
    if (msg.role === 'event') {
        if (msg.event === 'reset') {
            return (
                <Box paddingX={1} marginBottom={1}>
                    <Text color={theme.reset} bold>
                        {'─'.repeat(20)} SESSION RESET {'─'.repeat(20)}
                    </Text>
                </Box>
            );
        }
        const pct = msg.metadata?.pct;
        return (
            <Box paddingX={1} marginBottom={1}>
                <Text color={theme.event} dimColor>
                    {theme.glyph.event} {msg.content}{typeof pct === 'number' ? ` ${pct}%` : ''}
                </Text>
            </Box>
        );
    }

    const prefix = msg.role === 'user' ? theme.glyph.user : msg.role === 'assistant' ? theme.glyph.assistant : theme.glyph.system;
    const prefixColor = msg.role === 'user' ? theme.role.user : msg.role === 'assistant' ? theme.role.assistant : theme.role.system;

    const innerWidth = Math.max(20, width - PREFIX_GUTTER);
    // Skip re-parsing the markdown when content hasn't changed across re-renders.
    // For the message currently streaming, content changes every tick (cache miss);
    // for stable sibling messages this short-circuits the entire marked + ANSI
    // pipeline.
    const content = useMemo(
        () => msg.content ? renderMarkdown(msg.content, innerWidth) : '',
        [msg.content, innerWidth]
    );

    const hasReasoning = showReasoning && !!msg.reasoning_content;
    const hasOutput = !!content || (msg.tool_calls && msg.tool_calls.length > 0);

    return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
            {hasReasoning && (
                <Box flexDirection="row">
                    <Box width={PREFIX_GUTTER} flexShrink={0}>
                        <Text color={theme.muted} dimColor>{prefix}</Text>
                    </Box>
                    <Box flexGrow={1}>
                        <Text color={theme.muted} dimColor>{msg.reasoning_content}</Text>
                    </Box>
                </Box>
            )}
            {hasOutput && (
                <Box flexDirection="row">
                    <Box width={PREFIX_GUTTER} flexShrink={0}>
                        <Text color={prefixColor} bold>{prefix}</Text>
                    </Box>
                    <Box flexDirection="column" flexGrow={1}>
                        {content && <Text>{content}</Text>}
                        {msg.tool_calls?.map((tc, i) => {
                            const toolName = tc.function?.name || tc.name || 'unknown';
                            const toolDef = toolsByName[toolName];
                            let description = toolName;
                            if (toolDef?.renderCallText) {
                                let args: any = {};
                                try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* ignore */ }
                                description = toolDef.renderCallText(args);
                            }
                            return <Text key={`tc-${i}`} color={theme.accent}>{theme.glyph.toolCall} {description}</Text>;
                        })}
                    </Box>
                </Box>
            )}
        </Box>
    );
});

// --- Review mode: alt-screen overlay with scrollable history ---

function ReviewView({
    messages,
    width,
    height,
    toolsByName,
    onExit,
}: {
    messages: Message[];
    width: number;
    height: number;
    toolsByName: ToolsByName;
    onExit: () => void;
}) {
    const scrollRef = useRef<ScrollViewRef>(null);
    const { stdout } = useStdout();

    // Skip tool result messages — MessageView returns null for them and that
    // confuses ScrollView's height measurement.
    const visibleMessages = useMemo(
        () => messages.filter(m => m.role !== 'tool'),
        [messages]
    );

    // Land on the most recent turn when the overlay opens.
    useEffect(() => {
        const t = setTimeout(() => scrollRef.current?.scrollToBottom(), 50);
        return () => clearTimeout(t);
    }, []);

    useEffect(() => {
        const onResize = () => scrollRef.current?.remeasure();
        stdout.on('resize', onResize);
        return () => { stdout.off('resize', onResize); };
    }, [stdout]);

    useInput((input, key) => {
        if (key.escape || input === 'q') { onExit(); return; }
        if (key.upArrow)   { scrollRef.current?.scrollBy(-1); return; }
        if (key.downArrow) { scrollRef.current?.scrollBy(1);  return; }
        if (key.pageUp) {
            const h = scrollRef.current?.getViewportHeight() ?? 1;
            scrollRef.current?.scrollBy(-h);
            return;
        }
        if (key.pageDown) {
            const h = scrollRef.current?.getViewportHeight() ?? 1;
            scrollRef.current?.scrollBy(h);
            return;
        }
        if (input === 'g') { scrollRef.current?.scrollToTop(); return; }
        if (input === 'G') { scrollRef.current?.scrollToBottom(); return; }
    });

    return (
        <Box flexDirection="column" height={height}>
            <Box paddingX={1} borderStyle="single" borderColor={theme.review}>
                <Text color={theme.review} bold>REVIEW MODE</Text>
                <Text color={theme.muted}>  ·  q/esc exit  ·  ↑↓ scroll  ·  PgUp/PgDn page  ·  g/G top/bottom</Text>
            </Box>
            <ScrollView ref={scrollRef} flexGrow={1} flexDirection="column">
                {visibleMessages.map(msg => (
                    <MessageView
                        key={msg.id}
                        msg={msg}
                        width={width}
                        toolsByName={toolsByName}
                        showReasoning
                    />
                ))}
            </ScrollView>
        </Box>
    );
}

// --- Component ---

interface AppProps {
    /** Core LLM caller — accepts a MakeCallToLLMDeps object. */
    makeCallToLLM: (deps: MakeCallToLLMDeps) => Promise<void>;
    store: SessionStore;
    sessionLogger: pino.Logger;
    guardrails: GuardrailConfigManager;
    /** When set, Harry runs this job autonomously instead of waiting for input. */
    job?: JobConfig;
    /** Called when a job finishes, with its exit code (0 complete, 1 blocked). */
    onJobEnd?: (code: number) => void;
}

function useStdoutDimensions(): [number, number] {
    const { stdout } = useStdout();
    const [dimensions, setDimensions] = useState<[number, number]>([stdout.columns ?? 80, stdout.rows ?? 24]);
    useEffect(() => {
        const handler = () => setDimensions([stdout.columns, stdout.rows]);
        stdout.on('resize', handler);
        return () => { stdout.off('resize', handler); };
    }, [stdout]);
    return dimensions;
}

export const App = ({ makeCallToLLM, store, sessionLogger, guardrails, job, onJobEnd }: AppProps) => {
    const initialMessages = store.getMessages();
    const [messages, setMessages] = useState<Message[]>(initialMessages);
    const [committedMessages, setCommittedMessages] = useState<Message[]>(initialMessages);
    const [input, setInput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [stats, setStats] = useState<Stats>({ tokens: 0, tps: 0, status: 'idle', contextSize: store.getSnapshot().stats?.contextSize ?? 0, cachedContextSize: 0 });
    const [notification, setNotification] = useState<string | null>(null);
    const { exit } = useApp();
    const [tools] = useState(defaultTools);
    const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
    const [isReviewing, setIsReviewing] = useState(false);
    const abortControllerRef = useRef<AbortController | null>(null);
    const jobStartedRef = useRef(false);
    const suppressNextInputChange = useRef(false);
    const { isEditing, textInputKey } = useEditorInput({ input, setInput, setNotification, isProcessing, suppressNextInputChange, enabled: !job });
    const compactionStrategy = useMemo(() => {
        const strategy = new RunningMemoryStrategy({
            onProgress: (phase, pct) => {
                // Event mutations notify store subscribers, which re-pull
                // messages into the UI — no separate event state to sync.
                if (phase === 'start') {
                    store.appendEvent('compaction_start', 'Compacting…');
                } else if (phase === 'complete') {
                    // Completion event is set by the /compact handler below.
                    // For auto-compaction from the LLM loop, just update the event.
                    store.updateLastEvent(() => ({
                        event: 'compaction_complete',
                        content: 'Compaction complete',
                    }));
                } else if (phase === 'compressing') {
                    store.updateLastEvent(() => ({
                        content: 'Compacting…',
                        metadata: { pct },
                    }));
                }
            },
        });
        return strategy;
    }, []);
    const { stdout } = useStdout();

    // Safety net: if the process exits while in the alt buffer, restore the
    // normal buffer so the user isn't left with a blank terminal. Runs on
    // unmount (including Ctrl-C / process exit via Ink's lifecycle).
    useEffect(() => {
        return () => {
            // Best-effort — if we never entered alt screen this is a no-op
            // since the terminal ignores `1049l` when not in the alt buffer.
            stdout.write('\x1b[?1049l');
        };
    }, [stdout]);

    const enterReview = useCallback(() => {
        // Switch to alt buffer + clear + cursor home BEFORE flipping state so
        // Ink's next render lands on a clean canvas.
        stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
        setIsReviewing(true);
    }, [stdout]);

    const exitReview = useCallback(() => {
        // Restore the normal buffer first; Ink will then re-render the live
        // tree into it on the next cycle.
        stdout.write('\x1b[?1049l');
        setIsReviewing(false);
    }, [stdout]);

    // Subscribe to store changes
    useEffect(() => {
        const unsub = store.subscribe(() => {
            setMessages(store.getMessages());
        });
        return unsub;
    }, [store]);

    // Commit completed messages to the static history when a turn ends.
    // We track committed messages by ID so we never re-print or shuffle history,
    // even when compaction rewrites the store's internal message list.
    useEffect(() => {
        if (isProcessing) return;
        setCommittedMessages(prev => {
            const seen = new Set(prev.map(m => m.id));
            const additions = messages.filter(m => !seen.has(m.id));
            return additions.length > 0 ? [...prev, ...additions] : prev;
        });
    }, [isProcessing, messages]);

    const persistSession = useCallback(async () => {
        try {
            await store.persist();
        } catch (err) {
            console.error('Failed to save session:', err);
        }
    }, [store]);

    const [termWidth, termHeight] = useStdoutDimensions();
    const contentWidth = Math.max(20, termWidth - 4);

    const toolsByName = useMemo(
        () => Object.fromEntries(tools.map((t: any) => [t.name, t])),
        [tools]
    );

    // Live messages: anything in the store not yet committed to <Static>
    const liveMessages = useMemo(() => {
        const committedIds = new Set(committedMessages.map(m => m.id));
        return messages.filter(m => !committedIds.has(m.id));
    }, [messages, committedMessages]);

    // Live reasoning: the in-flight assistant message's reasoning_content,
    // rendered as an ephemeral block in the live area only. Stays on the
    // Message object (for the LLM payload round-trip) but isn't rendered by
    // MessageView in the main view — keeps Static/live render shapes
    // identical so Ink doesn't double-print on commit. We also track the
    // owning message id so the block can be interleaved immediately before
    // its assistant message instead of floating at the top.
    const liveReasoning = useMemo<{ text: string; msgId: string }>(() => {
        if (!isProcessing) return { text: '', msgId: '' };
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role === 'user') break;
            if (m.role === 'assistant' && m.reasoning_content) {
                return { text: m.reasoning_content, msgId: m.id };
            }
        }
        return { text: '', msgId: '' };
    }, [isProcessing, messages]);

    useEffect(() => {
        if (notification) {
            const timer = setTimeout(() => setNotification(null), 10000);
            return () => clearTimeout(timer);
        }
    }, [notification]);

    useInput((char, key) => {
        // While review mode is up, let ReviewView own the keyboard.
        if (isReviewing) return;

        if (isConfirmingCancel) {
            if (char.toLowerCase() === 'y') {
                if (stats.status === 'idle') exit();
                else abortControllerRef.current?.abort();
            }
            setIsConfirmingCancel(false);
            suppressNextInputChange.current = true;
            return;
        }

        // Ctrl-R: enter scrollable review of the conversation.
        if (!isProcessing && key.ctrl && char === 'r') {
            suppressNextInputChange.current = true;
            enterReview();
            return;
        }

        if (key.escape) {
            setIsConfirmingCancel(true);
            suppressNextInputChange.current = true;
            return;
        }
    }, { isActive: !job });

    useEffect(() => {
        const init = async () => {
            const healthUrl = new URL('/health', appConfig.getString('LLAMACPP_URL', 'http://localhost:8080/'));
            const healthy = await fetch(String(healthUrl)).then(r => r.ok).catch(() => false);
            if (!healthy) console.log("Ollama not found.");
        };
        init();
    }, []);

    const handleInput = async (value: string) => {
        if (!value.trim() || isProcessing || isConfirmingCancel) return;

        if (value === '/exit') { exit(); return; }

        if (value === '/reset') {
            // Clear the terminal for a clean visual break between sessions.
            stdout.write('\x1b[2J\x1b[H');
            await store.reset();
            // reset() seeds the fresh session with an inline 'reset' event, which
            // renders as the separator at the top of the new conversation. Commit
            // it immediately so it lands in scrollback rather than the live area.
            const resetMessages = store.getMessages();
            setMessages(resetMessages);
            setCommittedMessages(resetMessages);
            setIsProcessing(false);
            setStats({ tokens: 0, tps: 0, status: 'idle', contextSize: 0, cachedContextSize: 0 });
            setInput('');
            return;
        }

       if (value === '/compact') {
            const preCompactMessageLength = store.getMessages().length;

            let result: any;

            // Reassign onProgress so it appends the start event (auto-compaction
            // relies on this too, but here we ensure a fresh callback fires).
            compactionStrategy.onProgress = (phase, _pct) => {
                if (phase === 'start') {
                    store.appendEvent('compaction_start', 'Compacting…');
                } else if (phase === 'complete') {
                    const postLen = store.getMessages().length;
                    store.updateLastEvent(() => ({
                        event: 'compaction_complete',
                        content: `Compacted: ${preCompactMessageLength} → ${postLen} messages`,
                        metadata: result?.contextMdPath ? { contextMdPath: result.contextMdPath } : undefined,
                    }));
                }
            };

            result = await compactionStrategy.doCompaction(store);

            // After compaction the store holds new summary messages with new IDs.
            // The pre-compaction history is already in the terminal's scrollback;
            // treat the post-compaction set as already-committed so the new
            // summary messages don't appear as if they were a fresh turn.
            setCommittedMessages(store.getMessages());

            let msg = `Compacted: ${preCompactMessageLength} → ${store.getMessages().length} messages`;
            if (result?.contextMdPath) {
                msg += ` | wrote ${result.contextMdPath}`;
            }
            setNotification(msg);
            await persistSession();
            setInput('');
            return;
        }

        if (value === '/dump_context') {
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const filename = `context_dump_${timestamp}.json`;
                const fs = await import('node:fs');
                const path = (await import('node:path')).default;
                const os = await import('node:os');
                const filePath = path.join(os.tmpdir(), filename);
                const data = JSON.stringify(store.getMessages(), null, 2);
                fs.default.writeFileSync(filePath, data);
                setNotification(`Context dumped to: ${filePath}`);
            } catch (err) {
                setNotification(`Failed to dump context: ${err instanceof Error ? err.message : String(err)}`);
            }
            setInput('');
            return;
        }

        setIsProcessing(true);
        setInput('');
        abortControllerRef.current = new AbortController();

        try {
            const currentTools = tools.length > 0 ? [...tools] : [];
            await makeCallToLLM({
                client: createDefaultHttpClient(),
                config: createDefaultLLMConfig(),
                toolDispatcher: createDefaultToolDispatcher(),
                message: value,
                tools: currentTools,
                setStats,
                store,
                compactionStrategy,
                sessionLogger,
                signal: abortControllerRef.current.signal,
            });
        } catch (e) {
            if (e instanceof Error && e.message === 'Aborted') {
                setNotification("Turn abandoned.");
            } else {
                const msg = e instanceof Error ? e.message : String(e);
                setNotification(`LLM call failed: ${msg}`);
            }
        } finally {
            setIsProcessing(false);
            abortControllerRef.current = null;
        }
    };

    // Job mode: on mount, run the job autonomously to completion, then signal
    // the exit code. Guarded by a ref so React's effect re-runs can't re-launch
    // an in-flight job.
    useEffect(() => {
        if (!job || jobStartedRef.current) return;
        jobStartedRef.current = true;
        const activeJob = job;

        const runJob = async () => {
            setIsProcessing(true);
            abortControllerRef.current = new AbortController();
            store.appendEvent('job_start', `Job started: ${activeJob.filePath}`);

            let code = 1;
            try {
                await makeCallToLLM({
                    client: createDefaultHttpClient(),
                    config: createDefaultLLMConfig(),
                    toolDispatcher: createDefaultToolDispatcher(),
                    message: job.prompt,
                    tools: tools.length > 0 ? [...tools] : [],
                    setStats,
                    store,
                    compactionStrategy,
                    sessionLogger,
                    signal: abortControllerRef.current.signal,
                    options: { maxLoops: activeJob.maxLoops, systemPrompt: activeJob.systemPrompt },
                });

                // Classify the outcome from the final assistant message's sentinel.
                const msgs = store.getMessages();
                const finalText = [...msgs].reverse().find(m => m.role === 'assistant' && m.content)?.content ?? '';
                const outcome = classifyJobOutcome(finalText);
                code = outcome.code;
                store.appendEvent(outcome.event, outcome.message);
            } catch (e) {
                code = 1;
                const msg = e instanceof Error ? e.message : String(e);
                store.appendEvent('job_blocked', `Job failed: ${msg}`);
                sessionLogger.error({ error: msg }, 'Job run failed');
            } finally {
                setIsProcessing(false);
                abortControllerRef.current = null;
                try { await store.persist(); } catch { /* best-effort */ }
                onJobEnd?.(code);
            }
        };

        runJob();
        // job is stable for the lifetime of the process; run exactly once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [job]);

    if (isReviewing) {
        return (
            <ReviewView
                messages={messages}
                width={contentWidth}
                height={termHeight}
                toolsByName={toolsByName}
                onExit={exitReview}
            />
        );
    }

    return (
        <>
            {/* Committed history — rendered once each, kept in the terminal scrollback. */}
            <Static items={committedMessages}>
                {(msg) => (
                    <MessageView
                        key={msg.id}
                        msg={msg}
                        width={contentWidth}
                        toolsByName={toolsByName}
                    />
                )}
            </Static>

            {/* Live area: in-flight turn + UI chrome. Re-renders freely.
                No paddingX here — MessageView already provides 1 col, and
                stacking would offset streaming messages relative to Static. */}
            <Box flexDirection="column">
                {/* Events (reset, compaction progress) are inline 'event' messages
                    and render through MessageView in the committed/live streams. */}
                {liveMessages.map((msg) => (
                    <React.Fragment key={msg.id}>
                        {liveReasoning.msgId === msg.id && liveReasoning.text && (
                            <Box paddingX={1} marginBottom={1}>
                                <Box width={PREFIX_GUTTER} flexShrink={0}>
                                    <Text color={theme.muted} dimColor>~</Text>
                                </Box>
                                <Box flexGrow={1}>
                                    <Text color={theme.muted} dimColor>{liveReasoning.text}</Text>
                                </Box>
                            </Box>
                        )}
                        <MessageView
                            msg={msg}
                            width={contentWidth}
                            toolsByName={toolsByName}
                        />
                    </React.Fragment>
                ))}

                {notification && (
                    <Box marginBottom={1} borderStyle="single" borderColor={theme.notification} paddingX={1}>
                        <Text color={theme.notification}>{notification}</Text>
                    </Box>
                )}

                {isConfirmingCancel && (
                    <Box marginBottom={1} borderStyle="double" borderColor={theme.danger} paddingX={1}>
                        <Text color={theme.danger} bold>
                            {stats.status === 'idle'
                                ? 'Are you sure you want to leave Harry? (y/N)'
                                : 'Are you sure you want to cancel the current turn? (y/N)'}
                        </Text>
                    </Box>
                )}

                {job ? (
                    <Box
                        paddingX={1}
                        borderStyle="single"
                        borderColor={theme.accent}
                        borderLeft={false}
                        borderRight={false}
                    >
                        <Text color={theme.accent} bold>JOB </Text>
                        <Text color={theme.muted}>
                            {isProcessing ? 'running autonomously…' : 'finished'} — input disabled
                        </Text>
                    </Box>
                ) : (
                    <Box
                        paddingX={1}
                        borderStyle="single"
                        borderColor={theme.muted}
                        borderLeft={false}
                        borderRight={false}
                    >
                        <Text color={isConfirmingCancel ? theme.danger : theme.inputPrompt} bold>
                            {isConfirmingCancel
                                ? (stats.status === 'idle' ? `[LEAVING] ${theme.glyph.prompt} ` : `[CANCELING] ${theme.glyph.prompt} `)
                                : `${theme.glyph.prompt} `}
                        </Text>
                        <TextInput
                            key={textInputKey}
                            value={input}
                            onChange={(val) => {
                                if (suppressNextInputChange.current || isEditing) {
                                    suppressNextInputChange.current = false;
                                    return;
                                }
                                setInput(val);
                            }}
                            onSubmit={handleInput}
                        />
                    </Box>
                )}

                <Box paddingX={1}>
                    <Text color={theme.muted}>
                        Status: <Text color={theme.accent}>{stats.status.toUpperCase()}</Text> |
                        Tokens: <Text color={theme.accent}>{stats.tokens}</Text> |
                        TPS: <Text color={theme.accent}>{stats.tps.toFixed(1)}</Text> |
                        Context: <ContextGauge
                            used={stats.contextSize}
                            cached={stats.cachedContextSize}
                            max={MAX_CONTEXT_SIZE}
                            threshold={COMPACTION_THRESHOLD}
                        /> |
                        <Text color={theme.accent}> Ctrl-R</Text> review  <Text color={theme.accent}> Ctrl-E</Text> editor
                    </Text>
                </Box>
            </Box>
        </>
    );
};
