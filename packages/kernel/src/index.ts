/**
 * Simulation time kernel: one clock and event queue for processes and, in later
 * tasks, agents and system dynamics. Runs without rendering and is
 * deterministic for a given seed.
 */
export const PACKAGE_NAME = '@mozaika/kernel';

export { type SimulationErrorCode, SimulationError } from './errors.js';
export type { EventHandle, EventInfo } from './event-queue.js';
export {
  type Command,
  Process,
  type ProcessBody,
  type ProcessOptions,
  type ProcessState,
  Timeout,
  timeout,
  type TimeoutOptions,
} from './process.js';
export { Random } from './random.js';
export { type NotifyOptions, Signal, SignalWait } from './signal.js';
export {
  type RunEndReason,
  type RunResult,
  type ScheduleOptions,
  Simulation,
  type SimulationOptions,
} from './simulation.js';
export type { JsonValue, Snapshot, SnapshotOptions, SnapshotRecorder } from './snapshots.js';
