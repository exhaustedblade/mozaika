/**
 * The demo "service point" (Ф0-6б): people come in through the entrance,
 * stand in a line, walk to a free window, are served there and walk out.
 * Time is in minutes, length in metres.
 *
 *   Source "entrance" → Queue "line" → Service "service" (ResourcePool "windows") → Sink "out"
 *
 * The blocks decide who waits, who is served and for how long; their entry
 * and exit actions walk the people, who are agents with a statechart that
 * only shows where each person is (П-31, П-32). The line and the windows are
 * the queueing system: Service holds as many as there are windows, so a
 * person leaves the line exactly when a window is free and is served at once.
 * Leaving through the Sink ends the time in the system; the person then walks
 * out of the hall and is removed on arriving at the door.
 *
 * Self-check: the laws of service-point-laws.ts hold on every record, and with
 * exponential times the model agrees with the M/M/c formulas (tests).
 */
import { type Agent, AgentPopulation, defineStatechart, type Simulation, type SnapshotRecorder } from '@mozaika/kernel';
import { Queue, ResourcePool, Service, Sink, Source } from '@mozaika/blocks';
import type { ModelDefinition } from '@mozaika/kernel/worker';

import { ENTRANCE, EXIT, lineSpot, MAX_WINDOWS, windowSpot } from './service-point-layout.js';

/**
 * The parameters: people arriving per minute and mean service time in
 * minutes, both read while the model runs, and the number of windows open,
 * read when it is built — the capacity of a pool is set when it is created.
 */
// A type rather than an interface: only a type is a record of numbers (ModelParameters).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ServicePointParameters = { arrivalsPerMinute: number; windows: number; serviceMinutes: number };

/** Five windows at a load of 0.8: a line forms now and then and clears again. */
export const SERVICE_POINT_DEFAULTS: ServicePointParameters = { arrivalsPerMinute: 1.6, windows: 5, serviceMinutes: 2.5 };

/** Walking speed in metres per minute (1.25 m/s). */
const WALKING_SPEED = 75;

/** Model time between two records for the charts and the self-check, in minutes. */
export const RECORD_EVERY = 1;

/**
 * What the model records every RECORD_EVERY minutes (simulation.recordSnapshots):
 * counts now, and totals since the start from which the charts take averages
 * over any interval and the laws are checked.
 */
// A type rather than an interface: records are JSON data (JsonValue).
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ServicePointRecord = {
  /** People who came in since the start. */
  arrived: number;
  /** People who left the system, served, since the start. */
  left: number;
  /** People in the line now. */
  inLine: number;
  /** People at the windows now, walking to them or served. */
  atWindows: number;
  /** People served who are walking out of the hall now, counted by their state. */
  walkingOut: number;
  /** Agents in the population now. */
  people: number;
  /** Windows open, and busy now. */
  windows: number;
  busy: number;
  /** ∫ people in the line dt, since the start. */
  lineArea: number;
  /** ∫ busy windows dt, since the start. */
  busyArea: number;
  /** ∫ people in the system (line and windows) dt, since the start. */
  systemArea: number;
  /** Sum of the times in the system of the people who left. */
  timeOfLeft: number;
  /** Sum of the times spent so far by the people in the system now. */
  timeOfPresent: number;
};

/**
 * A person's way through the hall. The states only show it: the blocks send
 * `called` when a window is the person's, and `done` when its service ends;
 * arrivals of the walks move a person from walking to standing.
 */
const person = defineStatechart({
  id: 'person',
  initial: 'entering',
  states: {
    entering: { on: { 'agent.arrived': 'waiting', called: 'toWindow' } },
    waiting: { on: { called: 'toWindow' } },
    toWindow: { on: { 'agent.arrived': 'served', done: 'leaving' } },
    served: { on: { done: 'leaving' } },
    leaving: { on: { 'agent.arrived': 'gone' } },
    gone: {
      type: 'final',
      entry: ({ agent }) => {
        agent.population.remove(agent);
      },
    },
  },
});

/** The model, with its blocks, for the worker and for the tests. */
export interface ServicePoint {
  readonly simulation: Simulation;
  readonly people: AgentPopulation;
  readonly entrance: Source;
  readonly line: Queue;
  readonly service: Service;
  readonly windows: ResourcePool;
  readonly out: Sink;
  readonly records: SnapshotRecorder<ServicePointRecord>;
}

