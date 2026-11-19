/**
 * Single-worker sequential queue for CPU/RAM-intensive FFmpeg and AI tasks.
 * Prevents concurrent renders from exhausting an 8 GB RAM host.
 */
class SequentialTaskQueue {
  private active = 0;
  private pending: Array<() => void> = [];

  getStats(): { active: number; queued: number } {
    return {
      active: this.active,
      queued: this.pending.length,
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= 1) {
      await new Promise<void>((resolve) => {
        this.pending.push(resolve);
      });
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      const next = this.pending.shift();
      if (next) next();
    }
  }
}

export const processingQueue = new SequentialTaskQueue();
