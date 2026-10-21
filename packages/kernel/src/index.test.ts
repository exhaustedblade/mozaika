import { describe, expect, it } from 'vitest';

import * as kernel from './index.js';

describe('@mozaika/kernel', () => {
  it('exposes its package name', () => {
    expect(kernel.PACKAGE_NAME).toBe('@mozaika/kernel');
  });

  it('exports the public API and nothing internal', () => {
    expect(Object.keys(kernel).sort()).toEqual([
      'Agent',
      'AgentPopulation',
      'MAX_STATES',
      'PACKAGE_NAME',
      'Process',
      'Random',
      'Signal',
      'SignalWait',
      'Simulation',
      'SimulationError',
      'Statechart',
      'Timeout',
      'defineStatechart',
      'rate',
      'timeout',
    ]);
  });

  it('runs a small model end to end', () => {
    const sim = new kernel.Simulation({ seed: 1 });
    const done = sim.signal('done');
    const log: string[] = [];
    function* worker(): kernel.ProcessBody {
      yield kernel.timeout(2);
      done.notify('finished');
    }
    function* boss(): kernel.ProcessBody {
      const news = yield done.wait();
      log.push(`${String(news)} at ${String(sim.now)}`);
    }
    sim.process(worker());
    sim.process(boss());
    expect(sim.run()).toEqual({ reason: 'empty', time: 2, events: 4 });
    expect(log).toEqual(['finished at 2']);
  });
});
