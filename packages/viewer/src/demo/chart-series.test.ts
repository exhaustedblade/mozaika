import { Simulation } from '@mozaika/kernel';
import { describe, expect, it } from 'vitest';

import { buildServicePoint, SERVICE_POINT_DEFAULTS } from '../models/service-point.js';
import { chartPoints } from './chart-series.js';

describe('points of the demo charts', () => {
  const model = buildServicePoint(new Simulation({ seed: 5 }), SERVICE_POINT_DEFAULTS);
  model.simulation.run(300);
  const records = model.records.take();

  it('average each measure since the start as the blocks and the pool do', () => {
    const last = records.at(-1);
    if (last === undefined) throw new Error('no records');
    const points = chartPoints(records.at(-2), last);
    expect(points.queue.sinceStart).toBeCloseTo(model.line.stats.length.mean, 12);
    expect(points.utilization.sinceStart).toBeCloseTo(model.windows.utilization, 12);
    expect(points.timeInSystem.sinceStart).toBeCloseTo(model.out.stats.timeInSystem.mean, 12);
  });

  it('average the intervals so that they add up to the mean since the start', () => {
    let queueArea = 0;
    let busyFraction = 0;
    records.forEach((record, index) => {
      const previous = records[index - 1];
      if (previous === undefined) return;
      const points = chartPoints(previous, record);
      const interval = record.time - previous.time;
      queueArea += (points.queue.lastInterval ?? 0) * interval;
      busyFraction += (points.utilization.lastInterval ?? 0) * interval;
    });
    const end = records.at(-1)?.time ?? Number.NaN;
    expect(queueArea / end).toBeCloseTo(model.line.stats.length.mean, 9);
    expect(busyFraction / end).toBeCloseTo(model.windows.utilization, 9);
  });

  it('leave a gap where the measure has nothing to average', () => {
    const first = records[0];
    if (first === undefined) throw new Error('no records');
    expect(chartPoints(undefined, first)).toEqual({
      queue: { time: 0, lastInterval: undefined, sinceStart: undefined },
      utilization: { time: 0, lastInterval: undefined, sinceStart: undefined },
      timeInSystem: { time: 0, lastInterval: undefined, sinceStart: undefined },
    });
  });
});
