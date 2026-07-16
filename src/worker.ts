import { exec } from 'child_process';
import { claimNextJob, registerWorker, updateWorkerHeartbeat, removeWorker, getWorkers, updateJobResult } from './store.js';

let isStopping = false;
let isProcessingJob = false;
const pid = process.pid;

console.log(`[Worker ${pid}] Process started and initializing registry.`);

// Register process
registerWorker(pid);

// Setup shutdown listeners
process.on('SIGINT', () => {
  console.log(`[Worker ${pid}] Received SIGINT signal.`);
  handleSignalShutdown();
});
process.on('SIGTERM', () => {
  console.log(`[Worker ${pid}] Received SIGTERM signal.`);
  handleSignalShutdown();
});
process.on('message', (msg) => {
  if (msg === 'stop') {
    console.log(`[Worker ${pid}] Received IPC stop command.`);
    isStopping = true;
  }
});

function handleSignalShutdown() {
  isStopping = true;
  if (!isProcessingJob) {
    console.log(`[Worker ${pid}] Not busy, exiting immediately.`);
    cleanupAndExit();
  } else {
    console.log(`[Worker ${pid}] Worker is busy executing a job. Shutdown deferred until completion.`);
  }
}

function cleanupAndExit() {
  try {
    console.log(`[Worker ${pid}] Removing registration from database and exiting.`);
    removeWorker(pid);
  } catch (err: any) {
    console.error(`[Worker ${pid}] Error removing registration: ${err.message}`);
  }
  process.exit(0);
}

function executeCommand(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      const code = error ? (error.code ?? 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mainLoop() {
  while (true) {
    try {
      // 1. Check database worker state registry for 'stopping'
      const workers = getWorkers();
      const myState = workers.find((w) => w.pid === pid);
      if (isStopping || (myState && myState.status === 'stopping')) {
        isStopping = true;
        if (!isProcessingJob) {
          console.log(`[Worker ${pid}] Stopping flag detected in database registry. Exiting.`);
          cleanupAndExit();
          return;
        }
      }

      // 2. Pulse heartbeat
      updateWorkerHeartbeat(pid, isStopping ? 'stopping' : 'active');

      // 3. Claim next job
      if (!isStopping) {
        const job = claimNextJob(pid);
        if (job) {
          isProcessingJob = true;
          console.log(`[Worker ${pid}] Claimed Job "${job.id}". Command: "${job.command}". Attempt: ${job.attempts}/${job.max_retries}`);
          
          const { code, stderr, stdout } = await executeCommand(job.command);
          
          isProcessingJob = false;
          
          if (code === 0) {
            console.log(`[Worker ${pid}] Job "${job.id}" completed successfully.`);
            updateJobResult(job.id, 'completed');
          } else {
            const errorMsg = stderr.trim() || `Exit code ${code}`;
            console.warn(`[Worker ${pid}] Job "${job.id}" failed: ${errorMsg}`);
            
            if (job.attempts > job.max_retries) {
              console.error(`[Worker ${pid}] Job "${job.id}" exhausted all retries. Moving to DLQ (dead).`);
              updateJobResult(job.id, 'dead', { error_message: errorMsg });
            } else {
              // Exponential backoff
              const delaySec = Math.pow(job.backoff_base, job.attempts);
              const runAt = Date.now() + (delaySec * 1000);
              console.log(`[Worker ${pid}] Rescheduling Job "${job.id}" in ${delaySec}s (attempts: ${job.attempts}/${job.max_retries}).`);
              updateJobResult(job.id, 'pending', {
                error_message: errorMsg,
                run_at: runAt
              });
            }
          }
          // Do not sleep, try to claim immediately
          continue;
        }
      }
    } catch (err: any) {
      console.error(`[Worker ${pid}] Exception in worker main loop: ${err.message}`);
    }

    // Sleep before polling again
    await sleep(500);
  }
}

// Start polling
mainLoop();
