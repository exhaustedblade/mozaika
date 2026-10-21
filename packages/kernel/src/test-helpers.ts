// Helpers shared by the kernel tests. Not part of the package build.
import { expect } from 'vitest';

import type { SimulationErrorCode } from './errors.js';
import type { EventInfo } from './event-queue.js';

/** Matches a SimulationError with the given code and, optionally, other fields such as `message`. */
export function simulationError(code: SimulationErrorCode, fields: object = {}): unknown {
  return expect.objectContaining({ code, ...fields });
}

/** Matches a string that contains `text`. */
export function containing(text: string): unknown {
  return expect.stringContaining(text);
}

/** One line per event for traces: "time priority #seq label". */
export function describeEvent(event: EventInfo): string {
  return `${String(event.time)} ${String(event.priority)} #${String(event.seq)} ${event.label ?? ''}`;
}
