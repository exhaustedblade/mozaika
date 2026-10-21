/**
 * The scene benchmark page (Ф0-6б, П-18): a crowd of 100 000 walking agents
 * (or a million, `?agents=1000000`), the kernel in a Web Worker, the agents
 * drawn by instancing and led along their segments on the graphics card. It
 * warms up, measures for a while and shows the result — frames per second,
 * frame times, the time of a snapshot in the worker and of its upload — on
 * the page, with a button to copy it, and as `window.mozaikaBench` for the
 * Playwright test in CI.
 */
import '../style.css';

import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js';

import { detectLocale, type Locale, MESSAGES, type Messages } from '../i18n.js';
import { KernelClient } from '../kernel-client.js';
import { LiveView } from '../live-view.js';
import { crowdSide } from '../models/crowd.js';
import { AgentLayer } from '../scene/agent-layer.js';
import { personMesh } from '../scene/person-geometry.js';
import { Stage, toWorld } from '../scene/stage.js';
import { canDrawScene, sceneUnavailable } from '../scene/webgl-support.js';
import { ViewClock } from '../view-clock.js';
import { Samples, type Summary, summarise } from './frame-stats.js';
import type { BenchResult } from './result.js';

/** Seconds of real time before measuring, and of measuring by default. */
const WARM_UP = 3;
const DEFAULT_SECONDS = 10;
const DEFAULT_AGENTS = 100_000;
/** Model seconds per real second: the crowd walks five times as fast as people do, so motion shows from afar. */
const TIME_SCALE = 5;
/** Fewest milliseconds between snapshots (docs/ARCHITECTURE.md, "Показ"). */
const SNAPSHOT_INTERVAL = 50;
const SEED = 1;
/** Colours of the two states of a walker: out and back. */
const STATE_COLOURS = [0x2f6fb3, 0xd08a1e];

interface Settings {
  readonly agents: number;
  readonly seconds: number;
  readonly locale: Locale;
}

function readSettings(): Settings {
  const query = new URLSearchParams(window.location.search);
  const agents = Math.min(2_000_000, Math.max(1_000, Number(query.get('agents') ?? DEFAULT_AGENTS) || DEFAULT_AGENTS));
  const seconds = Math.min(120, Math.max(1, Number(query.get('seconds') ?? DEFAULT_SECONDS) || DEFAULT_SECONDS));
  const lang = query.get('lang');
  const locale = detectLocale(lang === null ? navigator.languages : [lang, ...navigator.languages]);
  return { agents, seconds, locale };
}

/**
 * The panel over the scene: what is measured, the figures and the result.
 * Its `data-state` — warm-up, measuring, done or failed — tells a test where the page is.
 */
class Panel {
  readonly element = document.createElement('aside');
  readonly #figures = new Map<keyof Messages, HTMLElement>();
  readonly #progress = document.createElement('p');
  readonly #result = document.createElement('div');
  readonly #t: Messages;

