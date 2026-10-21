/**
 * The scene benchmark page (Ф0-6б, П-18): a crowd of 100 000 walking agents
 * (or a million, `?agents=1000000`), the kernel in a Web Worker, the agents
 * drawn by instancing and led along their segments on the graphics card. It
 * warms up, measures for a while and shows the result — frames per second,
 * frame times, the time of a snapshot in the worker and of its upload — on
 * the page and as `window.mozaikaBench` for the Playwright test in CI.
 */
import '../style.css';

import { KernelClient } from '../kernel-client.js';
import { detectLocale, type Locale, MESSAGES, type Messages } from '../i18n.js';
import { crowdSide } from '../models/crowd.js';
import { canDrawScene, sceneUnavailable } from '../scene/webgl-support.js';
import { SnapshotFeed } from '../snapshot-feed.js';
import { ViewClock } from '../view-clock.js';
import { Samples, type Summary, summarise } from './frame-stats.js';
import { personMesh } from '../scene/person-geometry.js';
import { type BenchStage, type CreateBenchStage, degenerateMesh } from './stage.js';

/** Seconds of real time before measuring and of measuring. */
const WARM_UP = 3;
const DEFAULT_SECONDS = 10;
const DEFAULT_AGENTS = 100_000;
/** Model seconds per real second: the crowd walks five times as fast as people do, so motion is seen from afar. */
const TIME_SCALE = 5;
/** Fewest milliseconds between snapshots (docs/ARCHITECTURE.md, "Показ"). */
const SNAPSHOT_INTERVAL = 50;
const SEED = 1;
/** Colours of the two states of a walker. */
const STATE_COLOURS = [0x2f6fb3, 0xd08a1e];

/** What the page reports, on the page and to the Playwright test. */
export interface BenchResult {
  readonly engine: string;
  readonly agents: number;
  readonly renderer: string;
  readonly userAgent: string;
  readonly canvas: readonly [number, number];
  readonly devicePixelRatio: number;
  readonly seconds: number;
  readonly framesPerSecond: number;
  readonly frameInterval: Summary;
  readonly frameWork: Summary;
  readonly snapshotInWorker: Summary;
  readonly runInWorker: Summary;
  readonly upload: Summary;
  readonly snapshotsPerSecond: number;
}

declare global {
  interface Window {
    mozaikaBench?: BenchResult;
  }
}

const ENGINES: Readonly<Record<string, () => Promise<{ createStage: CreateBenchStage }>>> = {
  three: () => import('./three-stage.js'),
  babylon: () => import('./babylon-stage.js'),
};

interface Settings {
  readonly engine: string;
  /** `?mesh=degenerate`: no raster work, to compare the engines on a software GPU. */
  readonly degenerate: boolean;
  readonly agents: number;
  readonly seconds: number;
  readonly locale: Locale;
}

function readSettings(): Settings {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get('engine') ?? 'three';
  const engine = requested in ENGINES ? requested : 'three';
  const agents = Math.min(2_000_000, Math.max(1_000, Number(query.get('agents') ?? DEFAULT_AGENTS) || DEFAULT_AGENTS));
  const seconds = Math.min(120, Math.max(1, Number(query.get('seconds') ?? DEFAULT_SECONDS) || DEFAULT_SECONDS));
  const lang = query.get('lang');
  const locale = detectLocale(lang === null ? navigator.languages : [lang, ...navigator.languages]);
  return { engine, degenerate: query.get('mesh') === 'degenerate', agents, seconds, locale };
}

/** The panel over the scene: what is measured, live figures and the result. */
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
    const sizes = document.createElement('nav');
    for (const agents of [100_000, 1_000_000]) {
      const link = document.createElement('a');
      const url = new URL(window.location.href);
      url.searchParams.set('agents', String(agents));
      link.href = url.toString();
      link.textContent = new Intl.NumberFormat(t.numberLocale).format(agents);
      if (agents === settings.agents) link.setAttribute('aria-current', 'page');
      sizes.append(link);
    }
    const home = document.createElement('a');
    home.href = './';
    home.textContent = t.benchBack;
    sizes.append(home);
    const list = document.createElement('dl');
    const rows: (keyof Messages)[] = [
      'benchEngine',
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
    this.element.append(title, about, sizes, this.#progress, list, this.#result);
    this.show('benchEngine', settings.engine);
    this.show('benchAgents', new Intl.NumberFormat(t.numberLocale).format(settings.agents));
  }

  show(key: keyof Messages, value: string): void {
    const figure = this.#figures.get(key);
    if (figure !== undefined) figure.textContent = value;
  }

  progress(text: string): void {
    this.#progress.textContent = text;
  }

  /** Shows the result and a button that copies it as JSON, to send. */
  finish(result: BenchResult): void {
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
  }
}

