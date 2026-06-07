import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFiles } from './readFiles.js';
import { writeFile, unlink, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TEST_DIR = './_rf_test_files';

describe('readFiles', () => {
    const testFiles: string[] = [];

    beforeEach(async () => {
        process.env.MODEL = 'test-model';
        try { await mkdir(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
    });

    afterEach(async () => {
        for (const file of testFiles) {
            try { await unlink(file); } catch { /* ignore */ }
        }
        try { await mkdir(TEST_DIR, { recursive: true }); /* cleanup dir */ } catch { /* ignore */ }
    });

    function tmpPath(name: string): string {
        const p = path.join(TEST_DIR, name);
        testFiles.push(p);
        return p;
    }

    it('should return empty array for empty input', async () => {
        const result = await readFiles.execute({ paths: [] });
        expect(result).toEqual([]);
    });

    it('should read multiple valid files successfully', async () => {
        const file1 = 'src/utils.ts';
        const file2 = 'src/core/types.ts';

        const result = await readFiles.execute({ paths: [{ path: file1 }, { path: file2 }] });

        expect(result).toHaveLength(2);
        expect(result[0].path).toBe(file1);
        expect(result[0].success).toBe(true);
        expect(result[0].content).toBeDefined();
        expect(typeof result[0].content).toBe('string');
        expect(result[0].error).toBeUndefined();

        expect(result[1].path).toBe(file2);
        expect(result[1].success).toBe(true);
        expect(result[1].content).toBeDefined();
        expect(result[1].error).toBeUndefined();
    });

    it('should return error for non-existent file', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'nonexistent_file.txt' }] });

        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('nonexistent_file.txt');
        expect(result[0].success).toBe(false);
        expect(result[0].error).toBeDefined();
        expect(typeof result[0].error).toBe('string');
        expect(result[0].content).toBeUndefined();
    });

    it('should handle mixed valid and invalid paths', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'src/utils.ts' }, { path: 'does_not_exist.txt' }] });

        expect(result).toHaveLength(2);
        expect(result[0].success).toBe(true);
        expect(result[0].content).toBeDefined();
        expect(result[1].success).toBe(false);
        expect(result[1].error).toBeDefined();
    });

    it('should handle multiple non-existent files', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'file1.txt' }, { path: 'file2.txt' }, { path: 'file3.txt' }] });

        expect(result).toHaveLength(3);
        for (const item of result) {
            expect(item.success).toBe(false);
            expect(item.error).toBeDefined();
        }
    });

    it('should return content that contains expected code', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'src/utils.ts' }] });

        expect(result[0].success).toBe(true);
        expect(result[0].content).toContain('buildLLMPayload');
        expect(result[0].content).toContain('export interface LLMPayload');
    });

    it('should return error message with meaningful text', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'nonexistent_file.txt' }] });

        expect(result[0].success).toBe(false);
        expect(result[0].error).toContain('ENOENT');
    });

    it('should preserve file content with newlines and formatting', async () => {
        const result = await readFiles.execute({ paths: [{ path: 'src/core/types.ts' }] });

        expect(result[0].success).toBe(true);
        expect(result[0].content).toContain('\n');
        expect(result[0].content).toContain('export type Message');
    });

    // --- Line-range tests (using unified paths format) ---

    it('should read a specific line range from a file', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 1, end: 5 }]
        });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(true);
        expect(result[0].path).toBe('src/utils.ts');
        expect(result[0].lineCount).toBe(5);
        const lines = result[0].content!.split('\n');
        expect(lines).toHaveLength(5);
    });

    it('should read a middle line range from a file', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 10, end: 15 }]
        });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(true);
        expect(result[0].lineCount).toBe(6); // inclusive end
        const lines = result[0].content!.split('\n');
        expect(lines).toHaveLength(6);
    });

    it('should clamp line start to 1 if below', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: -5, end: 3 }]
        });

        expect(result[0].success).toBe(true);
        expect(result[0].lineCount).toBe(3);
    });

    it('should clamp line end to file length if above', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 1, end: 9999 }]
        });

        expect(result[0].success).toBe(true);
        const contentLines = result[0].content!.split('\n');
        expect(result[0].lineCount).toBe(contentLines.length);
    });

    it('should return error when start > end', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 10, end: 5 }]
        });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(false);
        expect(result[0].error).toContain('out of bounds');
    });

    it('should return error when both start and end are out of bounds', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 9999, end: 10000 }]
        });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(false);
    });

    it('should handle mixed full reads and line-range reads in one call', async () => {
        const result = await readFiles.execute({
            paths: [
                { path: 'src/utils.ts' },
                { path: 'src/core/types.ts', start: 1, end: 3 }
            ]
        });

        expect(result).toHaveLength(2);
        // utils.ts should be full read (no lineCount)
        const fullRead = result.find(r => r.path === 'src/utils.ts');
        expect(fullRead?.success).toBe(true);
        expect(fullRead?.lineCount).toBeUndefined();

        // types.ts should be line-range read
        const rangeRead = result.find(r => r.path === 'src/core/types.ts');
        expect(rangeRead?.success).toBe(true);
        expect(rangeRead?.lineCount).toBe(3);
    });

    it('should handle multiple line ranges across different files', async () => {
        const result = await readFiles.execute({
            paths: [
                { path: 'src/utils.ts', start: 1, end: 2 },
                { path: 'src/core/types.ts', start: 1, end: 2 }
            ]
        });

        expect(result).toHaveLength(2);
        expect(result[0].lineCount).toBe(2);
        expect(result[1].lineCount).toBe(2);
    });

    it('should handle non-existent file in line ranges', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'no_such_file.ts', start: 1, end: 5 }]
        });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(false);
        expect(result[0].error).toBeDefined();
    });

    it('should read a single line when start equals end', async () => {
        const result = await readFiles.execute({
            paths: [{ path: 'src/utils.ts', start: 1, end: 1 }]
        });

        expect(result[0].success).toBe(true);
        expect(result[0].lineCount).toBe(1);
    });

    it('should handle multiple line-range slices of the same file', async () => {
        const result = await readFiles.execute({
            paths: [
                { path: 'src/utils.ts', start: 1, end: 3 },
                { path: 'src/utils.ts', start: 8, end: 12 },
                { path: 'src/utils.ts', start: 1, end: 3 }
            ]
        });

        expect(result).toHaveLength(3);
        expect(result[0].success).toBe(true);
        expect(result[0].lineCount).toBe(3);
        expect(result[1].success).toBe(true);
        expect(result[1].lineCount).toBe(5);
        expect(result[2].success).toBe(true);
        expect(result[2].lineCount).toBe(3);

        // Duplicate ranges should return identical content
        expect(result[0].content).toBe(result[2].content);
    });

    // --- renderCallText tests ---

    it('renderCallText should show "Reading" prefix with full file paths', () => {
        const text = readFiles.renderCallText({ paths: [{ path: 'src/utils.ts' }, { path: 'src/core/types.ts' }] });
        expect(text).toBe('Reading src/utils.ts, src/core/types.ts');
    });

    it('renderCallText should show line ranges when start and end are provided', () => {
        const text = readFiles.renderCallText({ paths: [{ path: 'src/utils.ts', start: 10, end: 20 }] });
        expect(text).toBe('Reading src/utils.ts:10-20');
    });

    it('renderCallText should omit line range when start is undefined but end is defined', () => {
        const text = readFiles.renderCallText({ paths: [{ path: 'src/utils.ts', end: 5 }] });
        expect(text).toBe('Reading src/utils.ts');
    });

    it('renderCallText should omit line range when end is undefined but start is defined', () => {
        const text = readFiles.renderCallText({ paths: [{ path: 'src/utils.ts', start: 5 }] });
        expect(text).toBe('Reading src/utils.ts');
    });

    it('renderCallText should handle mixed full reads and line-range reads', () => {
        const text = readFiles.renderCallText({
            paths: [
                { path: 'src/utils.ts' },
                { path: 'src/core/types.ts', start: 1, end: 3 }
            ]
        });
        expect(text).toBe('Reading src/utils.ts, src/core/types.ts:1-3');
    });

    it('renderCallText should handle empty paths array', () => {
        const text = readFiles.renderCallText({ paths: [] });
        expect(text).toBe('Reading ');
    });

    // --- Truncation / 20KB limit tests ---

    it('should read a small file within the 20KB limit without truncation', async () => {
        const smallFile = tmpPath('small.txt');
        const content = 'x'.repeat(100);
        await writeFile(smallFile, content);

        const result = await readFiles.execute({ paths: [{ path: smallFile }] });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(true);
        expect(result[0].truncated).toBe(false);
        expect(result[0].unreadBytes).toBe(0);
        expect(Buffer.byteLength(result[0].content ?? '', 'utf-8')).toBe(Buffer.byteLength(content, 'utf-8'));
    });

    it('should truncate a single file that exceeds the 20KB limit', async () => {
        const largeFile = tmpPath('large.txt');
        const content = 'x'.repeat(25 * 1024); // 25KB
        await writeFile(largeFile, content);

        const result = await readFiles.execute({ paths: [{ path: largeFile }] });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(true);
        expect(result[0].truncated).toBe(true);
        expect(result[0].unreadBytes).toBe(5 * 1024); // 25KB - 20KB read
        expect(Buffer.byteLength(result[0].content ?? '', 'utf-8')).toBe(20 * 1024);
    });

    it('should mark all subsequent files as truncated once limit is reached', async () => {
        const file1 = tmpPath('file1.txt');
        const file2 = tmpPath('file2.txt');
        const file3 = tmpPath('file3.txt');

        // file1 fits within limit
        await writeFile(file1, 'x'.repeat(1024));

        // file2 and file3 are large
        await writeFile(file2, 'y'.repeat(30 * 1024));
        await writeFile(file3, 'z'.repeat(30 * 1024));

        const result = await readFiles.execute({ paths: [{ path: file1 }, { path: file2 }, { path: file3 }] });

        expect(result).toHaveLength(3);

        // file1: within limit, no truncation
        expect(result[0].success).toBe(true);
        expect(result[0].truncated).toBe(false);
        expect(result[0].unreadBytes).toBe(0);

        // file2: triggers truncation
        expect(result[1].success).toBe(true);
        expect(result[1].truncated).toBe(true);
        expect(result[1].unreadBytes).toBeGreaterThan(0);

        // file3: subsequent, no content, full file size reported as unread
        expect(result[2].success).toBe(true);
        expect(result[2].truncated).toBe(true);
        expect(result[2].content).toBeUndefined();
        expect(result[2].unreadBytes).toBe(30 * 1024);
    });

    it('should mark files within the limit as not truncated', async () => {
        const fileA = tmpPath('fileA.txt');
        const fileB = tmpPath('fileB.txt');

        await writeFile(fileA, 'A'.repeat(5 * 1024));
        await writeFile(fileB, 'B'.repeat(5 * 1024));

        const result = await readFiles.execute({ paths: [{ path: fileA }, { path: fileB }] });

        expect(result[0].success).toBe(true);
        expect(result[0].truncated).toBe(false);
        expect(result[0].unreadBytes).toBe(0);

        expect(result[1].success).toBe(true);
        expect(result[1].truncated).toBe(false);
        expect(result[1].unreadBytes).toBe(0);
    });

    it('should handle line-range reads with truncation', async () => {
        const file = tmpPath('range.txt');
        // Create a file that's ~15KB
        const content = 'x'.repeat(15 * 1024);
        await writeFile(file, content);

        const result = await readFiles.execute({ paths: [{ path: file, start: 1, end: 1000 }] });

        expect(result).toHaveLength(1);
        expect(result[0].success).toBe(true);
        // 1000 lines of ~15 bytes each ≈ 15KB, should fit within 20KB
        expect(result[0].truncated).toBe(false);
    });

    it('should report correct total bytes when under the limit', async () => {
        const file1 = tmpPath('file1.txt');
        const file2 = tmpPath('file2.txt');

        await writeFile(file1, 'A'.repeat(5 * 1024));
        await writeFile(file2, 'B'.repeat(3 * 1024));

        const result = await readFiles.execute({ paths: [{ path: file1 }, { path: file2 }] });

        // Both files fit within limit — verify full content returned
        expect(Buffer.byteLength(result[0].content ?? '', 'utf-8')).toBe(5 * 1024);
        expect(Buffer.byteLength(result[1].content ?? '', 'utf-8')).toBe(3 * 1024);
    });

    it('should report accurate unreadBytes for truncated files', async () => {
        const largeFile = tmpPath('large.txt');
        const content = 'x'.repeat(30 * 1024);
        await writeFile(largeFile, content);

        const result = await readFiles.execute({ paths: [{ path: largeFile }] });

        const expectedUnread = 30 * 1024 - 20 * 1024;
        expect(result[0].unreadBytes).toBe(expectedUnread);
    });

    it('should report file size for files read after limit is reached', async () => {
        const smallFile = tmpPath('small.txt');
        const largeFile = tmpPath('large.txt');

        await writeFile(smallFile, 'A'.repeat(1024));
        await writeFile(largeFile, 'B'.repeat(25 * 1024));

        const result = await readFiles.execute({ paths: [{ path: smallFile }, { path: largeFile }] });

        // smallFile consumes 1KB, leaving 19KB for largeFile.
        // largeFile is 25KB, so 19KB read + 6KB unread.
        expect(result[0].truncated).toBe(false);
        expect(result[1].truncated).toBe(true);
        expect(result[1].unreadBytes).toBe(6 * 1024); // 25KB - 19KB read
        expect(Buffer.byteLength(result[1].content ?? '', 'utf-8')).toBe(19 * 1024);
    });
});
