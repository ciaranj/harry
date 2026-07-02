import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { jobSystemPrompt } from '../constants.js';

// A job runs Harry autonomously to completion against a markdown brief.
// See jobSystemPrompt for the behavioural contract the model operates under.
export interface JobConfig {
    /** Absolute path to the job markdown file. */
    filePath: string;
    /** The framed user message that kicks the job off. */
    prompt: string;
    /** The complete JOB MODE system prompt to use for this run. */
    systemPrompt: string;
    /** Effectively-unlimited loop cap so long jobs aren't cut short. */
    maxLoops: number;
}

// Large enough that hitting it implies a runaway loop rather than honest work.
const JOB_MAX_LOOPS = 100_000;

export class JobValidationError extends Error {}

export interface JobOutcome {
    /** Process exit code: 0 = complete, 1 = blocked/incomplete. */
    code: 0 | 1;
    event: 'job_complete' | 'job_blocked';
    /** Human-readable status for the UI/log. */
    message: string;
}

/**
 * Classify a finished job from its final assistant message. Uses substring
 * (not line-anchored) matching so minor formatting variance from the model
 * doesn't misclassify the run. JOB_BLOCKED wins over JOB_COMPLETE so an
 * aborted job is never reported as a success, and a run that ends with no
 * sentinel at all is treated as incomplete (blocked).
 */
export function classifyJobOutcome(finalAssistantText: string): JobOutcome {
    const text = finalAssistantText ?? '';
    if (/\bJOB_BLOCKED\b/.test(text)) {
        const reason = text.match(/\bJOB_BLOCKED\b:?\s*(.*)/)?.[1]?.trim();
        return {
            code: 1,
            event: 'job_blocked',
            message: reason ? `Job blocked: ${reason}` : 'Job blocked — human intervention required',
        };
    }
    if (/\bJOB_COMPLETE\b/.test(text)) {
        return { code: 0, event: 'job_complete', message: 'Job complete' };
    }
    return {
        code: 1,
        event: 'job_blocked',
        message: 'Job ended without JOB_COMPLETE — treating as incomplete',
    };
}

/**
 * Pull the job file path from argv. Recognises `-j <file>` and `--job <file>`
 * (and `--job=<file>`). Returns undefined when no job flag is present.
 * Throws JobValidationError when the flag is given without a path.
 */
export function parseJobArg(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-j' || arg === '--job') {
            const next = argv[i + 1];
            if (!next || next.startsWith('-')) {
                throw new JobValidationError(`${arg} requires a path to a job .md file`);
            }
            return next;
        }
        if (arg.startsWith('--job=')) {
            const value = arg.slice('--job='.length);
            if (!value) throw new JobValidationError('--job= requires a path to a job .md file');
            return value;
        }
    }
    return undefined;
}

/**
 * Read and validate a job file, then build the JobConfig used to drive the run.
 * Validation is intentionally light: the file must be non-empty and declare a
 * Goal heading. Other sections (Verification, Vision, Plan, Tasks) are a
 * convention surfaced to the model, not enforced here.
 */
export function loadJob(filePath: string): JobConfig {
    const absPath = resolve(filePath);

    let content: string;
    try {
        content = readFileSync(absPath, 'utf8');
    } catch (err) {
        throw new JobValidationError(`Cannot read job file '${filePath}': ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!content.trim()) {
        throw new JobValidationError(`Job file '${filePath}' is empty`);
    }

    // Require a Goal so the model always has a verifiable objective.
    if (!/^#{1,6}\s+Goal\b/im.test(content)) {
        throw new JobValidationError(
            `Job file '${filePath}' has no Goal section. A job must declare a '## Goal' heading describing the objective and how it is verified.`
        );
    }

    const prompt = [
        `You are executing a JOB defined in the markdown file \`${absPath}\`.`,
        `Run it autonomously to completion following the JOB MODE rules. The full job definition is below.`,
        '',
        '<job>',
        content.trim(),
        '</job>',
        '',
        'Begin now.',
    ].join('\n');

    return {
        filePath: absPath,
        prompt,
        systemPrompt: jobSystemPrompt,
        maxLoops: JOB_MAX_LOOPS,
    };
}
