/**
 * The demo "service point" (Ф0-6б): the model of models/service-point.ts in
 * the kernel's Web Worker, its people in the 3D scene of the hall, its
 * parameters in a panel, its records on charts and its laws checked live.
 */
import '../style.css';

import type { PopulationSnapshot, Snapshot } from '@mozaika/kernel';

import { detectLocale, type Locale, MESSAGES } from '../i18n.js';
import { KernelClient } from '../kernel-client.js';
import { LiveView } from '../live-view.js';
import { SERVICE_POINT_DEFAULTS, type ServicePointParameters, type ServicePointRecord } from '../models/service-point.js';
import { HALL } from '../models/service-point-layout.js';
import { AgentLayer } from '../scene/agent-layer.js';
import { personMesh } from '../scene/person-geometry.js';
import { Stage } from '../scene/stage.js';
import { canDrawScene, sceneUnavailable } from '../scene/webgl-support.js';
import { ViewClock } from '../view-clock.js';
import { chartPoints } from './chart-series.js';
import { DemoCharts } from './charts.js';
import { Hall } from './hall.js';
import { DemoPanel, PERSON_STATES } from './panel.js';

const SEED = 1;
const LANG_PARAM = 'lang';
/** Model minutes per second of real time at the start: twelve times as fast as life. */
const MINUTES_PER_SECOND = 0.2;
/** Fewest milliseconds between snapshots (docs/ARCHITECTURE.md, "Показ"). */
const SNAPSHOT_INTERVAL = 50;
/** Milliseconds between two updates of the figures of the moment. */
const FIGURES_EVERY = 250;

/** State codes of a person, in the order of the statechart (models/service-point.ts). */
const STATE = { toLine: 0, inLine: 1, toWindow: 2, served: 3, out: 4 } as const;

/** The model running now: its worker, the client that talks to it, the frames that draw it, and its last record. */
interface Run {
  readonly worker: Worker;
  readonly client: KernelClient;
  readonly view: LiveView;
  previous: Snapshot<ServicePointRecord> | undefined;
}

class Demo {
  readonly #stage: Stage;
  readonly #hall: Hall;
  readonly #agents: AgentLayer;
  readonly #panel: DemoPanel;
  readonly #charts: DemoCharts;
  readonly #clock = new ViewClock({ timeScale: MINUTES_PER_SECOND, maxLead: 0.25, maxStep: 0.1 });
  readonly #parameters: ServicePointParameters = { ...SERVICE_POINT_DEFAULTS };
  #locale: Locale;
  #run: Run | undefined;
  #figuresShown = 0;
  #moment = { people: 0, inLine: 0, atWindows: 0 };

