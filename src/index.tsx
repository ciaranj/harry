import { render } from 'ink';
import type pino from 'pino';
import { App } from './ui/App.js';
import { makeCallToLLM } from './core/llm.js';
import { loadSession, createSession, SessionStore, JOB_SESSION_PREFIX } from './core/session.js';
import { GuardrailConfigManager, createDefaultConfigStore } from './core/config/index.js';
import { getLoggerInstance, closeLogger } from './core/log.js';
import { parseJobArg, loadJob, JobValidationError, type JobConfig } from './core/job.js';

async function main() {
    const log = getLoggerInstance(process.cwd());

    // Job mode: `harry -j <file>` runs a markdown-defined job autonomously to
    // completion, then exits with code 0 (JOB_COMPLETE) or 1 (JOB_BLOCKED).
    let job: JobConfig | undefined;
    try {
        const jobPath = parseJobArg(process.argv.slice(2));
        if (jobPath) job = loadJob(jobPath);
    } catch (err) {
        if (err instanceof JobValidationError) {
            console.error(`harry: ${err.message}`);
            process.exit(2);
        }
        throw err;
    }

    let store: SessionStore;
    let sessionLogger: pino.Logger;
    try {
        // Jobs run in a fresh, isolated session: they must not inherit prior
        // interactive conversation/context, and should be reproducible.
        const loaded = job ? null : await loadSession();
        const session = loaded || createSession(process.cwd(), job ? JOB_SESSION_PREFIX : '');
        store = new SessionStore(session, process.cwd());
        sessionLogger = log.child({ sessionId: session.id });
        if (loaded) {
            sessionLogger.info({ messages: session.messages.length }, 'Harry started — resumed session');
        } else {
            await store.persist();
            sessionLogger.info({ messages: session.messages.length, job: job?.filePath }, job ? 'Harry started — job session' : 'Harry started — new session');
        }
    } catch (err) {
        console.error('Failed to load/create session:', err);
        const session = createSession();
        store = new SessionStore(session, process.cwd());
        sessionLogger = log.child({ sessionId: session.id });
    }

    // Load guardrail config early so tools can check permissions.
    const configStore = createDefaultConfigStore();
    const guardrails = new GuardrailConfigManager(configStore);
    sessionLogger.info('Guardrail config loaded');

    // When a job ends, flush logs, tear down the TUI, and exit with the
    // job's status code so `harry -j` is scriptable in CI / shell pipelines.
    const onJobEnd = async (code: number) => {
        try { unmount(); } catch { /* TUI may already be torn down */ }
        try { await closeLogger(); } catch { /* best-effort; never override exit code */ }
        process.exit(code);
    };

    const { unmount } = render(
        <App
            makeCallToLLM={makeCallToLLM}
            store={store}
            sessionLogger={sessionLogger}
            guardrails={guardrails}
            job={job}
            onJobEnd={onJobEnd}
        />
    );

    // Graceful shutdown: flush logs and unmount TUI on signal.
    const shutdown = async () => {
        unmount();
        await closeLogger();
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main();
