import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getWorkers, saveWorkers } from './store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HEARTBEAT_TIMEOUT = 5000; // 5 seconds

/**
 * Cleans up dead workers from the registry (heartbeat timed out)
 */
export function cleanupDeadWorkers(): void {
  const workers = getWorkers();
  const now = Date.now();
  const activeWorkers = workers.filter((w) => {
    // Keep workers that updated heartbeat recently
    return now - w.heartbeat < HEARTBEAT_TIMEOUT;
  });
  if (activeWorkers.length !== workers.length) {
    saveWorkers(activeWorkers);
  }
}

export function startWorkers(count: number): void {
  cleanupDeadWorkers();
  const workerScript = path.resolve(__dirname, 'worker.js');
  const logFile = path.resolve('./worker.log');
  
  // Ensure log directory/file is accessible
  let outFd: number;
  try {
    outFd = fs.openSync(logFile, 'a');
  } catch (err) {
    outFd = 1; // Fallback to stdout
  }

  for (let i = 0; i < count; i++) {
    // Spawn worker as a detached background process
    const child = spawn(process.execPath, [workerScript], {
      detached: true,
      stdio: ['ignore', outFd, outFd],
      windowsHide: true
    });
    
    child.unref(); // Allow the parent CLI process to exit independently
  }
}

/**
 * Gracefully stops all active workers
 */
export function stopWorkers(): number {
  cleanupDeadWorkers();
  const workers = getWorkers();
  if (workers.length === 0) {
    return 0;
  }

  // Mark all active workers as 'stopping' in the database
  const updatedWorkers = workers.map((w) => {
    w.status = 'stopping';
    w.heartbeat = Date.now();
    return w;
  });
  saveWorkers(updatedWorkers);

  // Send SIGINT signal to each worker PID (except on Windows to support graceful shutdown)
  let signaledCount = 0;
  if (process.platform !== 'win32') {
    for (const w of workers) {
      try {
        process.kill(w.pid, 'SIGINT');
        signaledCount++;
      } catch (err) {
        // Process might already be dead or access denied
      }
    }
  } else {
    signaledCount = workers.length;
  }

  return signaledCount;
}
