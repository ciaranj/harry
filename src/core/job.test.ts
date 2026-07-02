import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJobArg, loadJob, classifyJobOutcome, JobValidationError } from './job.js';
import { jobSystemPrompt } from '../constants.js';

const tmpDirs: string[] = [];
function writeJob(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'harry-job-'));
    tmpDirs.push(dir);
    const file = join(dir, 'job.md');
    writeFileSync(file, contents, 'utf8');
    return file;
}

afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('parseJobArg', () => {
    it('returns undefined when no job flag is present', () => {
        expect(parseJobArg(['--foo', 'bar'])).toBeUndefined();
    });

    it('parses -j <file> and --job <file>', () => {
        expect(parseJobArg(['-j', 'job.md'])).toBe('job.md');
        expect(parseJobArg(['--job', 'tasks/x.md'])).toBe('tasks/x.md');
    });

    it('parses --job=<file>', () => {
        expect(parseJobArg(['--job=tasks/x.md'])).toBe('tasks/x.md');
    });

    it('throws when the flag is given without a path', () => {
        expect(() => parseJobArg(['-j'])).toThrow(JobValidationError);
        expect(() => parseJobArg(['-j', '--other'])).toThrow(JobValidationError);
        expect(() => parseJobArg(['--job='])).toThrow(JobValidationError);
    });
});

describe('loadJob', () => {
    it('builds a JobConfig with the standalone job system prompt and embedded brief', () => {
        const file = writeJob('## Goal\nMigrate the config loader.\n\n## Verification\nnpm test passes.');
        const job = loadJob(file);

        expect(job.systemPrompt).toBe(jobSystemPrompt);
        expect(job.maxLoops).toBeGreaterThan(1000);
        expect(job.prompt).toContain('<job>');
        expect(job.prompt).toContain('Migrate the config loader.');
        expect(job.filePath).toMatch(/job\.md$/);
    });

    it('rejects an empty job file', () => {
        const file = writeJob('   \n  ');
        expect(() => loadJob(file)).toThrow(/empty/);
    });

    it('rejects a job file with no Goal heading', () => {
        const file = writeJob('## Vision\nMake it nice.\n\n## Tasks\n- do stuff');
        expect(() => loadJob(file)).toThrow(/Goal/);
    });

    it('accepts a Goal heading at any markdown level', () => {
        const file = writeJob('# Goal\nDo the thing.');
        expect(() => loadJob(file)).not.toThrow();
    });

    it('throws JobValidationError for a missing file', () => {
        expect(() => loadJob('/no/such/path/job.md')).toThrow(JobValidationError);
    });
});

describe('classifyJobOutcome', () => {
    it('reports complete (exit 0) on JOB_COMPLETE', () => {
        const o = classifyJobOutcome('All tasks done, tests pass.\nJOB_COMPLETE');
        expect(o.code).toBe(0);
        expect(o.event).toBe('job_complete');
    });

    it('detects JOB_COMPLETE even when not line-anchored', () => {
        expect(classifyJobOutcome('Done. JOB_COMPLETE').code).toBe(0);
    });

    it('reports blocked (exit 1) on JOB_BLOCKED and extracts the reason', () => {
        const o = classifyJobOutcome('Did setup.\nJOB_BLOCKED: missing AWS credentials');
        expect(o.code).toBe(1);
        expect(o.event).toBe('job_blocked');
        expect(o.message).toContain('missing AWS credentials');
    });

    it('lets JOB_BLOCKED win when both sentinels appear', () => {
        const o = classifyJobOutcome('JOB_COMPLETE was the plan but JOB_BLOCKED: ran out of options');
        expect(o.code).toBe(1);
        expect(o.event).toBe('job_blocked');
    });

    it('treats a run with no sentinel as incomplete (exit 1)', () => {
        const o = classifyJobOutcome('I think that is probably fine.');
        expect(o.code).toBe(1);
        expect(o.event).toBe('job_blocked');
    });

    it('treats empty final text as incomplete', () => {
        expect(classifyJobOutcome('').code).toBe(1);
    });
});
