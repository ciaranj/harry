import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeToFile } from './writeToFile.js';
import { writeFile, unlink, readFile } from 'node:fs/promises';

describe('writeToFile', () => {
    const testFiles: string[] = [];

    beforeEach(async () => {
        process.env.MODEL = 'test-model';
    });

    afterEach(async () => {
        for (const file of testFiles) {
            try { await unlink(file); } catch { /* ignore */ }
        }
    });

    it('should create a new file with the given content', async () => {
        const testPath = 'test_write_new.txt';
        testFiles.push(testPath);
        const content = 'Hello, world!';

        const result = await writeToFile.execute({ path: testPath, content });

        expect(result.success).toBe(true);
        expect(result.message).toContain('Successfully wrote');
        const writtenContent = await readFile(testPath, 'utf-8');
        expect(writtenContent).toBe(content);
    });

    it('should overwrite an existing file', async () => {
        const testPath = 'test_write_overwrite.txt';
        testFiles.push(testPath);
        const initialContent = 'initial';
        const newContent = 'overwritten';

        await writeFile(testPath, initialContent, 'utf-8');
        const result = await writeToFile.execute({ path: testPath, content: newContent, mode: 'overwrite' });

        expect(result.success).toBe(true);
        const writtenContent = await readFile(testPath, 'utf-8');
        expect(writtenContent).toBe(newContent);
    });

    it('should append to an existing file when mode=append', async () => {
        const testPath = 'test_write_append.txt';
        testFiles.push(testPath);
        const initialContent = 'first part';
        const appendContent = ' second part';

        await writeFile(testPath, initialContent, 'utf-8');
        const result = await writeToFile.execute({ path: testPath, content: appendContent, mode: 'append' });

        expect(result.success).toBe(true);
        expect(result.message).toContain('appended');
        const writtenContent = await readFile(testPath, 'utf-8');
        expect(writtenContent).toBe(initialContent + appendContent);
    });

    it('should return error for invalid path', async () => {
        const result = await writeToFile.execute({ path: '/nonexistent/path/file.txt', content: 'test' });

        expect(result.success).toBe(false);
        expect(result.message).toContain('resolves outside');
    });

    it('should default to overwrite mode', async () => {
        const testPath = 'test_write_default.txt';
        testFiles.push(testPath);
        await writeFile(testPath, 'original', 'utf-8');

        const result = await writeToFile.execute({ path: testPath, content: 'new' });

        expect(result.success).toBe(true);
        const content = await readFile(testPath, 'utf-8');
        expect(content).toBe('new');
    });

    it('should write binary-safe content', async () => {
        const testPath = 'test_write_binary.txt';
        testFiles.push(testPath);
        const content = '\x00\x01\x02\x03';

        const result = await writeToFile.execute({ path: testPath, content });

        expect(result.success).toBe(true);
        const writtenContent = await readFile(testPath, 'utf-8');
        expect(writtenContent).toBe(content);
    });

    // --- renderCallText tests ---

    it('renderCallText should show "Writing" for default (overwrite) mode', () => {
        const text = writeToFile.renderCallText({ path: 'main.py', content: 'hello' });
        expect(text).toBe('Writing main.py (5 bytes)');
    });

    it('renderCallText should show "Appending to" when mode is append', () => {
        const text = writeToFile.renderCallText({ path: 'log.txt', content: 'new line', mode: 'append' });
        expect(text).toBe('Appending to log.txt (8 bytes)');
    });

    it('renderCallText should show "Writing" when mode is overwrite explicitly', () => {
        const text = writeToFile.renderCallText({ path: 'data.json', content: '{}', mode: 'overwrite' });
        expect(text).toBe('Writing data.json (2 bytes)');
    });

    it('renderCallText should report correct byte length for multi-byte content', () => {
        const text = writeToFile.renderCallText({ path: 'unicode.txt', content: 'héllo' });
        expect(text).toBe('Writing unicode.txt (5 bytes)');
    });
});
