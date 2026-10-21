/**
 * The 2D check of movement on the preview page (Ф0-6а): the walkway model
 * runs in a Web Worker, the page asks for snapshots and draws the people on
 * a canvas. Model time runs at a chosen number of units per second; each
 * frame draws the latest snapshot at the frame's model time, leading the
 * agents along their segments between snapshots (П-32).
 */
import type { SnapshotReply } from '@mozaika/kernel/worker';

import type { Messages } from './i18n.js';
import { KernelClient } from './kernel-client.js';
import { MotionCanvas, STATE_COLOURS } from './motion-view.js';
import { HALL, WALKWAY_DEFAULTS, type WalkwayParameters } from './walkway.js';

/** Units of model time per second of real time at the start. */
const TIME_SCALE = 4;
const SEED = 1;

/** A slider of the page and the parameter or setting it changes. */
interface Slider {
  readonly key: 'arrivals' | 'speed' | 'timeScale';
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
}

const DEFAULTS = WALKWAY_DEFAULTS;
const SLIDERS: readonly Slider[] = [
  { key: 'arrivals', min: 1, max: 200, step: 1, value: DEFAULTS.arrivalsPerUnit },
  { key: 'speed', min: 1, max: 30, step: 1, value: DEFAULTS.speed },
  { key: 'timeScale', min: 0.5, max: 20, step: 0.5, value: TIME_SCALE },
];

/** Which model parameter a slider sets; the time scale is the page's own. */
const PARAMETERS: Readonly<Partial<Record<Slider['key'], keyof WalkwayParameters>>> = {
  arrivals: 'arrivalsPerUnit',
  speed: 'speed',
};

export class MotionCheck {
  /** The section of the page; the page puts it in place and translates it. */
  readonly element: HTMLElement;
  readonly #canvas: MotionCanvas;
  readonly #texts = new Map<string, HTMLElement>();
  readonly #figures: { time: HTMLElement; people: HTMLElement; snapshots: HTMLElement; frames: HTMLElement };
  readonly #error: HTMLElement;
  readonly #pauseButton: HTMLButtonElement;
  #messages: Messages;
  #worker: Worker | undefined;
  #client: KernelClient | undefined;
  /** Model time of the frame being drawn. */
  #time = 0;
  #timeScale = TIME_SCALE;
  #paused = false;
  /** The snapshot being drawn; given back to the kernel when the next one comes. */
  #current: SnapshotReply | undefined;
  /** True while a request is on its way: the next snapshot is asked for once it is answered. */
  #waiting = false;
  #lastFrame: number | undefined;
  #counted = { since: 0, frames: 0, snapshots: 0 };
  #stopped = false;

