#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import Table from 'cli-table3';
import { addJob, getJobs, getWorkers, getSystemConfig, saveSystemConfig, updateJobResult } from './store.js';
import { startWorkers, stopWorkers, cleanupDeadWorkers } from './daemon.js';

const program = new Command();

program
  .name('queuectl')
  .description('QueueCTL - CLI Background Job Queue')
  .version('1.0.0');

// ENQUEUE command
program
  .command('enqueue [jobJson]')
  .description('Add a new job to the queue')
  .option('-i, --id <id>', 'Unique job ID')
  .option('-c, --command <command>', 'Shell command to execute')
  .option('-p, --priority <priority>', 'Job priority (higher runs first)', '0')
  .option('-d, --delay <delay>', 'Execution delay in seconds', '0')
  .action((jobJson, options) => {
    let id = options.id;
    let command = options.command;
    let priority = parseInt(options.priority, 10);
    let delay = parseInt(options.delay, 10);

    if (jobJson) {
      try {
        const parsed = JSON.parse(jobJson);
        id = id || parsed.id;
        command = command || parsed.command;
        if (parsed.priority !== undefined) priority = parsed.priority;
        if (parsed.delay !== undefined) delay = parsed.delay;
      } catch (err) {
        console.error(chalk.red('Error: Invalid JSON string provided.'));
        process.exit(1);
      }
    }

    if (!id || !command) {
      console.error(chalk.red('Error: Both Job ID and Command are required.'));
      console.log('Usage: queuectl enqueue \'{"id":"job1","command":"echo hello"}\'');
      console.log('   or: queuectl enqueue --id job1 --command "echo hello"');
      process.exit(1);
    }

    try {
      const job = addJob(id, command, priority, delay);
      const runAtStr = job.run_at === 0 ? 'immediately' : `at ${new Date(job.run_at).toLocaleString()}`;
      console.log(chalk.green(`✓ Job "${job.id}" enqueued successfully (Priority: ${job.priority}, Scheduled: ${runAtStr}).`));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// WORKER command group
const workerCmd = program
  .command('worker')
  .description('Manage background workers');

workerCmd
  .command('start')
  .description('Start one or more workers in the background')
  .option('--count <count>', 'Number of worker processes to spawn', '1')
  .action((options) => {
    const count = parseInt(options.count, 10);
    if (isNaN(count) || count < 1) {
      console.error(chalk.red('Error: Count must be a positive integer.'));
      process.exit(1);
    }

    try {
      startWorkers(count);
      console.log(chalk.green(`✓ Spawned ${count} background worker(s).`));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

workerCmd
  .command('stop')
  .description('Stop running workers gracefully')
  .action(() => {
    try {
      const stoppedCount = stopWorkers();
      if (stoppedCount === 0) {
        console.log(chalk.yellow('No active workers found to stop.'));
      } else {
        console.log(chalk.green(`✓ Graceful shutdown signal sent to ${stoppedCount} worker process(es).`));
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// STATUS command
program
  .command('status')
  .description('Show summary of all job states & active workers')
  .action(() => {
    try {
      cleanupDeadWorkers();
      const jobs = getJobs();
      const workers = getWorkers();

      const counts = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        dead: 0
      };

      for (const j of jobs) {
        counts[j.state] = (counts[j.state] || 0) + 1;
      }

      console.log(chalk.bold.cyan('\n=== QueueCTL System Status ==='));
      console.log(`${chalk.bold('Active Workers:')} ${workers.length}`);
      if (workers.length > 0) {
        workers.forEach((w) => {
          console.log(`  - PID ${chalk.green(w.pid)} [Status: ${chalk.yellow(w.status)}]`);
        });
      } else {
        console.log(chalk.dim('  No active worker processes running.'));
      }

      console.log(chalk.bold('\nJob Summary:'));
      console.log(`  Pending:     ${chalk.blue(counts.pending)}`);
      console.log(`  Processing:  ${chalk.yellow(counts.processing)}`);
      console.log(`  Completed:   ${chalk.green(counts.completed)}`);
      console.log(`  Failed:      ${chalk.magenta(counts.failed)}`);
      console.log(`  Dead (DLQ):  ${chalk.red(counts.dead)}`);
      console.log();
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// LIST command
program
  .command('list')
  .description('List jobs by state')
  .option('--state <state>', 'Filter by state (pending, processing, completed, failed, dead)')
  .action((options) => {
    try {
      const jobs = getJobs();
      const filterState = options.state?.toLowerCase();

      const filtered = filterState
        ? jobs.filter((j) => j.state === filterState)
        : jobs;

      if (filtered.length === 0) {
        console.log(chalk.yellow('No jobs found.'));
        return;
      }

      const table = new Table({
        head: ['Job ID', 'Command', 'State', 'Attempts', 'Priority', 'Run At', 'Created At'],
        style: { head: ['cyan'] }
      }) as any;

      for (const j of filtered) {
        let stateStr = j.state as string;
        if (j.state === 'completed') stateStr = chalk.green(j.state);
        else if (j.state === 'processing') stateStr = chalk.yellow(j.state);
        else if (j.state === 'dead') stateStr = chalk.red(j.state);
        else if (j.state === 'failed') stateStr = chalk.magenta(j.state);
        else stateStr = chalk.blue(j.state);

        const runAtStr = j.run_at === 0 ? 'Immediately' : new Date(j.run_at).toLocaleString();
        
        table.push([
          j.id,
          j.command,
          stateStr,
          `${j.attempts}/${j.max_retries}`,
          j.priority.toString(),
          runAtStr,
          new Date(j.created_at).toLocaleString()
        ]);
      }

      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// DLQ command group
const dlqCmd = program
  .command('dlq')
  .description('Manage Dead Letter Queue (DLQ) jobs');

dlqCmd
  .command('list')
  .description('View dead letter queue jobs')
  .action(() => {
    try {
      const deadJobs = getJobs().filter((j) => j.state === 'dead');
      if (deadJobs.length === 0) {
        console.log(chalk.green('✓ Dead Letter Queue (DLQ) is empty!'));
        return;
      }

      const table = new Table({
        head: ['Job ID', 'Command', 'Attempts', 'Error Message', 'Failed At'],
        style: { head: ['red'] }
      }) as any;

      for (const j of deadJobs) {
        table.push([
          j.id,
          j.command,
          `${j.attempts}/${j.max_retries}`,
          j.error_message || 'N/A',
          new Date(j.updated_at).toLocaleString()
        ]);
      }

      console.log(table.toString());
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

dlqCmd
  .command('retry <jobId>')
  .description('Retry a job in the Dead Letter Queue')
  .action((jobId) => {
    try {
      const jobs = getJobs();
      const job = jobs.find((j) => j.id === jobId);

      if (!job) {
        console.error(chalk.red(`Error: Job "${jobId}" not found.`));
        process.exit(1);
      }

      if (job.state !== 'dead') {
        console.error(chalk.red(`Error: Job "${jobId}" is not dead (State: ${job.state}). Only dead jobs can be retried.`));
        process.exit(1);
      }

      updateJobResult(jobId, 'pending', {
        attempts: 0,
        error_message: undefined,
        run_at: 0
      });

      console.log(chalk.green(`✓ Job "${jobId}" has been reset to pending status and returned to queue.`));
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

// CONFIG command group
const configCmd = program
  .command('config')
  .description('Manage system configuration');

configCmd
  .command('set <key> <value>')
  .description('Set a configuration parameter (max-retries, backoff-base)')
  .action((key, value) => {
    try {
      const config = getSystemConfig();
      const lowerKey = key.toLowerCase();

      if (lowerKey === 'max-retries' || lowerKey === 'max_retries') {
        const val = parseInt(value, 10);
        if (isNaN(val) || val < 0) {
          console.error(chalk.red('Error: max-retries must be a non-negative integer.'));
          process.exit(1);
        }
        config.max_retries = val;
        saveSystemConfig(config);
        console.log(chalk.green(`✓ max-retries set to ${val}.`));
      } else if (lowerKey === 'backoff-base' || lowerKey === 'backoff_base') {
        const val = parseFloat(value);
        if (isNaN(val) || val <= 1) {
          console.error(chalk.red('Error: backoff-base must be a number greater than 1.'));
          process.exit(1);
        }
        config.backoff_base = val;
        saveSystemConfig(config);
        console.log(chalk.green(`✓ backoff-base set to ${val}.`));
      } else {
        console.error(chalk.red(`Error: Unknown config key "${key}". Available keys: max-retries, backoff-base`));
        process.exit(1);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

configCmd
  .command('get [key]')
  .description('Get all or specific configuration parameters')
  .action((key) => {
    try {
      const config = getSystemConfig();
      if (key) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'max-retries' || lowerKey === 'max_retries') {
          console.log(config.max_retries);
        } else if (lowerKey === 'backoff-base' || lowerKey === 'backoff_base') {
          console.log(config.backoff_base);
        } else {
          console.error(chalk.red(`Error: Unknown config key "${key}".`));
          process.exit(1);
        }
      } else {
        console.log(chalk.cyan('System Configuration:'));
        console.log(`  max-retries:  ${config.max_retries}`);
        console.log(`  backoff-base: ${config.backoff_base}`);
      }
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  });

program.parse(process.argv);
