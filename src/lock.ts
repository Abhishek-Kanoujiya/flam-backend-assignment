import fs from 'fs';
import path from 'path';

const LOCKS_DIR = path.resolve('./.locks');

export function initLockDirectory(): void {
  if (!fs.existsSync(LOCKS_DIR)) {
    fs.mkdirSync(LOCKS_DIR, { recursive: true });
  }
}

export function acquireLock(lockName: string, timeoutMs: number = 5000): boolean {
  initLockDirectory();
  const lockPath = path.join(LOCKS_DIR, `${lockName}.lock`);
  const start = Date.now();
  const retryInterval = 20; // ms

  while (true) {
    try {
      // fs.mkdirSync is atomic across processes
      fs.mkdirSync(lockPath);
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      // Synchronous busy-wait sleep
      const waitTill = Date.now() + retryInterval;
      while (Date.now() < waitTill) {
        // spin
      }
    }
  }
}

export function releaseLock(lockName: string): void {
  const lockPath = path.join(LOCKS_DIR, `${lockName}.lock`);
  try {
    if (fs.existsSync(lockPath)) {
      fs.rmdirSync(lockPath);
    }
  } catch (err) {
    // Ignore
  }
}
