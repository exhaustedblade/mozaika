/**
 * Simulation time kernel: one clock and event queue for processes, agents
 * with statecharts and, in a later task, system dynamics. Runs without
 * rendering and is deterministic for a given seed.
 */
export const PACKAGE_NAME = '@mozaika/kernel';

export { Agent } from './agents/agent.js';
export type {
  AgentAction,
  AgentActions,
  AgentArgs,
  AgentDelay,
  AgentDelayFunction,
  AgentEvent,
  AgentGuard,
  ContextArgs,
  StateConfig,
  StatechartConfig,
  StatechartImplementations,
  TransitionConfig,
  TransitionsConfig,
} from './agents/definition.js';
export { MAX_STATES, type StateNode, type Timer, type Transition } from './agents/compile.js';
export { type AddAgentOptions, AgentPopulation, type AgentPopulationOptions } from './agents/population.js';
export { defineStatechart, rate, Statechart } from './agents/statechart.js';
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
