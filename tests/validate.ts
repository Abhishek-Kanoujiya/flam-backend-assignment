import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { addJob, getJobs, getWorkers, getSystemConfig, saveSystemConfig, updateJobResult } from '../src/store.js';
import { startWorkers, stopWorkers, cleanupDeadWorkers } from '../src/daemon.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to reset databases before each scenario
function resetDatabase() {
  const DATA_DIR = path.resolve('./.data');
  const LOCKS_DIR = path.resolve('./.locks');

  // Remove files
  try {
    fs.writeFileSync(path.join(DATA_DIR, 'jobs.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(DATA_DIR, 'workers.json'), JSON.stringify([]));
    fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({ max_retries: 3, backoff_base: 2 }));
  } catch (err) {}

  // Remove lock directories
  try {
    if (fs.existsSync(LOCKS_DIR)) {
      const files = fs.readdirSync(LOCKS_DIR);
      for (const file of files) {
        fs.rmdirSync(path.join(LOCKS_DIR, file));
      }
    }
  } catch (err) {}
}

// Poll database for job state to handle slow process boot on Windows
async function waitForJobState(jobId: string, targetState: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const jobs = getJobs();
      const job = jobs.find(j => j.id === jobId);
      console.log(`[Test Poll] Job "${jobId}" state is "${job?.state}" (target: "${targetState}", elapsed: ${Date.now() - start}ms)`);
      if (job && job.state === targetState) {
        return true;
      }
    } catch (err) {
      // Ignore transient database locking errors during poll
    }
    await sleep(200); // Poll every 200ms
  }
  return false;
}

