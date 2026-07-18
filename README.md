# queuectl - CLI Background Job Queue

`queuectl` is a CLI-based background job queue system built with Node.js and TypeScript. It supports enqueuing jobs, running parallel workers, exponential backoff retries, and a Dead Letter Queue (DLQ) for failed tasks.

## 🎥 Video Demo
You can view a working demo of the CLI tool and test suite execution here: [Google Drive Video Demo](https://drive.google.com/file/d/1EaHInd42E5-0ml8gnIm3jxdW9LI5Ooao/view?usp=drive_link)

---

## 🚀 Setup & Installation

### Prerequisites
- Node.js (v20+)
- npm

### Installation
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the TypeScript codebase:
   ```bash
   npm run build
   ```
3. Link the command globally:
   ```bash
   npm link
   ```

---

## 💻 CLI Commands

### 1. Configuration
Set default max retries and exponential backoff base:
```bash
queuectl config set max-retries 3
queuectl config set backoff-base 2
```

### 2. Enqueueing Jobs
Enqueue jobs using CLI flags or a raw JSON string:
```bash
queuectl enqueue --id job1 --command "echo 'hello world'" --priority 5 --delay 2
queuectl enqueue '{"id":"job2","command":"sleep 3"}'
```

### 3. Running Workers
Start background worker processes:
```bash
queuectl worker start --count 3
queuectl worker stop
```

### 4. Monitoring & Listing
```bash
queuectl status
queuectl list --state pending
```

### 5. Dead Letter Queue (DLQ)
```bash
queuectl dlq list
queuectl dlq retry job_id
```

---

## 🧪 Testing

To run the integration tests:
```bash
npm test
```

---

## 🧠 Design & Architecture

- **JSON File DB**: Stores data in `.data/` (`jobs.json`, `workers.json`, `config.json`).
- **Process-Safe Lock**: Implements an atomic directory-lock mechanism (`.locks/db.lock`) using `fs.mkdirSync` to prevent race conditions during parallel processing.
- **Worker & Daemon**: Spawns detached processes using `child_process.spawn` to run workers in the background. Active workers write heartbeats to `workers.json`.
- **Graceful Shutdown**: When `worker stop` is triggered, the worker status is updated to `stopping` in the registry. Workers complete their active task before exiting.
- **Windows Support**: Since `SIGINT` terminates child processes unconditionally on Windows, graceful shutdown is managed by updating the worker status in the registry.
