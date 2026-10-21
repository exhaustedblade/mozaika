import { describe, expect, it } from 'vitest';

import { AgentPopulation } from './agents/population.js';
import { defineStatechart, rate } from './agents/statechart.js';
import type { EventHandle } from './event-queue.js';
import { type ProcessBody, timeout } from './process.js';
import { Simulation } from './simulation.js';
import { describeEvent } from './test-helpers.js';
import { fingerprint } from './test-support/index.js';

/**
 * A crowd of 2 000 agents: each wakes up at random, works for a random time
 * and rests. Every two units of time a bell calls everyone at once: a resting
 * agent comes exactly one unit later, a working one stops and rests. With the
 * bell, the model schedules three chimes of different priorities for the
 * moment the called agents come. So the queue holds thousands of events, and
 * thousands of them are simultaneous: the messages of each bell, the arrivals
 * one unit later among the chimes, and timers cancelled by the bell.
 */
function traceOfCrowd(seed: number): string[] {
  const trace: string[] = [];
  const sim = new Simulation({ seed, trace: (event) => trace.push(describeEvent(event)) });
  const member = defineStatechart(
    {
      initial: 'resting',
      states: {
        resting: { after: { wake: 'working' }, on: { bell: 'called' } },
        called: { after: { 1: 'working' } },
        working: { after: { work: 'resting' }, on: { bell: 'resting' } },
      },
    },
    { delays: { wake: rate(0.5), work: rate(2) } },
  );
  const crowd = new AgentPopulation(sim, { name: 'crowd', statechart: member });
  for (let i = 0; i < 2_000; i++) crowd.add();
  function* bell(): ProcessBody {
    for (;;) {
      yield timeout(2);
      for (const agent of crowd.agents) agent.send({ type: 'bell' });
      for (const priority of [1, 0, -1]) {
        sim.schedule(
          1,
          () => {
            /* only its place in the trace matters */
          },
          { priority, label: `chime ${String(priority)}` },
        );
      }
    }
  }
  sim.process(bell(), { name: 'bell' });
  sim.run(20);
  return trace;
}

/**
 * A timetable of 20 000 model events on a grid of quarter units, with three
 * priorities: each event that fires schedules another one up to two units
 * later on the same grid, and every fifth cancels a pending one. Hundreds of
 * events share each moment of the grid.
 */
function traceOfTimetable(seed: number): string[] {
  const trace: string[] = [];
  const sim = new Simulation({ seed, trace: (event) => trace.push(describeEvent(event)) });
  const random = sim.random.stream('timetable');
  const handles: EventHandle[] = [];
  let fired = 0;
  const onTime = (): void => {
    fired++;
    handles.push(scheduleOne(Math.floor(random.uniform(0, 9)) / 4));
    if (fired % 5 === 0) {
      const index = Math.floor(random.uniform(0, handles.length));
      handles[index]?.cancel();
    }
  };
  function scheduleOne(delay: number): EventHandle {
    const priority = Math.floor(random.uniform(-1, 2));
    return sim.schedule(delay, onTime, { priority, label: `p${String(priority)}` });
  }
  for (let i = 0; i < 20_000; i++) handles.push(scheduleOne(Math.floor(random.uniform(0, 100)) / 4));
  sim.run(40);
  return trace;
}

describe('traces of large queues with masses of simultaneous events', () => {
  // Recorded with the indexed 4-ary heap (commit cfe3d55, before Ф0-4д): any
  // implementation of the queue must fire the same events in the same order
  // and give them the same numbers.

  it('fire a crowd of agents called at once as before Ф0-4д', () => {
    const trace = traceOfCrowd(2026);
    expect({ events: trace.length, fingerprint: fingerprint(trace) }).toEqual({
      events: 59_982,
      fingerprint: 'eb6c33a1',
    });
  });

  it('fire a timetable of model events on a grid as before Ф0-4д', () => {
    const trace = traceOfTimetable(2026);
    expect({ events: trace.length, fingerprint: fingerprint(trace) }).toEqual({
      events: 368_059,
      fingerprint: '3027b984',
    });
  });
});
