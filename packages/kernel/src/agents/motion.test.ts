import { describe, expect, it } from 'vitest';

import { Simulation } from '../simulation.js';
import { containing, describeEvent, simulationError } from '../test-helpers.js';
import type { Agent } from './agent.js';
import type { Point } from './motion.js';
import { AgentPopulation } from './population.js';
import { defineStatechart } from './statechart.js';

/** A statechart without transitions: the tests move its agents from outside. */
const still = defineStatechart({ initial: 'here', states: { here: {} } });

/** A walker goes from `walking` to `arrived` when it arrives. */
const walker = defineStatechart({
  initial: 'walking',
  states: { walking: { on: { 'agent.arrived': 'arrived' } }, arrived: {} },
});

/**
 * Where an agent on a segment is at `time`, written out again from
 * docs/AGENTS.md, section 9, so the kernel is checked against the
 * formula and not against itself.
 */
function onSegment(from: Point, to: Point, start: number, arrival: number, time: number): Point {
  if (time >= arrival) return { x: to.x, y: to.y };
  const k = (time - start) / (arrival - start);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
}

/** Records the position of `agent` at each of `times`, read inside events of the model at those times. */
function positionsAt(sim: Simulation, agent: Agent, times: readonly number[]): Point[] {
  const seen: Point[] = [];
  for (const time of times) {
    sim.scheduleAt(time, () => seen.push(agent.position));
  }
  return seen;
}

function tracedSimulation(): { sim: Simulation; trace: string[] } {
  const trace: string[] = [];
  const sim = new Simulation({ trace: (event) => trace.push(describeEvent(event)) });
  return { sim, trace };
}

describe('movement: positions', () => {
  it('puts a new agent at the origin, standing', () => {
    const sim = new Simulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: still }).add();
    expect(agent.position).toEqual({ x: 0, y: 0 });
    expect(agent.moving).toBe(false);
    expect(sim.pendingEvents).toBe(0);
  });

  it('places an agent at a point without an event', () => {
    const sim = new Simulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: still }).add();
    agent.placeAt({ x: 3, y: -4 });
    expect(agent.position).toEqual({ x: 3, y: -4 });
    expect(agent.moving).toBe(false);
    expect(sim.pendingEvents).toBe(0);
    sim.run(10);
    expect(agent.position).toEqual({ x: 3, y: -4 });
  });

  it('gives the position by the formula of the segment at any moment, and the target exactly on arrival', () => {
    const sim = new Simulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: still }).add();
    const from = { x: 0.1, y: 0.7 };
    const to = { x: 2.9, y: -1.3 };
    agent.placeAt(from);
    sim.run(0.3);
    agent.moveTo(to, { speed: 0.7 });
    const arrival = 0.3 + Math.hypot(to.x - from.x, to.y - from.y) / 0.7;
    const times = [0.3, 0.31, 1, 2.2, 3.7, arrival - 1e-9, arrival, arrival + 1, 100];
    const seen = positionsAt(sim, agent, times);
    expect(agent.moving).toBe(true);
    sim.run();
    expect(seen).toEqual(times.map((time) => onSegment(from, to, 0.3, arrival, time)));
    // From the moment of arrival on, the target exactly, not the formula at k = 1.
    expect(seen.slice(6)).toEqual([to, to, to]);
    expect(agent.moving).toBe(false);
  });

  it('moves for a given duration as well as at a given speed', () => {
    const sim = new Simulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: walker }).add();
    agent.moveTo({ x: 10, y: 0 }, { duration: 4 });
    const seen = positionsAt(sim, agent, [1, 3]);
    sim.run(3.999);
    expect(agent.state).toBe('walking');
    sim.run(4);
    expect(agent.state).toBe('arrived');
    expect(seen).toEqual([
      { x: 2.5, y: 0 },
      { x: 7.5, y: 0 },
    ]);
  });

  it('gives the positions of the whole population at once, in the order of the columns', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: still });
    const first = agents.add();
    const second = agents.add();
    const third = agents.add();
    first.moveTo({ x: 8, y: 6 }, { speed: 2 });
    second.placeAt({ x: -1, y: 1 });
    third.moveTo({ x: 0, y: 3 }, { duration: 6 });
    sim.run(2.5);
    const positions = agents.positions();
    expect(positions).toBeInstanceOf(Float64Array);
    expect([...positions]).toEqual([
      ...Object.values(onSegment({ x: 0, y: 0 }, { x: 8, y: 6 }, 0, 5, 2.5)),
      -1,
      1,
      ...Object.values(onSegment({ x: 0, y: 0 }, { x: 0, y: 3 }, 0, 6, 2.5)),
    ]);
    expect([...positions]).toEqual(agents.agents.flatMap((agent) => [agent.position.x, agent.position.y]));
  });

  it('gives zeros for a population whose agents have never moved', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: still });
    agents.add();
    agents.add();
    expect([...agents.positions()]).toEqual([0, 0, 0, 0]);
  });

  it('keeps the segments as the population grows past the first size of its columns', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: still });
    agents.add().moveTo({ x: 4, y: 0 }, { duration: 4 });
    for (let i = 0; i < 5000; i++) agents.add().placeAt({ x: i, y: -i });
    sim.run(1);
    expect(agents.agents[0]?.position).toEqual({ x: 1, y: 0 });
    expect(agents.agents[5000]?.position).toEqual({ x: 4999, y: -4999 });
    const positions = agents.positions();
    expect(positions).toHaveLength(2 * 5001);
    expect([positions[0], positions[10000], positions[10001]]).toEqual([1, 4999, -4999]);
  });
});

