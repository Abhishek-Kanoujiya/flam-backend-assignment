import fs from 'fs';
import path from 'path';
import { Job, JobState, WorkerRegistry, SystemConfig } from './types.js';
import { acquireLock, releaseLock } from './lock.js';

const DATA_DIR = path.resolve('./.data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const WORKERS_FILE = path.join(DATA_DIR, 'workers.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const LOCK_NAME = 'db';

// Ensure data directory and files exist
export function initStore(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(JOBS_FILE)) {
    fs.writeFileSync(JOBS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(WORKERS_FILE)) {
    fs.writeFileSync(WORKERS_FILE, JSON.stringify([]));
  }
  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultConfig: SystemConfig = { max_retries: 3, backoff_base: 2 };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig));
  }
}

// Internal locked execution helper
function runInTransaction<T>(action: () => T): T {
  initStore();
  const lockAcquired = acquireLock(LOCK_NAME, 5000);
  if (!lockAcquired) {
    throw new Error('Database transaction lock timeout');
  }
  try {
    return action();
  } finally {
    releaseLock(LOCK_NAME);
  }
}

// -------------------------------------------------------------
// PRIVATE UNLOCKED HELPERS (to avoid nested transaction deadlocks)
// -------------------------------------------------------------
function _getSystemConfig(): SystemConfig {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data) as SystemConfig;
  } catch {
    return { max_retries: 3, backoff_base: 2 };
  }
}

function _saveSystemConfig(config: SystemConfig): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function _getJobs(): Job[] {
  try {
    const data = fs.readFileSync(JOBS_FILE, 'utf8');
    return JSON.parse(data) as Job[];
  } catch {
    return [];
  }
}

function _saveJobs(jobs: Job[]): void {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function _getWorkers(): WorkerRegistry[] {
  try {
    const data = fs.readFileSync(WORKERS_FILE, 'utf8');
    return JSON.parse(data) as WorkerRegistry[];
  } catch {
    return [];
  }
}

function _saveWorkers(workers: WorkerRegistry[]): void {
  fs.writeFileSync(WORKERS_FILE, JSON.stringify(workers, null, 2));
}

// -------------------------------------------------------------
// PUBLIC TRANSACTION-SAFE APIS
// -------------------------------------------------------------
export function getSystemConfig(): SystemConfig {
  return runInTransaction(() => _getSystemConfig());
}

export function saveSystemConfig(config: SystemConfig): void {
  runInTransaction(() => _saveSystemConfig(config));
}

export function getJobs(): Job[] {
  return runInTransaction(() => _getJobs());
}

export function saveJobs(jobs: Job[]): void {
  runInTransaction(() => _saveJobs(jobs));
}

export function getWorkers(): WorkerRegistry[] {
  return runInTransaction(() => _getWorkers());
}

export function saveWorkers(workers: WorkerRegistry[]): void {
  runInTransaction(() => _saveWorkers(workers));
}

export function addJob(id: string, command: string, priority: number = 0, delaySec: number = 0): Job {
  return runInTransaction(() => {
    const config = _getSystemConfig();
    const jobs = _getJobs();
    if (jobs.some(j => j.id === id)) {
      throw new Error(`Job with ID "${id}" already exists`);
    }

    const nowStr = new Date().toISOString();
    const newJob: Job = {
      id,
      command,
      state: 'pending',
      attempts: 0,
      max_retries: config.max_retries,
      backoff_base: config.backoff_base,
      run_at: delaySec > 0 ? Date.now() + (delaySec * 1000) : 0,
      created_at: nowStr,
      updated_at: nowStr,
      priority
    };

    jobs.push(newJob);
    _saveJobs(jobs);
    return newJob;
  });
}

export function registerWorker(pid: number): void {
  runInTransaction(() => {
    const workers = _getWorkers();
    const existing = workers.find(w => w.pid === pid);
    if (existing) {
      existing.status = 'active';
      existing.heartbeat = Date.now();
    } else {
      workers.push({ pid, status: 'active', heartbeat: Date.now() });
    }
    _saveWorkers(workers);
  });
}

export function updateWorkerHeartbeat(pid: number, status?: 'active' | 'stopping'): void {
  runInTransaction(() => {
    const workers = _getWorkers();
    const worker = workers.find(w => w.pid === pid);
    if (worker) {
      worker.heartbeat = Date.now();
      if (status) {
        worker.status = status;
      }
      _saveWorkers(workers);
    }
  });
}

export function removeWorker(pid: number): void {
  runInTransaction(() => {
    const workers = _getWorkers().filter(w => w.pid !== pid);
    _saveWorkers(workers);
  });
}

export function claimNextJob(workerPid: number): Job | null {
  return runInTransaction(() => {
    const jobs = _getJobs();
    const now = Date.now();

    const eligibleJobs = jobs.filter(
      j => j.state === 'pending' && (j.run_at === 0 || j.run_at <= now)
    );

    if (eligibleJobs.length === 0) {
      return null;
    }

    eligibleJobs.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });

    const targetJob = eligibleJobs[0];
    const jobInList = jobs.find(j => j.id === targetJob.id)!;
    
    jobInList.state = 'processing';
    jobInList.attempts += 1;
    jobInList.updated_at = new Date().toISOString();

    _saveJobs(jobs);
    return jobInList;
  });
}

export function updateJobResult(
  id: string,
  state: JobState,
  options?: { error_message?: string; run_at?: number; attempts?: number }
): void {
  runInTransaction(() => {
    const jobs = _getJobs();
    const job = jobs.find(j => j.id === id);
    if (job) {
      job.state = state;
      job.updated_at = new Date().toISOString();
      if (options?.error_message !== undefined) {
        job.error_message = options.error_message;
      }
      if (options?.run_at !== undefined) {
        job.run_at = options.run_at;
      }
      if (options?.attempts !== undefined) {
        job.attempts = options.attempts;
      }
      _saveJobs(jobs);
    }
  });
}