  constructor(t: Messages, settings: Settings) {
    this.#t = t;
    this.element.className = 'bench-panel';
    const title = document.createElement('h1');
    title.textContent = t.benchTitle;
    const about = document.createElement('p');
    about.textContent = t.benchAbout;
    const howTo = document.createElement('p');
    howTo.className = 'bench-how-to';
    howTo.textContent = t.benchHowTo;
    const links = document.createElement('nav');
    for (const agents of [100_000, 1_000_000]) {
      const link = document.createElement('a');
      const url = new URL(window.location.href);
      url.searchParams.set('agents', String(agents));
      link.href = url.toString();
      link.textContent = new Intl.NumberFormat(t.numberLocale).format(agents);
      if (agents === settings.agents) link.setAttribute('aria-current', 'page');
      links.append(link);
    }
    const home = document.createElement('a');
    home.href = './';
    home.textContent = t.backHome;
    links.append(home);
    const list = document.createElement('dl');
    const rows: (keyof Messages)[] = [
      'benchAgents',
      'benchRenderer',
      'benchFps',
      'benchFrameInterval',
      'benchFrameWork',
      'benchSnapshot',
      'benchRun',
      'benchUpload',
      'benchSnapshotsPerSecond',
    ];
    for (const key of rows) {
      const row = document.createElement('div');
      const label = document.createElement('dt');
      label.textContent = t[key];
      const value = document.createElement('dd');
      this.#figures.set(key, value);
      row.append(label, value);
      list.append(row);
    }
    this.#progress.className = 'bench-progress';
    this.#progress.setAttribute('aria-live', 'polite');
    this.element.append(title, about, howTo, links, this.#progress, list, this.#result);
    this.show('benchAgents', new Intl.NumberFormat(t.numberLocale).format(settings.agents));
  }

  show(key: keyof Messages, value: string): void {
    const figure = this.#figures.get(key);
    if (figure !== undefined) figure.textContent = value;
  }

  /** Where the measurement is: shown in words, and kept in `data-state`. */
  phase(state: 'warm-up' | 'measuring', text: string): void {
    this.element.dataset.state = state;
    this.#progress.textContent = text;
  }

  /** The page cannot measure: says why. */
  fail(text: string): void {
    this.element.dataset.state = 'failed';
    this.#progress.textContent = text;
  }

  /** Shows the figures of the result and a button that copies it all as JSON, to send. */
  finish(result: BenchResult): void {
    this.show('benchFps', this.#format(result.framesPerSecond, 1));
    this.show('benchFrameInterval', this.#pair(result.frameInterval));
    this.show('benchFrameWork', this.#pair(result.frameWork));
    this.show('benchSnapshot', this.#pair(result.snapshotInWorker));
    this.show('benchRun', this.#pair(result.runInWorker));
    this.show('benchUpload', this.#pair(result.upload));
    this.show('benchSnapshotsPerSecond', this.#format(result.snapshotsPerSecond, 1));
    const json = JSON.stringify(result, null, 2);
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = this.#t.benchCopy;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(json).then(() => {
        copy.textContent = this.#t.benchCopied;
      });
    });
    const text = document.createElement('pre');
    text.textContent = json;
    this.#result.replaceChildren(copy, text);
    this.#progress.textContent = this.#t.benchProgressDone;
    this.element.dataset.state = 'done';
  }

  #format(value: number, digits: number): string {
    if (!Number.isFinite(value)) return '—';
    const format = new Intl.NumberFormat(this.#t.numberLocale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    return format.format(value);
  }

  #pair(summary: Summary): string {
    return `${this.#format(summary.median, 2)} / ${this.#format(summary.p95, 2)}`;
  }
}

/** Warm-up, then measuring, then the result; the frames go on after it. */
class Measurement {
  readonly samples = new Samples();
  #phase: 'warm-up' | 'measuring' | 'done' = 'warm-up';
  #begun: number | undefined;
  #measuredFrom = 0;
  #snapshots = 0;
  readonly #seconds: number;
  readonly #onPhase: (phase: 'measuring' | 'done', seconds: number, snapshots: number) => void;

  constructor(seconds: number, onPhase: (phase: 'measuring' | 'done', seconds: number, snapshots: number) => void) {
    this.#seconds = seconds;
    this.#onPhase = onPhase;
  }

  get measuring(): boolean {
    return this.#phase === 'measuring';
  }

  snapshot(): void {
    if (this.measuring) this.#snapshots++;
  }

  frame(now: number): void {
    this.#begun ??= now;
    const seconds = (now - this.#begun) / 1000;
    if (this.#phase === 'warm-up' && seconds >= WARM_UP) {
      this.#phase = 'measuring';
      this.#measuredFrom = now;
      this.#onPhase('measuring', 0, 0);
    } else if (this.#phase === 'measuring' && seconds >= WARM_UP + this.#seconds) {
      this.#phase = 'done';
      this.#onPhase('done', (now - this.#measuredFrom) / 1000, this.#snapshots);
    }
  }
}

async function start(root: HTMLElement): Promise<void> {
  const settings = readSettings();
  const t = MESSAGES[settings.locale];
  document.documentElement.lang = settings.locale;
  document.title = `${t.benchTitle} — ${t.title}`;
  const panel = new Panel(t, settings);
  if (!canDrawScene()) {
    root.replaceChildren(sceneUnavailable(t.noWebgl), panel.element);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.className = 'scene-canvas';
  root.replaceChildren(canvas, panel.element);

  const side = crowdSide(settings.agents);
  const centre = { x: side / 2, y: side / 2 };
  const stage = new Stage(canvas, {
    background: '#dfe3e8',
    view: { target: centre, distance: side * 0.95, tilt: 0.95, closest: 5, farthest: side * 3 },
  });
  const floor = CreateGround('floor', { width: side, height: side }, stage.scene);
  floor.position = toWorld(centre);
  floor.material = stage.matte('floor', '#c9c4b8');
  const agents = new AgentLayer(stage.scene, { mesh: personMesh(), stateColours: STATE_COLOURS });
  panel.show('benchRenderer', stage.renderer);

  const worker = new Worker(new URL('../kernel-worker.ts', import.meta.url), { type: 'module' });
  const client = new KernelClient(worker);
  panel.phase('warm-up', t.benchProgressWarmUp);
  await client.build('crowd', SEED, { agents: settings.agents });

  const measurement = new Measurement(settings.seconds, (phase, seconds, snapshots) => {
    if (phase === 'measuring') {
      panel.phase('measuring', t.benchProgressMeasuring);
      return;
    }
    const result = summary(stage, settings, measurement.samples, seconds, snapshots);
    window.mozaikaBench = result;
    panel.finish(result);
  });
  const { samples } = measurement;
  const view = new LiveView({
    stage,
    agents,
    client,
    clock: new ViewClock({ timeScale: TIME_SCALE, maxLead: 0.25, maxStep: 0.1 }),
    snapshotInterval: SNAPSHOT_INTERVAL,
    onSnapshot: (snapshot, ran, upload) => {
      if (!measurement.measuring) return;
      measurement.snapshot();
      samples.upload.push(upload);
      samples.snapshotInWorker.push(snapshot.workerMilliseconds);
      samples.runInWorker.push(ran.workerMilliseconds);
    },
    onFrame: ({ now, interval, work }) => {
      if (measurement.measuring) {
        samples.frameIntervals.push(interval);
        samples.frameWork.push(work);
      }
      measurement.frame(now);
    },
    onError: (error) => {
      panel.fail(error instanceof Error ? error.message : String(error));
    },
  });
  view.start();
}

function summary(stage: Stage, settings: Settings, samples: Samples, seconds: number, snapshots: number): BenchResult {
  return {
    agents: settings.agents,
    renderer: stage.renderer,
    userAgent: navigator.userAgent,
    canvas: stage.size,
    devicePixelRatio: window.devicePixelRatio,
    seconds,
    framesPerSecond: samples.frameIntervals.length / seconds,
    frameInterval: summarise(samples.frameIntervals),
    frameWork: summarise(samples.frameWork),
    snapshotInWorker: summarise(samples.snapshotInWorker),
    runInWorker: summarise(samples.runInWorker),
    upload: summarise(samples.upload),
    snapshotsPerSecond: snapshots / seconds,
  };
}

const root = document.getElementById('app');
if (root !== null) {
  start(root).catch((error: unknown) => {
    root.append(sceneUnavailable(error instanceof Error ? error.message : String(error)));
  });
}
