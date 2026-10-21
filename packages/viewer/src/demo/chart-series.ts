/**
 * The points of the demo's charts from the model's records (docs/ARCHITECTURE.md,
 * "Показ"): each record holds totals since the start, so the mean over the
 * last interval is a difference of two records, and the mean since the start
 * is a total over the time.
 */
import type { Snapshot } from '@mozaika/kernel';

import type { ServicePointRecord } from '../models/service-point.js';

/** One measure at one record: over the interval since the record before, and since the start. */
export interface ChartPoint {
  readonly time: number;
  /** Undefined where nothing happened in the interval that the measure averages, e.g. nobody left. */
  readonly lastInterval: number | undefined;
  readonly sinceStart: number | undefined;
}

/** The points of the three charts of the demo at one record. */
export interface ChartPoints {
  /** People in the line, time-averaged. */
  readonly queue: ChartPoint;
  /** Busy windows over open windows, time-averaged. */
  readonly utilization: ChartPoint;
  /** Mean time in the system of the people who left. */
  readonly timeInSystem: ChartPoint;
}

/** The points of `record`, with `previous` the record before it (undefined for the first). */
export function chartPoints(
  previous: Snapshot<ServicePointRecord> | undefined,
  record: Snapshot<ServicePointRecord>,
): ChartPoints {
  const { time, data } = record;
  const before = previous?.data;
  const interval = previous === undefined ? 0 : time - previous.time;
  const left = before === undefined ? 0 : data.left - before.left;
  return {
    queue: {
      time,
      lastInterval: ratio(data.lineArea - (before?.lineArea ?? 0), interval),
      sinceStart: ratio(data.lineArea, time),
    },
    utilization: {
      time,
      lastInterval: ratio(data.busyArea - (before?.busyArea ?? 0), interval * data.windows),
      sinceStart: ratio(data.busyArea, time * data.windows),
    },
    timeInSystem: {
      time,
      lastInterval: ratio(data.timeOfLeft - (before?.timeOfLeft ?? 0), left),
      sinceStart: ratio(data.timeOfLeft, data.left),
    },
  };
}

function ratio(total: number, over: number): number | undefined {
  return over > 0 ? total / over : undefined;
}
