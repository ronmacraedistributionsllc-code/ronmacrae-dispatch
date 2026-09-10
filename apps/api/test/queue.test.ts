import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { MemoryQueue } from "../src/queue/index.js";
import { createLogger } from "../src/lib/log.js";

const silent = createLogger("silent", "test");

describe("MemoryQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs registered handlers for due jobs", async () => {
    const q = new MemoryQueue(silent);
    await q.start();
    const calls: string[] = [];
    q.register(["notify.dispatch"], (job) => {
      calls.push(`${job.name}:${(job.payload as { id: string }).id}`);
    });
    await q.enqueue("notify.dispatch", { id: "n1" });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual(["notify.dispatch:n1"]);
    await q.stop();
  });

  it("defers jobs with a delay", async () => {
    const q = new MemoryQueue(silent);
    await q.start();
    const calls: number[] = [];
    q.register(["later"], () => {
      calls.push(1);
    });
    await q.enqueue("later", {}, { delayMs: 5_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(0);
    expect(q.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    await q.stop();
  });

  it("warns instead of crashing for unregistered job names", async () => {
    const q = new MemoryQueue(silent);
    await q.start();
    await q.enqueue("unknown", {});
    await vi.advanceTimersByTimeAsync(100);
    await q.stop(); // must not throw
  });
});