function format(value: number, digits = 1): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function pair(summary: Summary): string {
  return `${format(summary.median, 2)} / ${format(summary.p95, 2)}`;
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
  canvas.className = 'bench-canvas';
  root.replaceChildren(canvas, panel.element);

  const load = ENGINES[settings.engine] ?? ENGINES.three;
  if (load === undefined) throw new Error('no engine');
  const { createStage } = await load();
  const mesh = settings.degenerate ? degenerateMesh() : personMesh();
  const stage = createStage(canvas, { side: crowdSide(settings.agents), stateColours: STATE_COLOURS, mesh });
  panel.show('benchRenderer', stage.renderer);

  const worker = new Worker(new URL('../kernel-worker.ts', import.meta.url), { type: 'module' });
  const client = new KernelClient(worker);
  await client.build('crowd', SEED, { agents: settings.agents });
  run(stage, client, panel, settings, t);
}

/** The frames: warm-up, measuring, and on after the result is in. */
function run(stage: BenchStage, client: KernelClient, panel: Panel, settings: Settings, t: Messages): void {
  const clock = new ViewClock({ timeScale: TIME_SCALE, maxLead: 0.25, maxStep: 0.1 });
  const samples = new Samples();
  let snapshotTime: number | undefined;
  let measuring = false;
  let snapshots = 0;
  const feed = new SnapshotFeed(client, {
    minInterval: SNAPSHOT_INTERVAL,
    onSnapshot: (snapshot, ran) => {
      const population = snapshot.populations[0];
      if (population === undefined) return;
      const started = performance.now();
      stage.upload(population);
      if (measuring) {
        samples.upload.push(performance.now() - started);
        samples.snapshotInWorker.push(snapshot.workerMilliseconds);
        samples.runInWorker.push(ran.workerMilliseconds);
        snapshots++;
      }
      snapshotTime = snapshot.time;
    },
    onError: (error) => {
      panel.progress(error instanceof Error ? error.message : String(error));
    },
  });

  const begun = performance.now();
  let last: number | undefined;
  let measuredFrom = 0;
  let done = false;
  panel.progress(t.benchProgressWarmUp);
  const frame = (now: number): void => {
    const started = performance.now();
    const elapsed = last === undefined ? 0 : now - last;
    if (measuring && last !== undefined) samples.frameIntervals.push(elapsed);
    last = now;
    const time = clock.tick(elapsed / 1000, feed.latest);
    feed.frame(time, now);
    stage.render(snapshotTime === undefined ? 0 : time - snapshotTime);
    if (measuring) samples.frameWork.push(performance.now() - started);

    const seconds = (now - begun) / 1000;
    if (!measuring && !done && seconds >= WARM_UP) {
      measuring = true;
      measuredFrom = now;
      panel.progress(t.benchProgressMeasuring);
    } else if (measuring && seconds >= WARM_UP + settings.seconds) {
      measuring = false;
      done = true;
      const result = summary(stage, settings, samples, (now - measuredFrom) / 1000, snapshots);
      window.mozaikaBench = result;
      panel.progress(t.benchProgressDone);
      showResult(panel, result);
      panel.finish(result);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function summary(stage: BenchStage, settings: Settings, samples: Samples, seconds: number, snapshots: number): BenchResult {
  const canvas = document.querySelector('canvas');
  return {
    engine: settings.engine,
    agents: settings.agents,
    renderer: stage.renderer,
    userAgent: navigator.userAgent,
    canvas: [canvas?.width ?? 0, canvas?.height ?? 0],
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

function showResult(panel: Panel, result: BenchResult): void {
  panel.show('benchFps', format(result.framesPerSecond));
  panel.show('benchFrameInterval', pair(result.frameInterval));
  panel.show('benchFrameWork', pair(result.frameWork));
  panel.show('benchSnapshot', pair(result.snapshotInWorker));
  panel.show('benchRun', pair(result.runInWorker));
  panel.show('benchUpload', pair(result.upload));
  panel.show('benchSnapshotsPerSecond', format(result.snapshotsPerSecond));
}

const root = document.getElementById('app');
if (root !== null) {
  start(root).catch((error: unknown) => {
    const message = document.createElement('p');
    message.className = 'scene-unavailable';
    message.textContent = error instanceof Error ? error.message : String(error);
    root.append(message);
  });
}
