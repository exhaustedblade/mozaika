import { type EventInfo, Simulation } from '@mozaika/kernel';
import { fingerprint } from '@mozaika/kernel/test-support';
import { describe, expect, it } from 'vitest';

import { Delay, Queue, ResourcePool, Service, Sink, Source } from './index.js';

/**
 * A flow that uses every block and the kernel features under them: random
 * intervals and durations, a full Queue and Delay (blocking), two units of a
 * pool handed over in FIFO order, lost arrivals. Returns the trace of every
 * event as "time priority #seq label".
 */
function runFlow(seed: number): string[] {
  const trace: string[] = [];
  const traceLine = (event: EventInfo): string =>
    `${String(event.time)} ${String(event.priority)} #${String(event.seq)} ${event.label ?? ''}`;
  const sim = new Simulation({ seed, trace: (event) => trace.push(traceLine(event)) });
  const clerks = new ResourcePool(sim, { name: 'clerks', capacity: 2 });
  const source = new Source(sim, { name: 'door', interval: (random) => random.exponential(0.6) });
  const hall = source.connect(new Queue(sim, { name: 'hall', capacity: 4 }));
  const desk = hall.connect(
    new Service(sim, { name: 'desk', pool: clerks, duration: (random) => random.exponential(1.1), capacity: 2 }),
  );
  const corridor = desk.connect(
    new Delay(sim, { name: 'corridor', duration: (random) => random.uniform(0, 3), capacity: 3 }),
  );
  corridor.connect(new Sink(sim, { name: 'exit' }));
  sim.run(300);
  return trace;
}

describe('blocks on the kernel', () => {
  it('fire the same events with the same numbers as on the kernel of Ф0-4', () => {
    // Recorded with the kernel of commit 47903fe, before the event queue moved
    // to typed arrays (Ф0-4б); the blocks have not changed since.
    const trace = runFlow(2026);
    expect({ events: trace.length, fingerprint: fingerprint(trace) }).toEqual({
      events: 2200,
      fingerprint: 'e267f3ce',
    });
  });
});
