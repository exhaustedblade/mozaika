/**
 * The demo "service point" (Ф0-6б): the model of models/service-point.ts in
 * the kernel's Web Worker, its people in the 3D scene of the hall, its
 * parameters in a panel, its records on charts and its laws checked live.
 */
import '../style.css';

import type { Snapshot } from '@mozaika/kernel';

import { detectLocale, type Locale, MESSAGES } from '../i18n.js';
import { KernelClient } from '../kernel-client.js';
import { LiveView } from '../live-view.js';
import {
  PERSON_STATES,
  SERVICE_POINT_DEFAULTS,
  type ServicePointParameters,
  type ServicePointRecord,
} from '../models/service-point.js';
import { HALL } from '../models/service-point-layout.js';
import { AgentLayer } from '../scene/agent-layer.js';
import { personMesh } from '../scene/person-geometry.js';
import { Stage } from '../scene/stage.js';
import { canDrawScene, sceneUnavailable } from '../scene/webgl-support.js';
import { ViewClock } from '../view-clock.js';
import { chartPoints } from './chart-series.js';
import { DemoCharts } from './charts.js';
import { Hall } from './hall.js';
import { DemoPanel } from './panel.js';
import { coloursByCode, countPeople, type PeopleCount } from './person-states.js';

const SEED = 1;
const LANG_PARAM = 'lang';
/** Model minutes per second of real time at the start: twelve times as fast as life. */
const MINUTES_PER_SECOND = 0.2;
/** Fewest milliseconds between snapshots (docs/ARCHITECTURE.md, "Показ"). */
const SNAPSHOT_INTERVAL = 50;
/** Milliseconds between two updates of the figures of the moment. */
const FIGURES_EVERY = 250;

const NOBODY: PeopleCount = { people: 0, inLine: 0, atWindows: 0 };

/** The model running now: its worker and client, the frames that draw it, and what it has shown so far. */
interface Run {
  readonly worker: Worker;
  readonly client: KernelClient;
  readonly view: LiveView;
  /** Names of the states of the people, by state code, from the kernel's `build` reply. */
  stateNames: readonly string[];
  /** The latest record of the model, from which the next one's interval averages are taken. */
  latest: Snapshot<ServicePointRecord> | undefined;
  people: PeopleCount;
}

/** The page: one stage and panel for the life of the page, and a model run built anew on demand. */
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
      stateColours: coloursByCode(PERSON_STATES),
      shadows: true,
    });
    this.#charts = new DemoCharts(t);
    this.#panel = new DemoPanel(t, this.#parameters, MINUTES_PER_SECOND, {
      onParameter: (name, value) => {
        this.#parameters[name] = value;
        const run = this.#run;
        run?.client.set(name, value).catch((error: unknown) => {
          this.#fail(run, error);
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
    const run: Run = {
      worker,
      client,
      view: new LiveView({
        stage: this.#stage,
        agents: this.#agents,
        client,
        clock: this.#clock,
        snapshotInterval: SNAPSHOT_INTERVAL,
        onSnapshot: (snapshot, ran) => {
          const people = snapshot.populations[0];
          if (people !== undefined) run.people = countPeople(people, run.stateNames);
          this.#takeRecords(run, (ran.records ?? []) as Snapshot<ServicePointRecord>[]);
        },
        onFrame: ({ now, time }) => {
          this.#showMoment(run, now, time);
        },
        onError: (error) => {
          this.#fail(run, error);
        },
      }),
      stateNames: PERSON_STATES,
      latest: undefined,
      people: NOBODY,
    };
    this.#run = run;
    client.build('servicePoint', SEED, this.#parameters).then(
      (built) => {
        if (this.#run !== run) return;
        run.stateNames = built.populations[0]?.stateNames ?? PERSON_STATES;
        this.#agents.setStateColours(coloursByCode(run.stateNames));
        run.view.start();
      },
      (error: unknown) => {
        this.#fail(run, error);
      },
    );
  }

  #stop(): void {
    this.#run?.view.stop();
    this.#run?.worker.terminate();
    this.#run = undefined;
  }

  #showMoment(run: Run, now: number, time: number): void {
    if (now - this.#figuresShown < FIGURES_EVERY) return;
    this.#figuresShown = now;
    this.#panel.showMoment({ time, ...run.people, windows: run.latest?.data.windows });
  }

  #takeRecords(run: Run, records: readonly Snapshot<ServicePointRecord>[]): void {
    if (records.length === 0) return;
    const points = records.map((record) => {
      const point = chartPoints(run.latest, record);
      run.latest = record;
      return point;
    });
    this.#charts.add(points);
    if (run.latest !== undefined) this.#panel.showRecord(run.latest);
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

  /** A run failed: it stops, and the panel says why. A run that is no longer the current one is let be. */
  #fail(run: Run, error: unknown): void {
    if (this.#run !== run) return;
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
