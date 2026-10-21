import { describe, expect, it } from 'vitest';

import { AgentPopulation } from '../agents/population.js';
import { defineStatechart } from '../agents/statechart.js';
import { Simulation } from '../simulation.js';
import { containing } from '../test-helpers.js';
import { KernelHost } from './host.js';
import type { KernelReply, KernelRequest, ModelDefinition, ModelParameters, SnapshotReply } from './protocol.js';

/** What the walkway model built last: the tests compare the host's answers with it. */
interface Built {
  walkers: AgentPopulation;
  parameters: ModelParameters;
}

/**
 * People come in at random and walk across a walkway ten units long, to a
 * random point of its far side; there they leave. The speed and the rate of
 * arrivals are parameters that the model reads while it runs.
 */
function walkwayModel(built: Partial<Built> = {}): ModelDefinition {
  return {
    parameters: { arrivalsPerUnit: 4, speed: 2 },
    build({ simulation, parameters }) {
      const person = defineStatechart({
        initial: 'walking',
        states: {
          walking: {
            entry: ({ agent, random }) => {
              agent.placeAt({ x: 0, y: random.uniform(0, 4) });
              agent.moveTo({ x: 10, y: random.uniform(0, 4) }, { speed: parameters.speed });
            },
            on: { 'agent.arrived': 'gone' },
          },
          gone: { type: 'final', entry: ({ agent }) => agent.population.remove(agent) },
        },
      });
      const walkers = new AgentPopulation(simulation, { name: 'walkers', statechart: person });
      const arrivals = simulation.random.stream('arrivals');
      const arrive = (): void => {
        walkers.add();
        simulation.schedule(arrivals.exponential(1 / parameters.arrivalsPerUnit), arrive);
      };
      simulation.schedule(0, arrive);
      built.walkers = walkers;
      built.parameters = parameters;
      return { populations: [walkers] };
    },
  };
}

/** Sends one request and returns the reply, checking it answers that request. */
function ask(host: KernelHost, request: KernelRequest): KernelReply {
  const { reply } = host.handle(request);
  expect(reply.id).toBe(request.id);
  return reply;
}

function snapshotOf(reply: KernelReply): SnapshotReply {
  if (reply.type !== 'snapshot') throw new Error(`expected a snapshot, got ${JSON.stringify(reply)}`);
  return reply;
}

describe('kernel host: building and running', () => {
  it('builds a model by name and answers with its populations and parameters', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    expect(ask(host, { type: 'build', id: 1, model: 'walkway', seed: 3, parameters: { speed: 2.5 } })).toEqual({
      type: 'built',
      id: 1,
      time: 0,
      parameters: { arrivalsPerUnit: 4, speed: 2.5 },
      populations: [{ name: 'walkers', stateNames: ['walking', 'gone'] }],
    });
  });

  it('runs to a moment and answers with the time, the events fired and the reason', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    ask(host, { type: 'build', id: 1, model: 'walkway', seed: 3 });
    const reply = ask(host, { type: 'run', id: 2, until: 5 });
    expect(reply).toMatchObject({ type: 'ran', id: 2, time: 5, reason: 'until' });
    expect(reply.type === 'ran' && reply.events).toBeGreaterThan(20);
  });

  it('runs the model as it runs without the host: the same seed gives the same agents in the same places', () => {
    const inHost: Partial<Built> = {};
    const host = new KernelHost({ walkway: walkwayModel(inHost) });
    ask(host, { type: 'build', id: 1, model: 'walkway', seed: 3 });
    ask(host, { type: 'run', id: 2, until: 7 });
    ask(host, { type: 'run', id: 3, until: 12.5 });

    const alone: Partial<Built> = {};
    const simulation = new Simulation({ seed: 3 });
    walkwayModel(alone).build({ simulation, parameters: { arrivalsPerUnit: 4, speed: 2 } });
    simulation.run(12.5);
    expect(inHost.walkers?.size).toBeGreaterThan(10);
    expect([...(inHost.walkers?.ids() ?? [])]).toEqual([...(alone.walkers?.ids() ?? [])]);
    expect([...(inHost.walkers?.positions() ?? [])]).toEqual([...(alone.walkers?.positions() ?? [])]);
  });

  it('builds a fresh model on each build', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    ask(host, { type: 'build', id: 1, model: 'walkway' });
    ask(host, { type: 'run', id: 2, until: 3 });
    expect(ask(host, { type: 'build', id: 3, model: 'walkway' })).toMatchObject({ type: 'built', time: 0 });
    expect(ask(host, { type: 'run', id: 4, until: 1 })).toMatchObject({ type: 'ran', time: 1 });
  });
});