  constructor(root: HTMLElement, canvas: HTMLCanvasElement, locale: Locale) {
    this.#locale = locale;
    const t = MESSAGES[locale];
    this.#stage = new Stage(canvas, {
      background: '#e4e7eb',
      view: { target: { x: HALL.width / 2, y: HALL.depth / 2 - 1 }, distance: 31, tilt: 0.88, closest: 4, farthest: 120 },
    });
    this.#hall = new Hall(this.#stage);
    this.#agents = new AgentLayer(this.#stage.scene, {
      mesh: personMesh(),
      stateColours: PERSON_STATES.map((state) => state.colour),
      shadows: true,
    });
    this.#charts = new DemoCharts(t);
    this.#panel = new DemoPanel(t, this.#parameters, MINUTES_PER_SECOND, {
      onParameter: (name, value) => {
        this.#parameters[name] = value;
        this.#run?.client.set(name, value).catch((error: unknown) => {
          this.#fail(error);
        });
      },
      onWindows: (value) => {
        this.#parameters.windows = value;
        this.#start();
      },
      onTimeScale: (value) => {
        this.#clock.timeScale = value;
      },
      onPause: (paused) => {
        this.#clock.paused = paused;
      },
      onRestart: () => {
        this.#start();
      },
      onLanguage: () => {
        this.#translate(this.#locale === 'ru' ? 'en' : 'ru');
      },
    });
    this.#panel.charts.append(this.#charts.element);
    root.append(this.#panel.element);
    this.#translate(locale);
    this.#start();
  }

  /** Builds the model afresh in a new worker, with the parameters of the panel, and starts the frames. */
  #start(): void {
    this.#stop();
    this.#panel.showError('');
    this.#hall.openWindows(this.#parameters.windows);
    this.#agents.clear();
    this.#charts.clear();
    this.#clock.reset(0);
    const worker = new Worker(new URL('../kernel-worker.ts', import.meta.url), { type: 'module' });
    const client = new KernelClient(worker);
    const view = new LiveView({
      stage: this.#stage,
      agents: this.#agents,
      client,
      clock: this.#clock,
      snapshotInterval: SNAPSHOT_INTERVAL,
      onSnapshot: (snapshot, ran) => {
        const people = snapshot.populations[0];
        if (people !== undefined) this.#count(people);
        this.#takeRecords((ran.records ?? []) as Snapshot<ServicePointRecord>[]);
      },
      onFrame: ({ now, time }) => {
        if (now - this.#figuresShown < FIGURES_EVERY) return;
        this.#figuresShown = now;
        this.#panel.showMoment({ time, ...this.#moment, windows: this.#parameters.windows });
      },
      onError: (error) => {
        this.#fail(error);
      },
    });
    const run: Run = { worker, client, view, previous: undefined };
    this.#run = run;
    client.build('servicePoint', SEED, this.#parameters).then(
      () => {
        if (this.#run === run) view.start();
      },
      (error: unknown) => {
        this.#fail(error);
      },
    );
  }

  #stop(): void {
    this.#run?.view.stop();
    this.#run?.worker.terminate();
    this.#run = undefined;
  }

  /** Counts the people of a snapshot by where they are. */
  #count(people: PopulationSnapshot): void {
    let inLine = 0;
    let atWindows = 0;
    for (const state of people.states) {
      if (state === STATE.toLine || state === STATE.inLine) inLine++;
      else if (state === STATE.toWindow || state === STATE.served) atWindows++;
    }
    this.#moment = { people: people.size, inLine, atWindows };
  }

  #takeRecords(records: readonly Snapshot<ServicePointRecord>[]): void {
    const run = this.#run;
    if (run === undefined || records.length === 0) return;
    const points = records.map((record) => {
      const point = chartPoints(run.previous, record);
      run.previous = record;
      return point;
    });
    this.#charts.add(points);
    if (run.previous !== undefined) this.#panel.showRecord(run.previous);
  }

  #translate(locale: Locale): void {
    this.#locale = locale;
    const t = MESSAGES[locale];
    document.documentElement.lang = locale;
    document.title = `${t.demoTitle} — ${t.title}`;
    const url = new URL(window.location.href);
    url.searchParams.set(LANG_PARAM, locale);
    window.history.replaceState(null, '', url);
    this.#panel.translate(t);
    this.#charts.translate(t);
  }

  #fail(error: unknown): void {
    this.#stop();
    this.#panel.showError(`${MESSAGES[this.#locale].motionError} ${error instanceof Error ? error.message : String(error)}`);
  }
}

function localeOfPage(): Locale {
  const requested = new URLSearchParams(window.location.search).get(LANG_PARAM);
  return detectLocale(requested === null ? navigator.languages : [requested, ...navigator.languages]);
}

const root = document.getElementById('app');
if (root !== null) {
  const locale = localeOfPage();
  const scene = document.createElement('div');
  scene.className = 'demo-scene';
  root.className = 'demo';
  root.replaceChildren(scene);
  if (canDrawScene()) {
    const canvas = document.createElement('canvas');
    canvas.className = 'scene-canvas';
    scene.append(canvas);
    new Demo(root, canvas, locale);
  } else {
    scene.append(sceneUnavailable(MESSAGES[locale].noWebgl));
  }
}