/** Builds the service point in `simulation`; `parameters` are read while it runs, but for the windows. */
export function buildServicePoint(simulation: Simulation, parameters: Readonly<ServicePointParameters>): ServicePoint {
  const open = Math.min(MAX_WINDOWS, Math.max(1, Math.round(parameters.windows)));
  const people = new AgentPopulation(simulation, { name: 'people', statechart: person });
  const windows = new ResourcePool(simulation, { name: 'windows', capacity: open });
  /** Who stands at each window; the model's own record, as units of a pool have no names. */
  const atWindow: (Agent | undefined)[] = Array.from({ length: open }, () => undefined);
  /** The line in its order, the head first: the k-th person stands at lineSpot(k). */
  const waiting: Agent[] = [];

  const entrance = new Source(simulation, {
    name: 'entrance',
    interval: (random) => random.exponential(1 / parameters.arrivalsPerMinute),
    entity: () => people.add(),
    onExit: ({ agent }) => {
      agent.placeAt(ENTRANCE);
    },
  });
  const line = new Queue(simulation, {
    name: 'line',
    onEnter: ({ agent }) => {
      waiting.push(agent);
      agent.moveTo(lineSpot(waiting.length - 1), { speed: WALKING_SPEED });
    },
    // A queue lets its head go first (FIFO), so the one leaving is waiting[0]; the others step up.
    onExit: ({ agent }) => {
      if (waiting.shift() !== agent) throw new Error(`Queue "line" let person #${String(agent.id)} go before its head`);
      waiting.forEach((next, place) => {
        next.moveTo(lineSpot(place), { speed: WALKING_SPEED });
      });
    },
  });
  const service = new Service(simulation, {
    name: 'service',
    pool: windows,
    // As many in the block as there are windows: whoever enters gets a window at once.
    capacity: open,
    duration: (random) => random.exponential(parameters.serviceMinutes),
    onEnter: ({ agent }) => {
      const window = atWindow.indexOf(undefined);
      if (window < 0) throw new Error(`Person #${String(agent.id)} entered the service with every window taken`);
      atWindow[window] = agent;
      agent.send({ type: 'called' });
      agent.moveTo(windowSpot(window), { speed: WALKING_SPEED });
    },
    onExit: ({ agent }) => {
      atWindow[atWindow.indexOf(agent)] = undefined;
      agent.send({ type: 'done' });
    },
  });
  // The person leaves the system here but stays in the population, to walk out of the hall.
  const out = new Sink(simulation, {
    name: 'out',
    removeAgents: false,
    onEnter: ({ agent }) => {
      agent.moveTo(EXIT, { speed: WALKING_SPEED });
    },
  });
  entrance.connect(line).connect(service).connect(out);

  const model = { simulation, people, entrance, line, service, windows, out };
  const records = simulation.recordSnapshots({ every: RECORD_EVERY, capture: (time) => recordOf(model, time) });
  return { ...model, records };
}

/** The record of the model at model time `time`, the current time. */
function recordOf(model: Omit<ServicePoint, 'records'>, time: number): ServicePointRecord {
  const { people, entrance, line, service, windows, out } = model;
  const inLine = line.stats.length.current;
  const atWindows = service.stats.content.current;
  const walkingOut = people.count('leaving');
  let timeOfPresent = 0;
  for (const agent of people.agents) {
    if (agent.state !== 'leaving') timeOfPresent += time - agent.createdAt;
  }
  const leftTimes = out.stats.timeInSystem;
  return {
    arrived: entrance.arrivals,
    left: out.count,
    inLine,
    atWindows,
    walkingOut,
    people: people.size,
    windows: windows.capacity,
    busy: windows.busy,
    lineArea: line.stats.length.mean * time,
    busyArea: windows.stats.busy.mean * time,
    systemArea: (line.stats.length.mean + service.stats.content.mean) * time,
    timeOfLeft: leftTimes.count === 0 ? 0 : leftTimes.mean * leftTimes.count,
    timeOfPresent,
  };
}

/** The service point for the kernel's worker: the people for the scene, the records for the charts. */
export const servicePoint: ModelDefinition<ServicePointParameters> = {
  parameters: SERVICE_POINT_DEFAULTS,
  build({ simulation, parameters }) {
    const { people, records } = buildServicePoint(simulation, parameters);
    return { populations: [people], records };
  },
};
