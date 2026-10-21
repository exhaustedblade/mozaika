import { describe, expect, it } from 'vitest';

import { Random } from '../random.js';
import { Simulation } from '../simulation.js';
import { containing, simulationError } from '../test-helpers.js';
import { Agent } from './agent.js';
import { AgentPopulation } from './population.js';
import { defineStatechart, type Statechart } from './statechart.js';

const twoStates = defineStatechart({ initial: 'a', states: { a: { on: { go: 'b' } }, b: { on: { back: 'a' } } } });

describe('agent populations', () => {
  it('numbers agents 1, 2, 3 in creation order and records when each was created', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    agents.add();
    sim.run(2.5);
    agents.add();
    expect(agents.size).toBe(2);
    expect(agents.agents.map((agent) => [agent.id, agent.createdAt])).toEqual([
      [1, 0],
      [2, 2.5],
    ]);
    expect(agents.agents[0]).toBeInstanceOf(Agent);
    expect(agents.agents[0]?.population).toBe(agents);
  });

  it('gives every agent its own copy of the fields, with overrides', () => {
    const sim = new Simulation();
    const chart = defineStatechart({ initial: 'a', context: { patience: 2, visits: 0 }, states: { a: {} } });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const first = agents.add();
    const second = agents.add({ patience: 5 });
    first.context.visits++;
    expect(first.context).toEqual({ patience: 2, visits: 1 });
    expect(second.context).toEqual({ patience: 5, visits: 0 });
  });

  it('builds the fields with a function, given the id, the time and the stream of the population', () => {
    const seed = 3;
    const sim = new Simulation({ seed });
    const chart = defineStatechart({
      initial: 'a',
      context: ({ id, now, random }) => ({
        label: `customer ${String(id)} at ${String(now)}`,
        mood: random.uniform(),
        tags: [] as string[],
      }),
      states: { a: {} },
    });
    const agents = new AgentPopulation(sim, { name: 'customers', statechart: chart });
    const first = agents.add();
    const second = agents.add();
    first.context.tags.push('vip');
    const stream = new Random(seed, ['agents', 'customers']);
    expect(first.context).toEqual({ label: 'customer 1 at 0', mood: stream.uniform(), tags: ['vip'] });
    expect(second.context).toEqual({ label: 'customer 2 at 0', mood: stream.uniform(), tags: [] });
  });

  it('counts agents per state and gives the state codes as a dense array', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    for (let i = 0; i < 5; i++) agents.add();
    agents.agents[1]?.send({ type: 'go' });
    agents.agents[3]?.send({ type: 'go' });
    sim.run();
    expect([agents.count('a'), agents.count('b')]).toEqual([3, 2]);
    const codes = agents.stateCodes();
    expect(codes).toBeInstanceOf(Uint16Array);
    expect([...codes]).toEqual([0, 1, 0, 1, 0]);
    expect(twoStates.stateNames[codes[1] ?? -1]).toBe('b');
    // A copy: later transitions do not change it.
    agents.agents[1]?.send({ type: 'back' });
    sim.run();
    expect([...codes]).toEqual([0, 1, 0, 1, 0]);
    expect([...agents.stateCodes()]).toEqual([0, 0, 0, 1, 0]);
  });

  it('keeps the dense array as it grows past its first size', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    for (let i = 0; i < 5000; i++) agents.add();
    agents.agents[4999]?.send({ type: 'go' });
    sim.run();
    const codes = agents.stateCodes();
    expect(codes).toHaveLength(5000);
    expect(codes[4999]).toBe(1);
    expect(agents.count('a')).toBe(4999);
  });

  it('gives the ids and the state codes as columns in the same order, by region of the statechart', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    for (let i = 0; i < 3; i++) agents.add();
    agents.agents[2]?.send({ type: 'go' });
    sim.run();
    const ids = agents.ids();
    expect(ids).toBeInstanceOf(Float64Array);
    expect([...ids]).toEqual([1, 2, 3]);
    // One region for now: parallel states are not supported yet (docs/AGENTS.md, section 6).
    expect(twoStates.regionCount).toBe(1);
    expect([...agents.stateCodes(0)]).toEqual([0, 0, 1]);
    expect(() => agents.stateCodes(1)).toThrow(simulationError('INVALID_ARGUMENT', { message: containing('region') }));
    // Copies: later changes do not show in them.
    agents.add();
    expect([...ids]).toEqual([1, 2, 3]);
  });

  it('refuses invalid options and calls', () => {
    const sim = new Simulation();
    expect(() => new AgentPopulation(sim, { name: '', statechart: twoStates })).toThrow(
      simulationError('INVALID_ARGUMENT'),
    );
    expect(() => new AgentPopulation(sim, { name: 'x', statechart: {} as Statechart })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('defineStatechart') }),
    );
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    expect(() => agents.count('c')).toThrow(simulationError('INVALID_ARGUMENT', { message: containing('"c"') }));
    expect(() => agents.add(5 as unknown as object)).toThrow(simulationError('INVALID_ARGUMENT'));
  });

  it('refuses a second population with the same name in one simulation', () => {
    const sim = new Simulation();
    new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    expect(() => new AgentPopulation(sim, { name: 'agents', statechart: twoStates })).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('"agents"') }),
    );
    // A population refused for a bad option does not keep its name.
    expect(() => new AgentPopulation(sim, { name: 'other', statechart: {} as Statechart })).toThrow();
    expect(() => new AgentPopulation(sim, { name: 'other', statechart: twoStates })).not.toThrow();
    // Another simulation has its own names.
    expect(() => new AgentPopulation(new Simulation(), { name: 'agents', statechart: twoStates })).not.toThrow();
  });
});