async function runTests() {
  console.log(chalk.bold.blue('\n=================================================='));
  console.log(chalk.bold.blue('        QUEUECTL INTEGRATION VALIDATION SUITE      '));
  console.log(chalk.bold.blue('==================================================\n'));

  resetDatabase();

  let passed = 0;
  let failed = 0;

  async function assert(name: string, condition: () => Promise<boolean> | boolean) {
    try {
      const result = await condition();
      if (result) {
        console.log(chalk.green(`✓ PASS: ${name}`));
        passed++;
      } else {
        console.log(chalk.red(`✗ FAIL: ${name}`));
        failed++;
      }
    } catch (err: any) {
      console.log(chalk.red(`✗ FAIL: ${name} (Error: ${err.message})`));
      failed++;
    }
  }

  // -----------------------------------------------------------------
  // SCENARIO 1: Basic execution completes successfully
  // -----------------------------------------------------------------
  await assert('Basic Job Completion', async () => {
    resetDatabase();
    
    const jobId = 'basic-job';
    addJob(jobId, 'node -e "console.log(\'Hello World\')"');

    startWorkers(1);
    
    // Poll for completed status with generous timeout
    const completed = await waitForJobState(jobId, 'completed', 10000);

    stopWorkers();
    await sleep(1500);

    const jobs = getJobs();
    const job = jobs.find(j => j.id === jobId)!;

    return completed && job.attempts === 1;
  });

  // -----------------------------------------------------------------
  // SCENARIO 2: Failed job retries with backoff and moves to DLQ
  // -----------------------------------------------------------------
  await assert('Exponential Backoff and DLQ Migration', async () => {
    resetDatabase();
    // Use lower backoff base for faster test execution: 1.5
    saveSystemConfig({ max_retries: 2, backoff_base: 1.5 });

    const jobId = 'failing-job';
    addJob(jobId, 'node -e "process.exit(1)"');

    startWorkers(1);

    // Initial run (attempt 1) -> fails, backoff 1.5^1 = 1.5s
    // Retry 1 (attempt 2) -> fails, backoff 1.5^2 = 2.25s
    // Retry 2 (attempt 3) -> exceeds max_retries (2) -> dead
    // Total delay is around 3.75s + execution overhead. Poll with 25s timeout.
    const reachedDead = await waitForJobState(jobId, 'dead', 25000);

    stopWorkers();
    await sleep(1500);

    const jobs = getJobs();
    const job = jobs.find(j => j.id === jobId)!;

    return reachedDead && job.attempts === 3;
  });

  // -----------------------------------------------------------------
  // SCENARIO 3: Concurrency prevention: Multiple workers, no overlaps
  // -----------------------------------------------------------------
  await assert('Multi-Worker Concurrency (No overlaps)', async () => {
    resetDatabase();

    const jobCount = 10;
    const ids: string[] = [];

    // Enqueue 10 jobs
    for (let i = 0; i < jobCount; i++) {
      const id = `concurrent-job-${i}`;
      ids.push(id);
      addJob(id, 'node -e "setTimeout(() => {}, 200)"');
    }

    startWorkers(3);
    
    // Poll until all completed with generous 25s timeout to avoid Windows VM slowness
    let allCompleted = false;
    const start = Date.now();
    while (Date.now() - start < 25000) {
      try {
        const jobs = getJobs();
        if (jobs.every(j => j.state === 'completed')) {
          allCompleted = true;
          break;
        }
      } catch (e) {}
      await sleep(300);
    }

    stopWorkers();
    await sleep(1500);

    const jobs = getJobs();
    const noDuplicates = jobs.every(j => j.attempts === 1);

    return allCompleted && noDuplicates;
  });

  // -----------------------------------------------------------------
  // SCENARIO 4: Invalid commands fail gracefully
  // -----------------------------------------------------------------
  await assert('Invalid Command Handling', async () => {
    resetDatabase();

    const jobId = 'invalid-cmd-job';
    addJob(jobId, 'some_nonexistent_command_12345');

    startWorkers(1);
    
    // Poll until it has attempted and set back to pending (for backoff) or dead
    let failedGracefully = false;
    const start = Date.now();
    while (Date.now() - start < 10000) {
      try {
        const jobs = getJobs();
        const job = jobs.find(j => j.id === jobId);
        if (job && job.attempts > 0 && (job.state === 'pending' || job.state === 'dead')) {
          failedGracefully = true;
          break;
        }
      } catch (e) {}
      await sleep(200);
    }

    stopWorkers();
    await sleep(1500);

    return failedGracefully;
  });

  // -----------------------------------------------------------------
  // SCENARIO 5: Graceful Shutdown
  // -----------------------------------------------------------------
  await assert('Graceful Worker Shutdown (Finish job before exit)', async () => {
    resetDatabase();

    const jobId = 'long-job';
    addJob(jobId, 'node -e "setTimeout(() => {}, 2000)"');

    startWorkers(1);
    
    // Wait for the worker to pick up the job and mark it as processing
    const started = await waitForJobState(jobId, 'processing', 6000);
    if (!started) return false;

    // Trigger stop immediately
    stopWorkers();

    // Check that the worker status is updated to 'stopping'
    const workers = getWorkers();
    const workerStillActive = workers.length > 0 && workers[0].status === 'stopping';

    // Poll until the job is completed (with generous 12s timeout)
    const completed = await waitForJobState(jobId, 'completed', 12000);

    // Poll until the worker exited and cleared registry
    let workerExited = false;
    const start = Date.now();
    while (Date.now() - start < 5000) {
      if (getWorkers().length === 0) {
        workerExited = true;
        break;
      }
      await sleep(200);
    }

    return workerStillActive && completed && workerExited;
  });

  console.log(chalk.bold.blue('\n=================================================='));
  console.log(chalk.bold.blue('                  TEST RESULTS                    '));
  console.log(chalk.bold.blue('=================================================='));
  console.log(`Passed: ${chalk.green(passed)} / ${passed + failed}`);
  if (failed > 0) {
    console.log(`Failed: ${chalk.red(failed)}`);
    process.exit(1);
  } else {
    console.log(chalk.bold.green('All tests passed successfully! ✓\n'));
    process.exit(0);
  }
}

runTests();