describe('movement: arrival', () => {
  it('fires exactly one event, at the arrival, and the agent takes the transition on agent.arrived', () => {
    const { sim, trace } = tracedSimulation();
    const events: string[] = [];
    const chart = defineStatechart({
      initial: 'walking',
      states: {
        walking: {
          on: {
            'agent.arrived': {
              target: 'arrived',
              actions: ({ event, now }) => events.push(`${event.type} at ${String(now)}`),
            },
          },
        },
        arrived: {},
      },
    });
    const agent = new AgentPopulation(sim, { name: 'walkers', statechart: chart }).add();
    agent.moveTo({ x: 3, y: 4 }, { speed: 2 });
    sim.run();
    expect(trace).toEqual(['2.5 0 #0 walkers#1: arrival']);
    expect(events).toEqual(['agent.arrived at 2.5']);
    expect(agent.state).toBe('arrived');
    expect(agent.position).toEqual({ x: 3, y: 4 });
  });

  it('lets an arrival start the next move, as a walk through several points does', () => {
    const { sim, trace } = tracedSimulation();
    const route = [
      { x: 1, y: 0 },
      { x: 1, y: 2 },
      { x: 4, y: 6 },
    ];
    const chart = defineStatechart({
      initial: 'walking',
      context: { leg: 0 },
      states: {
        walking: {
          entry: ({ agent, context }) => {
            const next = route[context.leg];
            if (next !== undefined) agent.moveTo(next, { speed: 1 });
          },
          on: {
            'agent.arrived': [
              {
                guard: ({ context }) => context.leg + 1 < route.length,
                target: 'walking',
                reenter: true,
                actions: ({ context }) => {
                  context.leg++;
                },
              },
              { target: 'done' },
            ],
          },
        },
        done: { type: 'final' },
      },
    });
    const agent = new AgentPopulation(sim, { name: 'walkers', statechart: chart }).add();
    sim.run();
    expect(trace).toEqual(['1 0 #0 walkers#1: arrival', '3 0 #1 walkers#1: arrival', '8 0 #2 walkers#1: arrival']);
    expect(agent.state).toBe('done');
    expect(agent.position).toEqual({ x: 4, y: 6 });
  });

  it('does nothing on an arrival without a transition, and counts no discarded message', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: still });
    const agent = agents.add();
    agent.moveTo({ x: 1, y: 1 }, { duration: 1 });
    sim.run();
    expect(agent.state).toBe('here');
    expect(agent.position).toEqual({ x: 1, y: 1 });
    expect(agents.discardedMessages).toBe(0);
  });

  it('checks the conditions after an arrival, as after any event of the agent', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'walking',
      states: {
        walking: { always: { guard: ({ agent }) => agent.position.x >= 5, target: 'far' } },
        far: {},
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    agent.moveTo({ x: 5, y: 0 }, { duration: 2 });
    sim.run(1.9);
    expect(agent.state).toBe('walking');
    sim.run();
    expect(agent.state).toBe('far');
  });

  it('moves an agent in a final state, which arrives without a step', () => {
    const sim = new Simulation();
    const chart = defineStatechart({ initial: 'gone', states: { gone: { type: 'final' } } });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    expect(agent.done).toBe(true);
    agent.moveTo({ x: 2, y: 0 }, { speed: 1 });
    sim.run();
    expect(agent.position).toEqual({ x: 2, y: 0 });
    expect(agent.moving).toBe(false);
  });

  it('fires an arrival after no time at the same moment, after the events already due then (П-8)', () => {
    const { sim, trace } = tracedSimulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: walker }).add();
    agent.placeAt({ x: 1, y: 1 });
    sim.schedule(2, () => undefined, { label: 'due first' });
    sim.schedule(
      2,
      () => {
        agent.moveTo({ x: 1, y: 1 }, { speed: 3 });
        expect(agent.moving).toBe(true);
      },
      { label: 'move' },
    );
    sim.schedule(2, () => undefined, { label: 'due before the arrival' });
    sim.run();
    expect(trace).toEqual([
      '2 0 #0 due first',
      '2 0 #1 move',
      '2 0 #2 due before the arrival',
      '2 0 #3 agents#1: arrival',
    ]);
    expect(agent.state).toBe('arrived');
  });

  it('fires simultaneous arrivals in the order the moves began', () => {
    const { sim, trace } = tracedSimulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: walker });
    const [first, second, third] = [agents.add(), agents.add(), agents.add()];
    third?.moveTo({ x: 0, y: 4 }, { speed: 2 });
    first?.moveTo({ x: 2, y: 0 }, { speed: 1 });
    second?.moveTo({ x: 1, y: 0 }, { duration: 2 });
    sim.run();
    expect(trace).toEqual(['2 0 #0 agents#3: arrival', '2 0 #1 agents#1: arrival', '2 0 #2 agents#2: arrival']);
  });
});