describe('agent populations: removing agents', () => {
  it('puts the last agent in the place of the removed one and keeps the columns in step', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    for (let i = 0; i < 5; i++) agents.add();
    agents.agents[3]?.send({ type: 'go' });
    agents.agents[4]?.send({ type: 'go' });
    sim.run();
    const second = agents.agents[1];
    if (second === undefined) throw new Error('agent 2 is missing');

    expect(agents.remove(second)).toBe(true);
    expect(agents.size).toBe(4);
    expect(agents.agents.map((agent) => agent.id)).toEqual([1, 5, 3, 4]);
    expect([...agents.ids()]).toEqual([1, 5, 3, 4]);
    expect([...agents.stateCodes()]).toEqual([0, 1, 0, 1]);
    expect([agents.count('a'), agents.count('b')]).toEqual([2, 2]);
    expect(second.removed).toBe(true);
    expect(agents.agents.every((agent) => !agent.removed)).toBe(true);

    // The last agent leaves without moving anyone.
    const last = agents.agents[3];
    if (last === undefined) throw new Error('agent 4 is missing');
    agents.remove(last);
    expect([...agents.ids()]).toEqual([1, 5, 3]);
    expect([...agents.stateCodes()]).toEqual([0, 1, 0]);
    // New agents get new ids: an id is never reused.
    expect(agents.add().id).toBe(6);
  });

  it('cancels the timeouts of a removed agent and keeps those of the agent moved into its place', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart(
      {
        initial: 'a',
        context: { wait: 1 },
        states: {
          // Two timeouts per state, so that both of the moved agent's must follow it.
          a: { after: { wait: 'b', 100: 'never' } },
          b: { entry: ({ agent, now }) => log.push(`${String(now)} agent ${String(agent.id)}`) },
          never: {},
        },
      },
      { delays: { wait: ({ context }) => context.wait } },
    );
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    agents.add({ wait: 1 });
    const removed = agents.add({ wait: 2 });
    agents.add({ wait: 3 });
    expect(sim.pendingEvents).toBe(6);

    agents.remove(removed);
    expect(sim.pendingEvents).toBe(4);
    sim.run();
    expect(log).toEqual(['1 agent 1', '3 agent 3']);
    expect(sim.pendingEvents).toBe(0);
    // A removed agent keeps the state it had when it was removed.
    expect(removed.state).toBe('a');
    expect(removed.done).toBe(false);
  });

  it('discards the messages of a removed agent and counts them', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    const leaving = agents.add();
    const staying = agents.add();
    leaving.send({ type: 'go' }); // sent before the removal, delivered after it
    staying.send({ type: 'go' }); // to the agent that moves into the place of the removed one
    agents.remove(leaving);
    leaving.send({ type: 'go' }); // sent after the removal
    sim.run();
    expect(agents.discardedMessages).toBe(2);
    expect(leaving.state).toBe('a');
    expect(staying.state).toBe('b');
  });

  it('lets an agent remove itself: it leaves at the end of its step', () => {
    const sim = new Simulation();
    const log: string[] = [];
    const chart = defineStatechart({
      initial: 'inside',
      states: {
        inside: { on: { leave: 'gone' } },
        gone: {
          type: 'final',
          entry: ({ agent }) => {
            agent.population.remove(agent);
            log.push(`removed during the step: ${String(agent.removed)}`);
          },
        },
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    const agent = agents.add();
    agents.add();
    agent.send({ type: 'leave' });
    sim.run();
    expect(log).toEqual(['removed during the step: false']);
    expect(agent.removed).toBe(true);
    expect([agent.state, agent.done]).toEqual(['gone', true]);
    expect([...agents.ids()]).toEqual([2]);
    expect(agents.count('gone')).toBe(0);
  });

  it('checks every agent left once when population.check() removes agents on the way', () => {
    const sim = new Simulation();
    const checked: number[] = [];
    let open = false;
    const chart = defineStatechart({
      initial: 'closed',
      states: {
        closed: {
          always: {
            guard: () => open,
            target: 'open',
            actions: ({ agent }) => {
              checked.push(agent.id);
              // The first agent to open removes the last one: it must not be checked.
              const others = agent.population.agents;
              const last = others[others.length - 1];
              if (agent.id === 1 && last !== undefined) agent.population.remove(last);
            },
          },
        },
        open: {},
      },
    });
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: chart });
    for (let i = 0; i < 4; i++) agents.add();
    open = true;
    agents.check();
    expect(checked).toEqual([1, 2, 3]);
    expect(agents.count('open')).toBe(3);
  });

  it('removes an agent only once and only from its own population', () => {
    const sim = new Simulation();
    const agents = new AgentPopulation(sim, { name: 'agents', statechart: twoStates });
    const others = new AgentPopulation(sim, { name: 'others', statechart: twoStates });
    const agent = agents.add();
    const stranger = others.add();
    expect(() => agents.remove(stranger)).toThrow(
      simulationError('INVALID_ARGUMENT', { message: containing('"others"') }),
    );
    expect(() => agents.remove({} as typeof agent)).toThrow(simulationError('INVALID_ARGUMENT'));
    expect(agents.remove(agent)).toBe(true);
    expect(agents.remove(agent)).toBe(false);
    expect(agents.size).toBe(0);
    // A removed agent no longer reacts to checks.
    agent.check();
    expect(agent.state).toBe('a');
  });
});