describe('kernel host: snapshots', () => {
  it('gives a snapshot of every population, with its buffers in the list to transfer', () => {
    const built: Partial<Built> = {};
    const host = new KernelHost({ walkway: walkwayModel(built) });
    ask(host, { type: 'build', id: 1, model: 'walkway', seed: 3 });
    ask(host, { type: 'run', id: 2, until: 4 });
    const { reply, transfer } = host.handle({ type: 'snapshot', id: 3 });
    const snapshot = snapshotOf(reply);
    expect(snapshot.time).toBe(4);
    expect(snapshot.populations).toHaveLength(1);
    const [walkers] = snapshot.populations;
    if (walkers === undefined || built.walkers === undefined) throw new Error('no snapshot');
    expect(walkers.population).toBe('walkers');
    expect([...walkers.ids]).toEqual([...built.walkers.ids()]);
    expect([...walkers.states]).toEqual([...built.walkers.stateCodes()]);
    expect(transfer).toEqual([walkers.buffer]);
  });

  it('gives no snapshot while both buffers of a population are lent, and takes buffers back', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    ask(host, { type: 'build', id: 1, model: 'walkway' });
    const first = snapshotOf(ask(host, { type: 'snapshot', id: 2 }));
    snapshotOf(ask(host, { type: 'snapshot', id: 3 }));
    expect(ask(host, { type: 'snapshot', id: 4 })).toEqual({
      type: 'error',
      id: 4,
      code: 'INVALID_STATE',
      message: containing('lent'),
    });

    // As a viewer returns them: the snapshots it got, with their buffers transferred back.
    const { reply, transfer } = host.handle({ type: 'release', id: 5, snapshots: first.populations });
    expect(reply).toEqual({ type: 'released', id: 5 });
    expect(transfer).toEqual([]);
    const third = snapshotOf(ask(host, { type: 'snapshot', id: 6 }));
    expect(third.populations[0]?.buffer).toBe(first.populations[0]?.buffer);
  });

  it('refuses to take back a snapshot of a population it does not have', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    ask(host, { type: 'build', id: 1, model: 'walkway' });
    const reply = ask(host, {
      type: 'release',
      id: 2,
      snapshots: [{ population: 'strangers', slot: 0, buffer: new ArrayBuffer(8) }],
    });
    expect(reply).toMatchObject({ type: 'error', code: 'INVALID_ARGUMENT', message: containing('"strangers"') });
  });
});

describe('kernel host: parameters', () => {
  it('changes a parameter that the model reads while it runs', () => {
    const built: Partial<Built> = {};
    const host = new KernelHost({ walkway: walkwayModel(built) });
    ask(host, { type: 'build', id: 1, model: 'walkway', seed: 3 });
    ask(host, { type: 'run', id: 2, until: 2 });
    expect(ask(host, { type: 'set', id: 3, parameter: 'speed', value: 5 })).toEqual({
      type: 'set',
      id: 3,
      parameter: 'speed',
      value: 5,
    });
    expect(built.parameters?.speed).toBe(5);
    // A walker that enters now crosses the walkway at the new speed: at most √(10² + 4²) / 5 ≈ 2.15
    // units of time, where the old speed would take at least 10 / 2 = 5.
    ask(host, { type: 'run', id: 4, until: 3 });
    const newest = built.walkers?.agents.at(-1);
    expect(newest?.createdAt).toBeGreaterThan(2);
    const created = newest?.createdAt ?? Number.NaN;
    ask(host, { type: 'run', id: 5, until: created + Math.hypot(10, 4) / 5 });
    expect(newest?.removed).toBe(true);
  });

  it('refuses unknown parameters and values that are not finite numbers', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    expect(ask(host, { type: 'build', id: 1, model: 'walkway', parameters: { sped: 3 } })).toMatchObject({
      type: 'error',
      code: 'INVALID_ARGUMENT',
      message: containing('"sped"'),
    });
    ask(host, { type: 'build', id: 2, model: 'walkway' });
    expect(ask(host, { type: 'set', id: 3, parameter: 'colour', value: 1 })).toMatchObject({
      type: 'error',
      code: 'INVALID_ARGUMENT',
      message: containing('arrivalsPerUnit, speed'),
    });
    expect(ask(host, { type: 'set', id: 4, parameter: 'speed', value: Number.NaN })).toMatchObject({
      type: 'error',
      code: 'NOT_A_NUMBER',
    });
  });
});

describe('kernel host: errors', () => {
  it('answers a request it cannot do with an error, and goes on serving', () => {
    const host = new KernelHost({ walkway: walkwayModel() });
    expect(ask(host, { type: 'build', id: 1, model: 'shop' })).toMatchObject({
      type: 'error',
      code: 'INVALID_ARGUMENT',
      message: containing('"shop"'),
    });
    expect(ask(host, { type: 'run', id: 2, until: 1 })).toMatchObject({ type: 'error', code: 'INVALID_STATE' });
    expect(ask(host, { type: 'snapshot', id: 3 })).toMatchObject({ type: 'error', code: 'INVALID_STATE' });
    ask(host, { type: 'build', id: 4, model: 'walkway' });
    ask(host, { type: 'run', id: 5, until: 2 });
    expect(ask(host, { type: 'run', id: 6, until: 1 })).toMatchObject({ type: 'error', code: 'INVALID_ARGUMENT' });
    const unknown = { type: 'jump', id: 7 } as unknown as KernelRequest;
    expect(ask(host, unknown)).toMatchObject({ type: 'error', code: 'INVALID_ARGUMENT', message: containing('jump') });
    expect(ask(host, { type: 'run', id: 8, until: 3 })).toMatchObject({ type: 'ran', time: 3 });
  });

  it('passes on the error of a model that fails while it runs, with its code', () => {
    const failing: ModelDefinition = {
      build({ simulation }) {
        const chart = defineStatechart({
          initial: 'walking',
          states: {
            walking: {
              on: {
                'agent.arrived': {
                  actions: () => {
                    throw new Error('tripped');
                  },
                },
              },
            },
          },
        });
        const walkers = new AgentPopulation(simulation, { name: 'walkers', statechart: chart });
        walkers.add().moveTo({ x: 1, y: 0 }, { speed: 1 });
        return { populations: [walkers] };
      },
    };
    const host = new KernelHost({ failing });
    expect(ask(host, { type: 'build', id: 1, model: 'failing' })).toMatchObject({ parameters: {} });
    expect(ask(host, { type: 'run', id: 2, until: 2 })).toMatchObject({
      type: 'error',
      code: 'AGENT_FAILED',
      message: containing('tripped'),
    });
  });
});