describe('movement: cancelling the arrival', () => {
  it('starts a new move from where the agent is and drops the earlier arrival', () => {
    const { sim, trace } = tracedSimulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: walker }).add();
    agent.moveTo({ x: 10, y: 0 }, { duration: 10 });
    sim.run(4);
    expect(sim.pendingEvents).toBe(1);
    agent.moveTo({ x: 4, y: 3 }, { speed: 1 });
    expect(sim.pendingEvents).toBe(1);
    const seen = positionsAt(sim, agent, [5.5, 7]);
    sim.run();
    expect(trace.filter((line) => line.endsWith('arrival'))).toEqual(['7 0 #1 agents#1: arrival']);
    expect(seen).toEqual([onSegment({ x: 4, y: 0 }, { x: 4, y: 3 }, 4, 7, 5.5), { x: 4, y: 3 }]);
    expect(agent.state).toBe('arrived');
  });

  it('drops the arrival when the agent is placed or stopped, and stops it where it is', () => {
    const { sim, trace } = tracedSimulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: walker });
    const placed = agents.add();
    const stopped = agents.add();
    placed.moveTo({ x: 10, y: 0 }, { duration: 10 });
    stopped.moveTo({ x: 0, y: 10 }, { duration: 10 });
    sim.run(2.5);
    placed.placeAt({ x: -5, y: -5 });
    expect(stopped.stop()).toBe(true);
    expect(stopped.stop()).toBe(false);
    expect(sim.pendingEvents).toBe(0);
    sim.run(20);
    expect(trace).toEqual([]);
    expect([placed.position, stopped.position]).toEqual([
      { x: -5, y: -5 },
      { x: 0, y: 2.5 },
    ]);
    expect([placed.state, stopped.state, placed.moving, stopped.moving]).toEqual(['walking', 'walking', false, false]);
  });

  it('stops a move started with stopOnExit when the agent leaves its state, before the exit actions', () => {
    const { sim, trace } = tracedSimulation();
    const exits: string[] = [];
    const chart = defineStatechart({
      initial: 'walking',
      states: {
        walking: {
          entry: ({ agent }) => agent.moveTo({ x: 8, y: 0 }, { duration: 8, stopOnExit: true }),
          exit: ({ agent }) => exits.push(`moving ${String(agent.moving)} at ${String(agent.position.x)}`),
          on: { 'agent.arrived': 'arrived', alarm: 'frozen' },
        },
        frozen: {},
        arrived: {},
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    sim.schedule(3, () => agent.send({ type: 'alarm' }), { label: 'alarm' });
    sim.run();
    expect(exits).toEqual(['moving false at 3']);
    expect(trace).toEqual(['3 0 #1 alarm', '3 0 #2 agents#1: message "alarm"']);
    expect(agent.state).toBe('frozen');
    expect(agent.position).toEqual({ x: 3, y: 0 });
  });

  it('keeps a move without stopOnExit going while the agent changes state', () => {
    const { sim, trace } = tracedSimulation();
    const chart = defineStatechart({
      initial: 'calm',
      states: {
        calm: { on: { alarm: 'worried', 'agent.arrived': 'arrived' } },
        worried: { on: { 'agent.arrived': 'arrived' } },
        arrived: {},
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    agent.moveTo({ x: 8, y: 0 }, { duration: 8 });
    sim.schedule(3, () => agent.send({ type: 'alarm' }), { label: 'alarm' });
    sim.run();
    expect(trace).toEqual(['3 0 #1 alarm', '3 0 #2 agents#1: message "alarm"', '8 0 #0 agents#1: arrival']);
    expect(agent.state).toBe('arrived');
  });

  it('binds a move to the state for one exit only', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { on: { next: 'b' } }, b: { on: { next: 'c' } }, c: {} },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    agent.moveTo({ x: 10, y: 0 }, { duration: 10, stopOnExit: true });
    sim.schedule(2, () => agent.send({ type: 'next' }));
    sim.run(2);
    expect(agent.moving).toBe(false);
    // A new move in state b, not bound: the next exit leaves it going.
    agent.moveTo({ x: 2, y: 5 }, { duration: 5 });
    sim.schedule(1, () => agent.send({ type: 'next' }));
    sim.run();
    expect(agent.state).toBe('c');
    expect(agent.position).toEqual({ x: 2, y: 5 });
  });

  it('cancels the arrival of a removed agent, and the agent moved into its row keeps its own', () => {
    const { sim, trace } = tracedSimulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: walker });
    const first = agents.add();
    const removed = agents.add();
    const last = agents.add();
    first.moveTo({ x: 1, y: 0 }, { duration: 1 });
    removed.moveTo({ x: 2, y: 0 }, { duration: 2 });
    last.moveTo({ x: 0, y: 3 }, { duration: 3 });
    sim.run(0.5);
    agents.remove(removed);
    expect(sim.pendingEvents).toBe(2);
    expect(removed.moving).toBe(false);
    // The last agent took the row of the removed one, with its segment.
    expect([...agents.ids()]).toEqual([1, 3]);
    expect([...agents.positions()]).toEqual([
      ...Object.values(onSegment({ x: 0, y: 0 }, { x: 1, y: 0 }, 0, 1, 0.5)),
      ...Object.values(onSegment({ x: 0, y: 0 }, { x: 0, y: 3 }, 0, 3, 0.5)),
    ]);
    sim.run();
    expect(trace).toEqual(['1 0 #0 agents#1: arrival', '3 0 #2 agents#3: arrival']);
    expect([first.state, removed.state, last.state]).toEqual(['arrived', 'walking', 'arrived']);
    expect(last.position).toEqual({ x: 0, y: 3 });
  });

  it('cancels the arrival of an agent that removes itself, at the end of its step', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'walking',
      states: {
        walking: { on: { leave: 'gone' } },
        gone: {
          type: 'final',
          entry: ({ agent }) => {
            agent.moveTo({ x: 9, y: 9 }, { speed: 1 });
            agent.population.remove(agent);
          },
        },
      },
    });
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: chart }).add();
    agent.send({ type: 'leave' });
    sim.run();
    expect(agent.removed).toBe(true);
    expect(sim.pendingEvents).toBe(0);
    expect(sim.eventsProcessed).toBe(1);
  });
});

