import { describe, expect, it } from 'vitest';

import { type ProcessBody, timeout } from '../process.js';
import { Simulation } from '../simulation.js';
import { describeEvent } from '../test-helpers.js';
import { AgentPopulation } from './population.js';
import { defineStatechart, rate } from './statechart.js';

interface TownRun {
  /** Every fired event: time, priority, seq and label. */
  readonly trace: readonly string[];
  /** Times at which people fell ill. */
  readonly infections: readonly number[];
}

/**
 * A small epidemic: people fall ill at random, infect others by messages,
 * recover after a random time and are immune for a while. A clinic process
 * checks everyone's condition once a day. Uses every agent feature that
 * affects the order of events: rates, named random delays, messages between
 * agents, conditions, explicit checks and a kernel process alongside.
 */
function runTown(seed: number, { withVisitors = false } = {}): TownRun {
  const trace: string[] = [];
  const infections: number[] = [];
  const sim = new Simulation({ seed, trace: (event) => trace.push(describeEvent(event)) });
  let alarm = false;
  const person = defineStatechart(
    {
      initial: 'healthy',
      context: { contacts: 0 },
      states: {
        healthy: {
          after: { exposure: 'ill' },
          on: { cough: { target: 'ill', guard: ({ random }) => random.uniform() < 0.3 } },
        },
        ill: {
          entry: ({ agent, context, now, random }) => {
            infections.push(now);
            const others = agent.population.agents;
            const other = others[Math.floor(random.uniform(0, others.length))];
            if (other !== undefined && other !== agent) {
              context.contacts++;
              other.send({ type: 'cough' });
            }
          },
          after: { recovery: 'immune' },
          always: { guard: () => alarm, target: 'isolated' },
        },
        isolated: { after: { recovery: 'immune' } },
        immune: { after: { 30: 'healthy' } },
      },
    },
    { delays: { exposure: rate(0.01), recovery: ({ random }) => random.uniform(5, 10) } },
  );
  const people = new AgentPopulation(sim, { name: 'people', statechart: person });
  for (let i = 0; i < 200; i++) people.add();

  if (withVisitors) {
    // Another population with its own streams: it must not change what happens to the people.
    const visitor = defineStatechart(
      { initial: 'in', states: { in: { after: { stay: 'out' } }, out: { after: { stay: 'in' } } } },
      { delays: { stay: rate(1) } },
    );
    const visitors = new AgentPopulation(sim, { name: 'visitors', statechart: visitor });
    for (let i = 0; i < 20; i++) visitors.add();
  }

  function* clinic(): ProcessBody {
    for (let day = 1; day <= 100; day++) {
      yield timeout(1);
      alarm = people.count('ill') > 20;
      people.check();
    }
  }
  sim.process(clinic(), { name: 'clinic' });
  sim.run(100);
  return { trace, infections };
}

describe('agents: repeatability by seed', () => {
  it('gives an identical event trace for the same seed', () => {
    const first = runTown(2026);
    const second = runTown(2026);
    expect(first.trace.length).toBeGreaterThan(500);
    expect(first.infections.length).toBeGreaterThan(50);
    expect(second.trace).toEqual(first.trace);
  });

  it('gives a different trace for a different seed', () => {
    expect(runTown(2027).trace).not.toEqual(runTown(2026).trace);
  });

  it('keeps what happens to one population when another population is added', () => {
    const plain = runTown(7);
    const crowded = runTown(7, { withVisitors: true });
    expect(crowded.trace).not.toEqual(plain.trace);
    expect(crowded.infections).toEqual(plain.infections);
  });
});
