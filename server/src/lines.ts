// Read-only line reader for transcripts, bounded in memory whatever the file or line size.
import { closeSync, openSync, readSync, realpathSync, constants as FS } from 'node:fs';
import { sep } from 'node:path';

const CHUNK = 1024 * 1024;

/**
 * Calls onLine for each complete line in [0, end). A line longer than maxLine is reported as null.
 * Return false from onLine to stop early.
 */
export function forEachLine(path: string, end: number, maxLine: number, onLine: (line: Buffer | null, lineNo: number) => boolean | void) {
  const fd = openSync(path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = 0;
    let lineNo = 0;
    let carry: Buffer[] = [];
    let carryLen = 0;
    let oversize = false;
    while (pos < end) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, end - pos), pos);
      if (n <= 0) break;
      let start = 0;
      for (;;) {
        const nl = buf.subarray(0, n).indexOf(0x0a, start);
        if (nl === -1) break;
        lineNo++;
        const piece = buf.subarray(start, nl);
        const line = oversize || carryLen + piece.length > maxLine ? null : carryLen ? Buffer.concat([...carry, piece]) : piece;
        carry = [];
        carryLen = 0;
        oversize = false;
        start = nl + 1;
        if (onLine(line, lineNo) === false) return;
      }
      if (start < n && !oversize) {
        if (carryLen + (n - start) > maxLine) {
          oversize = true;
          carry = [];
          carryLen = 0;
        } else {
          carry.push(Buffer.from(buf.subarray(start, n)));
          carryLen += n - start;
        }
      }
      pos += n;
    }
  } finally {
    closeSync(fd);
  }
}

/** True when the path's real location is inside root (symbolic links resolved). */
export function realPathInside(path: string, root: string): boolean {
  try {
    const real = realpathSync(path);
    const realRoot = realpathSync(root);
    return real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep);
  } catch {
    return false;
  }
}
