/**
 * The frames of a page with a live model (docs/ARCHITECTURE.md, "Показ"):
 * each frame moves the clock on, asks the kernel for a snapshot when one is
 * due, and draws the scene with the agents led along their segments from the
 * snapshot uploaded last. The kernel runs in its Web Worker meanwhile, so a
 * slow model slows the clock, not the frames.
 */
import type { RanReply, SnapshotReply } from '@mozaika/kernel/worker';

import type { KernelClient, Timed } from './kernel-client.js';
import type { AgentLayer } from './scene/agent-layer.js';
import type { Stage } from './scene/stage.js';
import { SnapshotFeed } from './snapshot-feed.js';
import type { ViewClock } from './view-clock.js';

/** What a frame did, for a page that shows or measures it. */
export interface Frame {
  /** Real time of the frame, milliseconds, as requestAnimationFrame gives it. */
  readonly now: number;
  /** Milliseconds since the previous frame; 0 for the first. */
  readonly interval: number;
  /** Model time the frame shows. */
  readonly time: number;
  /** Milliseconds the main thread spent on the frame: the clock, the requests and the engine's render call. */
  readonly work: number;
}

export interface LiveViewOptions {
  readonly stage: Stage;
  /** The agents of the model's first population. */
  readonly agents: AgentLayer;
  readonly client: KernelClient;
  readonly clock: ViewClock;
  /** Fewest milliseconds between snapshots. */
  readonly snapshotInterval: number;
  /** A snapshot has been uploaded, `upload` milliseconds it took; `ran` brings the model's records. */
  readonly onSnapshot?: (snapshot: Timed<SnapshotReply>, ran: Timed<RanReply>, upload: number) => void;
  readonly onFrame?: (frame: Frame) => void;
  readonly onError: (error: unknown) => void;
}

export class LiveView {
  readonly #options: LiveViewOptions;
  readonly #feed: SnapshotFeed;
  /** Model time of the snapshot uploaded last; the agents are drawn from it. */
  #snapshotTime: number | undefined;
  #last: number | undefined;
  #running = false;
  #frameRequest = 0;

  constructor(options: LiveViewOptions) {
    this.#options = options;
    this.#feed = new SnapshotFeed(options.client, {
      minInterval: options.snapshotInterval,
      onSnapshot: (snapshot, ran) => {
        // A view stopped while its snapshot was on the way, e.g. for a model built anew, draws nothing more.
        if (!this.#running) return;
        const population = snapshot.populations[0];
        const started = performance.now();
        if (population !== undefined) options.agents.upload(population);
        this.#snapshotTime = snapshot.time;
        options.onSnapshot?.(snapshot, ran, performance.now() - started);
      },
      onError: (error) => {
        if (this.#running) options.onError(error);
      },
    });
  }

  start(): void {
    this.#running = true;
    this.#frameRequest = requestAnimationFrame(this.#frame);
  }

  stop(): void {
    this.#running = false;
    cancelAnimationFrame(this.#frameRequest);
  }

  readonly #frame = (now: number): void => {
    if (!this.#running) return;
    const started = performance.now();
    const { stage, agents, clock } = this.#options;
    const interval = this.#last === undefined ? 0 : now - this.#last;
    this.#last = now;
    const time = clock.tick(interval / 1000, this.#feed.latest);
    this.#feed.frame(time, now);
    agents.since = this.#snapshotTime === undefined ? 0 : time - this.#snapshotTime;
    stage.render();
    this.#options.onFrame?.({ now, interval, time, work: performance.now() - started });
    this.#frameRequest = requestAnimationFrame(this.#frame);
  };
}
