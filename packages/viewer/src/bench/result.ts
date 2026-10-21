/** What the scene benchmark reports: on its page, and as `window.mozaikaBench` to the Playwright test. */
import type { Summary } from './frame-stats.js';

export interface BenchResult {
  readonly agents: number;
  /** The graphics card, as the browser names it. */
  readonly renderer: string;
  readonly userAgent: string;
  /** Size of the canvas in pixels, as drawn. */
  readonly canvas: readonly [number, number];
  readonly devicePixelRatio: number;
  /** Seconds measured. */
  readonly seconds: number;
  readonly framesPerSecond: number;
  /** Milliseconds between frames, and of the main thread's work in a frame. */
  readonly frameInterval: Summary;
  readonly frameWork: Summary;
  /** Milliseconds the worker spent on a snapshot, and on the run before it. */
  readonly snapshotInWorker: Summary;
  readonly runInWorker: Summary;
  /** Milliseconds the main thread spent uploading a snapshot to the graphics card. */
  readonly upload: Summary;
  readonly snapshotsPerSecond: number;
}

declare global {
  interface Window {
    /** Set by the benchmark page once it has measured. */
    mozaikaBench?: BenchResult;
  }
}
