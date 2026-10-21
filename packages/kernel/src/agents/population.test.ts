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
