/**
 * Brings snapshots from the kernel in its Web Worker to the frames
 * (docs/ARCHITECTURE.md, "Показ"). On a frame it asks the kernel to run to
 * the frame's model time and for a snapshot, one pair at a time and not more
 * often than a given interval; when the snapshot comes, it hands it over —
 * the scene uploads it to the graphics card — and gives its buffers back to
 * the kernel at once, so the kernel's double buffering never waits for frames.
 */
import type { RanReply, SnapshotReply } from '@mozaika/kernel/worker';

import type { KernelClient, Timed } from './kernel-client.js';

/** How often to ask for snapshots, and what to do with them and with failures. */
export interface SnapshotFeedOptions {
  /** Fewest milliseconds between two requests for a snapshot. */
  readonly minInterval: number;
  /**
   * Takes a snapshot in, with the reply of the run before it (its records,
   * its time in the worker). The buffers go back to the kernel right after
   * this returns: whatever must outlive it is copied, e.g. to the graphics card.
   */
  readonly onSnapshot: (snapshot: Timed<SnapshotReply>, ran: Timed<RanReply>) => void;
  /** A request, or onSnapshot, failed; the feed asks for nothing more. */
  readonly onError: (error: unknown) => void;
}

/** Asks the kernel for snapshots as frames need them; see the module comment. */
export class SnapshotFeed {
  readonly #client: KernelClient;
  readonly #options: SnapshotFeedOptions;
  /** Real time (milliseconds) the last pair of requests was sent. */
  #askedAt = -Infinity;
  #onItsWay = false;
  #failed = false;
  #latest: number | undefined;

  constructor(client: KernelClient, options: SnapshotFeedOptions) {
    this.#client = client;
    this.#options = options;
  }

  /** Model time of the latest snapshot taken in; undefined before the first. */
  get latest(): number | undefined {
    return this.#latest;
  }

  /**
   * Called on every frame with the frame's model time and the real time in
   * milliseconds: asks for the next snapshot if it is due. A frame at the
   * time of the latest snapshot, e.g. while paused, needs none.
   */
  frame(until: number, now: number): void {
    if (this.#onItsWay || this.#failed || until === this.#latest) return;
    if (now - this.#askedAt < this.#options.minInterval) return;
    this.#onItsWay = true;
    this.#askedAt = now;
    // Both requests at once: the worker answers them in order, so the snapshot is taken at `until`.
    Promise.all([this.#client.run(until), this.#client.snapshot()])
      .then(([ran, snapshot]) => {
        this.#latest = snapshot.time;
        try {
          this.#options.onSnapshot(snapshot, ran);
        } finally {
          this.#release(snapshot);
        }
        this.#onItsWay = false;
      })
      .catch((error: unknown) => {
        this.#fail(error);
      });
  }

  #release(snapshot: Timed<SnapshotReply>): void {
    this.#client.release(snapshot).catch((error: unknown) => {
      this.#fail(error);
    });
  }

  #fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#options.onError(error);
  }
}