  constructor(messages: Messages) {
    this.#messages = messages;
    this.element = document.createElement('section');
    this.element.className = 'motion';
    const canvas = document.createElement('canvas');
    canvas.className = 'motion-canvas';
    this.#canvas = new MotionCanvas(canvas, HALL);
    this.#figures = { time: figure(), people: figure(), snapshots: figure(), frames: figure() };
    this.#error = document.createElement('p');
    this.#error.className = 'motion-error';
    this.#pauseButton = document.createElement('button');
    this.element.append(
      this.#text('h2', 'motionTitle'),
      this.#text('p', 'motionAbout'),
      canvas,
      this.#legend(),
      this.#figuresList(),
      this.#controls(),
      this.#error,
    );
    this.translate(messages);
    this.#start();
    requestAnimationFrame(this.#frame);
  }

  /** Shows the texts in another language. */
  translate(messages: Messages): void {
    this.#messages = messages;
    for (const [key, node] of this.#texts) node.textContent = messages[key as keyof Messages];
    this.#pauseButton.textContent = this.#paused ? messages.resume : messages.pause;
  }

  /** Starts the model afresh in a new worker. */
  #start(): void {
    this.#worker?.terminate();
    this.#worker = new Worker(new URL('./kernel-worker.ts', import.meta.url), { type: 'module' });
    this.#client = new KernelClient(this.#worker);
    this.#time = 0;
    this.#current = undefined;
    this.#waiting = true;
    this.#error.textContent = '';
    const parameters: WalkwayParameters = { ...DEFAULTS };
    for (const slider of SLIDERS) {
      const name = PARAMETERS[slider.key];
      const input = this.element.querySelector<HTMLInputElement>(`input[name="${slider.key}"]`);
      if (name !== undefined && input !== null) parameters[name] = Number(input.value);
    }
    this.#client.build('walkway', SEED, parameters).then(
      () => {
        this.#waiting = false;
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  /** One frame: model time moves on, a new snapshot is asked for if none is on its way, and the latest is drawn. */
  readonly #frame = (now: number): void => {
    if (this.#stopped) return;
    const elapsed = this.#lastFrame === undefined ? 0 : (now - this.#lastFrame) / 1000;
    this.#lastFrame = now;
    // A hidden tab gets no frames; don't let model time jump when it comes back.
    if (!this.#paused) this.#time += Math.min(elapsed, 0.25) * this.#timeScale;
    if (!this.#waiting) this.#askForSnapshot(this.#time);
    const people = this.#current?.populations[0];
    this.#canvas.draw(people, this.#time);
    this.#count(now, people?.size ?? 0);
    requestAnimationFrame(this.#frame);
  };

  /** Runs the model to `until` and takes a snapshot; the snapshot drawn so far goes back to the kernel. */
  #askForSnapshot(until: number): void {
    const client = this.#client;
    if (client === undefined) return;
    this.#waiting = true;
    // Both requests at once: the worker answers them in order.
    Promise.all([client.run(until), client.snapshot()]).then(
      ([, snapshot]) => {
        const previous = this.#current;
        this.#current = snapshot;
        this.#waiting = false;
        this.#counted.snapshots++;
        if (previous === undefined) return;
        client.release(previous).catch((error: unknown) => {
          this.#fail(error);
        });
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  #count(now: number, people: number): void {
    const counted = this.#counted;
    counted.frames++;
    const seconds = (now - counted.since) / 1000;
    if (seconds < 0.5) return;
    const number = new Intl.NumberFormat(this.#messages.numberLocale, { maximumFractionDigits: 1 });
    this.#figures.time.textContent = number.format(this.#time);
    this.#figures.people.textContent = number.format(people);
    this.#figures.snapshots.textContent = number.format(counted.snapshots / seconds);
    this.#figures.frames.textContent = number.format(counted.frames / seconds);
    this.#counted = { since: now, frames: 0, snapshots: 0 };
  }

  #fail(error: unknown): void {
    this.#stopped = true;
    this.#error.textContent = `${this.#messages.motionError} ${error instanceof Error ? error.message : String(error)}`;
  }

  #text(tag: string, key: keyof Messages): HTMLElement {
    const node = document.createElement(tag);
    this.#texts.set(key, node);
    return node;
  }

  #legend(): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'motion-legend';
    const states: (keyof Messages)[] = ['stateEntering', 'stateWaiting', 'stateLeaving'];
    states.forEach((key, code) => {
      const item = document.createElement('li');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = STATE_COLOURS[code] ?? '#888888';
      item.append(swatch, this.#text('span', key));
      list.append(item);
    });
    return list;
  }

  #figuresList(): HTMLElement {
    const list = document.createElement('dl');
    list.className = 'motion-figures';
    const rows: [keyof Messages, HTMLElement][] = [
      ['modelTime', this.#figures.time],
      ['peopleInHall', this.#figures.people],
      ['snapshotsPerSecond', this.#figures.snapshots],
      ['framesPerSecond', this.#figures.frames],
    ];
    for (const [key, value] of rows) {
      const row = document.createElement('div');
      row.append(this.#text('dt', key), value);
      list.append(row);
    }
    return list;
  }

  #controls(): HTMLElement {
    const form = document.createElement('form');
    form.className = 'motion-controls';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
    });
    const labels: Record<Slider['key'], keyof Messages> = {
      arrivals: 'arrivalsPerUnit',
      speed: 'walkingSpeed',
      timeScale: 'timeScale',
    };
    for (const slider of SLIDERS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', name: slider.key, min: String(slider.min), max: String(slider.max) });
      input.step = String(slider.step);
      input.value = String(slider.value);
      const shown = document.createElement('output');
      shown.textContent = input.value;
      input.addEventListener('input', () => {
        shown.textContent = input.value;
        this.#change(slider.key, Number(input.value));
      });
      label.append(this.#text('span', labels[slider.key]), input, shown);
      form.append(label);
    }
    const pause = this.#pauseButton;
    pause.setAttribute('type', 'button');
    pause.addEventListener('click', () => {
      this.#paused = !this.#paused;
      pause.textContent = this.#paused ? this.#messages.resume : this.#messages.pause;
    });
    const restart = this.#text('button', 'restart');
    restart.setAttribute('type', 'button');
    restart.addEventListener('click', () => {
      const wasStopped = this.#stopped;
      this.#stopped = false;
      this.#start();
      // The frames go on unless an error stopped them.
      if (wasStopped) requestAnimationFrame(this.#frame);
    });
    const buttons = document.createElement('div');
    buttons.className = 'motion-buttons';
    buttons.append(pause, restart);
    form.append(buttons);
    return form;
  }

  #change(key: Slider['key'], value: number): void {
    const parameter = PARAMETERS[key];
    if (parameter === undefined) {
      this.#timeScale = value;
      return;
    }
    this.#client?.set(parameter, value).catch((error: unknown) => {
      this.#fail(error);
    });
  }
}

function figure(): HTMLElement {
  return document.createElement('dd');
}
