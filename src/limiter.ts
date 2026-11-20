import { QueueFullError, RendererClosedError } from './errors.ts';

/**
 * A first-in, first-out limit on how many things run at once, with a cap on how many may wait. A place that frees up
 * goes straight to the one that has waited longest.
 */
export class Limiter {
  #running = 0;
  #waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  readonly #concurrency: number;
  readonly #queueLimit: number;

  constructor(concurrency: number, queueLimit: number) {
    this.#concurrency = concurrency;
    this.#queueLimit = queueLimit;
  }

  /** Resolves when a place is yours. Rejects with a QueueFullError at once when the queue is full. */
  acquire(): Promise<void> {
    if (this.#running < this.#concurrency) {
      this.#running += 1;
      return Promise.resolve();
    }
    if (this.#waiting.length >= this.#queueLimit) return Promise.reject(new QueueFullError(this.#queueLimit));
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }

  release(): void {
    const next = this.#waiting.shift();
    if (next) next.resolve();
    else this.#running -= 1;
  }

  /** Rejects everyone who is waiting. */
  closeQueue(): void {
    for (const { reject } of this.#waiting.splice(0)) reject(new RendererClosedError());
  }
}
