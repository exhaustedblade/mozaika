/**
 * The clock of the frames (docs/ARCHITECTURE.md, "Показ"): the model time a
 * frame shows. It runs at a chosen number of model units per second of real
 * time, and waits for the kernel: a frame is drawn from the latest snapshot,
 * with the agents led along their segments, and a frame far ahead of it would
 * leave arrived agents standing until the kernel gives them their next walks.
 */

export interface ViewClockOptions {
  /** Units of model time per second of real time. */
  readonly timeScale: number;
  /** How far frames may run ahead of the latest snapshot, in seconds of real time at the current scale. */
  readonly maxLead: number;
  /** Most seconds of real time one frame moves the clock by: a hidden tab gets no frames, and must not jump. */
  readonly maxStep: number;
}

export class ViewClock {
  /** Units of model time per second of real time; the panel changes it. */
  timeScale: number;
  /** While paused, the clock stands still. */
  paused = false;
  readonly #maxLead: number;
  readonly #maxStep: number;
  #time: number;

  constructor(options: ViewClockOptions, start = 0) {
    this.timeScale = options.timeScale;
    this.#maxLead = options.maxLead;
    this.#maxStep = options.maxStep;
    this.#time = start;
  }

  /** The model time of the frame being drawn. */
  get time(): number {
    return this.#time;
  }

  /**
   * Moves the clock on by `seconds` of real time since the last frame and
   * returns the model time of the new frame. `latest` is the time of the
   * latest snapshot, undefined before the first: the clock does not go
   * further than the lead past it.
   */
  tick(seconds: number, latest: number | undefined): number {
    if (this.paused) return this.#time;
    const wanted = this.#time + Math.min(seconds, this.#maxStep) * this.timeScale;
    const limit = latest === undefined ? this.#time : latest + this.#maxLead * this.timeScale;
    this.#time = Math.max(this.#time, Math.min(wanted, limit));
    return this.#time;
  }

  /** Starts again from model time `start`, e.g. for a model built anew. */
  reset(start: number): void {
    this.#time = start;
  }
}
