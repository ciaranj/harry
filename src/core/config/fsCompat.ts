/** Thin compatibility wrapper around node:fs that matches ConfigFileIO exactly. */
import * as fs from 'node:fs';

export const fsCompat = {
  existsSync(p: string): boolean {
    return fs.existsSync(p);
  },
  readFileSync(p: string, encoding: string): string {
    return fs.readFileSync(p, encoding as BufferEncoding);
  },
  writeFileSync(p: string, data: string, encoding: string): void {
    fs.writeFileSync(p, data, encoding as BufferEncoding);
  },
  mkdirSync(p: string, opts?: { recursive: boolean }): void {
    fs.mkdirSync(p, opts ?? { recursive: true });
  },
} as const;
