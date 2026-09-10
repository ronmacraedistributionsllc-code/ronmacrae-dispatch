/**
 * Queue abstraction with two drivers:
 *  - memory: in-process (default for dev/preview; single process)
 *  - bullmq: Redis-backed (production)
 * The worker semantics are intentionally simple: named jobs with optional
 * delay and (for the scheduler) repeat interval.
 */
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import type { Logger } from "../lib/log.js";

export interface QueuedJob {
  id: string;
  name: string;
  payload: unknown;
}

export type JobHandler = (job: QueuedJob) => Promise<void> | void;

export interface QueueDriver {
  readonly kind: "memory" | "bullmq";
  enqueue(name: string, payload: unknown, opts?: { delayMs?: number }): Promise<string>;
  /** register a handler for a job name; multiple names per worker allowed */
  register(names: string[], handler: JobHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------- in-memory driver ----------------

interface MemoryEntry {
  id: string;
  name: string;
  payload: unknown;
  runAt: number;
}

export class MemoryQueue implements QueueDriver {
  readonly kind = "memory" as const;
  private queue: MemoryEntry[] = [];
  private handlers = new Map<string, JobHandler>();
  private timers = new Set<NodeJS.Timeout>();
  private running = false;
  private counter = 0;

  constructor(private readonly log: Logger) {}

  async enqueue(name: string, payload: unknown, opts?: { delayMs?: number }): Promise<string> {
    const id = `mem-${Date.now()}-${this.counter++}`;
    const entry: MemoryEntry = { id, name, payload, runAt: Date.now() + (opts?.delayMs ?? 0) };
    this.queue.push(entry);
    this.schedule();
    return id;
  }

  register(names: string[], handler: JobHandler): void {
    for (const name of names) this.handlers.set(name, handler);
  }

  async start(): Promise<void> {
    this.running = true;
  }

  private schedule(): void {
    if (!this.running) return;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const now = Date.now();
    const due = this.queue
      .filter((e) => e.runAt <= now + 50)
      .sort((a, b) => a.runAt - b.runAt);
    if (due.length === 0) {
      // wake up for the next delayed entry, if any
      const next = this.queue.length > 0 ? Math.min(...this.queue.map((e) => e.runAt)) : null;
      if (next != null) {
        const t = setTimeout(() => this.schedule(), Math.max(0, next - Date.now()));
        this.timers.add(t);
      }
      return;
    }
    // process due jobs one tick apart to avoid blocking the event loop
    for (const entry of due) {
      this.queue = this.queue.filter((e) => e.id !== entry.id);
      const handler = this.handlers.get(entry.name);
      if (!handler) {
        this.log.warn({ job: entry.name }, "no handler registered for job");
        continue;
      }
      const t = setTimeout(() => {
        this.timers.delete(t);
        void Promise.resolve(handler({ id: entry.id, name: entry.name, payload: entry.payload }))
          .catch((err) => this.log.error({ err: String(err), job: entry.name }, "job failed"))
          .finally(() => this.schedule());
      }, Math.max(0, entry.runAt - Date.now()));
      this.timers.add(t);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

// ---------------- bullmq driver ----------------

export class BullQueue implements QueueDriver {
  readonly kind = "bullmq" as const;
  private connection: Redis;
  private queue: Queue;
  private workers: Worker[] = [];
  private handler: JobHandler | null = null;
  private names: string[] = [];

  constructor(
    private readonly log: Logger,
    redisUrl: string,
    private readonly queueName = "rmd",
  ) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue(this.queueName, { connection: this.connection });
  }

  async enqueue(name: string, payload: unknown, opts?: { delayMs?: number }): Promise<string> {
    const job = await this.queue.add(name, { payload }, {
      delay: opts?.delayMs,
      removeOnComplete: 200,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
    });
    return job.id ?? "";
  }

  register(names: string[], handler: JobHandler): void {
    this.names = names;
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (!this.handler) return;
    const worker = new Worker(
      this.queueName,
      async (job: Job) => {
        if (!this.handler) return;
        const data = job.data as { payload: unknown };
        await this.handler({ id: job.id ?? "", name: job.name, payload: data.payload });
      },
      { connection: this.connection },
    );
    worker.on("failed", (job, err) => {
      this.log.error({ job: job?.name, err: String(err) }, "bull job failed");
    });
    this.workers.push(worker);
  }

  async stop(): Promise<void> {
    for (const w of this.workers) await w.close();
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }
}

export function createQueueDriver(
  log: Logger,
  kind: "memory" | "bullmq",
  redisUrl: string,
): QueueDriver {
  if (kind === "bullmq") return new BullQueue(log, redisUrl);
  return new MemoryQueue(log);
}