describe('movement: errors', () => {
  it('refuses bad points and options', () => {
    const sim = new Simulation();
    const agent = new AgentPopulation(sim, { name: 'agents', statechart: still }).add();
    const target = { x: 1, y: 1 };
    expect(() => agent.moveTo({ x: Number.NaN, y: 0 }, { speed: 1 })).toThrow(simulationError('NOT_A_NUMBER'));
    expect(() => agent.moveTo({ x: 0, y: Infinity }, { speed: 1 })).toThrow(simulationError('NOT_FINITE'));
    expect(() => agent.moveTo({ x: '1', y: 0 } as unknown as Point, { speed: 1 })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('moveTo() point') }),
    );
    expect(() => agent.placeAt(undefined as unknown as Point)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => agent.moveTo(target, {})).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('speed or duration') }),
    );
    expect(() => agent.moveTo(target, { speed: 1, duration: 1 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => agent.moveTo(target, { speed: 0 })).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(() => agent.moveTo(target, { speed: Infinity })).toThrow(simulationError('NOT_FINITE'));
    expect(() => agent.moveTo(target, { duration: -1 })).toThrow(simulationError('NEGATIVE_DELAY'));
    expect(() => agent.moveTo(target, { duration: 1, stopOnExit: 'yes' as unknown as boolean })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    // Nothing refused has moved the agent.
    expect([agent.moving, sim.pendingEvents]).toEqual([false, 0]);
    expect(agent.position).toEqual({ x: 0, y: 0 });
  });

  it('refuses to move a removed agent or to tell where it is', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: still });
    const agent = agents.add();
    agents.remove(agent);
    const removed = simulationError('INVALID_STATE', { message: containing('agents#1') });
    expect(() => agent.moveTo({ x: 1, y: 1 }, { speed: 1 })).toThrow(removed);
    expect(() => agent.placeAt({ x: 1, y: 1 })).toThrow(removed);
    expect(() => agent.stop()).toThrow(removed);
    expect(() => agent.position).toThrow(removed);
    expect(agent.moving).toBe(false);
  });

  it('names the agent when a move inside its step fails', () => {
    const sim = new Simulation();
    const chart = defineStatechart({
      initial: 'a',
      states: { a: { entry: ({ agent }) => agent.moveTo({ x: 1, y: 1 }, { speed: -2 }) } },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    expect(() => agents.add()).toThrow(simulationError('AGENT_FAILED', { message: containing('agents#1') }));
  });
});
