/**
 * The laws of the demo "service point" (docs/ARCHITECTURE.md, "Проверка как
 * часть продукта"): what must hold on every record of the model, whatever its
 * parameters. The tests check them on long runs; the demo page shows them live.
 */
import type { Snapshot } from '@mozaika/kernel';

import type { ServicePointRecord } from './service-point.js';

/**
 * Relative rounding allowed in Little's law: the totals are sums of thousands
 * of doubles, whose rounding stays many orders of magnitude below this.
 */
const ROUNDING = 1e-9;

export type LawName = 'balance' | 'little' | 'utilization';

export interface LawCheck {
  readonly law: LawName;
  readonly holds: boolean;
  /** The two sides compared, for the page and for messages: what is, and what the law says. */
  readonly actual: number;
  readonly expected: number;
}

/**
 * The laws on one record:
 * - balance: everyone who came in has left or is in the system, and the people
 *   counted by the blocks are the agents of the population, counted by state;
 * - little: on the sample path, the area under the number in the system equals
 *   the time spent there by those who left plus by those still in (J. D. C.
 *   Little, 1961; exact, up to rounding, at any moment — not only on average);
 * - utilization: busy windows are between none and all of them, each holds one
 *   person served, and their time average is at most one.
 */
export function checkLaws(record: Snapshot<ServicePointRecord>): LawCheck[] {
  const { time, data } = record;
  const inSystem = data.inLine + data.atWindows;
  const little = data.timeOfLeft + data.timeOfPresent;
  const busyWithin = data.busy >= 0 && data.busy <= data.windows && data.busy === data.atWindows;
  const meanBusyWithin = data.busyArea >= 0 && data.busyArea <= data.windows * time * (1 + ROUNDING);
  return [
    {
      law: 'balance',
      holds: data.arrived === data.left + inSystem && data.people === inSystem + data.walkingOut,
      actual: data.arrived,
      expected: data.left + inSystem,
    },
    {
      law: 'little',
      holds: Math.abs(data.systemArea - little) <= ROUNDING * Math.max(1, data.systemArea),
      actual: data.systemArea,
      expected: little,
    },
    {
      law: 'utilization',
      holds: busyWithin && meanBusyWithin,
      actual: time === 0 ? 0 : data.busyArea / (data.windows * time),
      expected: 1,
    },
  ];
}
