export type JobState = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';

export interface Job {
  id: string;
  command: string;
  state: JobState;
  attempts: number;
  max_retries: number;
  backoff_base: number;
  run_at: number; // epoch timestamp in ms, 0 means run immediately
  created_at: string; // ISO string
  updated_at: string; // ISO string
  priority: number; // higher priority runs first (bonus)
  error_message?: string;
}

export interface WorkerRegistry {
  pid: number;
  status: 'active' | 'stopping';
  heartbeat: number; // epoch timestamp in ms
}

export interface SystemConfig {
  max_retries: number;
  backoff_base: number;
}
