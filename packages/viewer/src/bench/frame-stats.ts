/** Samples of the benchmark page and their summaries: median and 95th percentile. */

export interface Summary {
  readonly median: number;
  readonly p95: number;
}

/** The q-quantile of `values` (0 ≤ q ≤ 1), the nearest-rank way: a value that was measured. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank] ?? Number.NaN;
}

export function summarise(values: readonly number[]): Summary {
  return { median: quantile(values, 0.5), p95: quantile(values, 0.95) };
}

/** What the page measures, sample by sample, while it measures. */
export class Samples {
  /** Milliseconds between the starts of two frames. */
  readonly frameIntervals: number[] = [];
  /** Milliseconds the main thread spent on a frame: the clock, requests and the engine's render call. */
  readonly frameWork: number[] = [];
  /** Milliseconds the worker spent on a snapshot, and on the run before it. */
  readonly snapshotInWorker: number[] = [];
  readonly runInWorker: number[] = [];
  /** Milliseconds the main thread spent uploading a snapshot to the graphics card. */
  readonly upload: number[] = [];
}
