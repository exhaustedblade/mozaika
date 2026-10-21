/**
 * The messages between a viewer and the kernel in a Web Worker
 * (docs/ARCHITECTURE.md, "Ядро в Web Worker"). Every request carries a
 * number, `id`, and gets exactly one reply with the same number; replies come
 * in the order of the requests. Snapshots travel with their buffers
 * transferred, not copied: the reply of `snapshot` comes with the list of
 * buffers to transfer, and `release` brings them back.
 *
 * These are plain data that survive postMessage. A model is code, so it is
 * not sent: the worker is built with its models, and `build` names one.
 */
import type { SimulationErrorCode } from '../errors.js';
import type { AnyPopulation } from '../agents/population.js';
import type { PopulationSnapshot, ReturnedSnapshot } from '../agents/population-snapshots.js';
import type { RunEndReason, Simulation } from '../simulation.js';
import type { JsonValue, Snapshot, SnapshotRecorder } from '../snapshots.js';

/** Parameters of a model by name: numbers that the model reads while it runs. */
export type ModelParameters = Readonly<Record<string, number>>;

/** What a model gets to build itself in the worker. */
export interface ModelSetup<TParameters extends ModelParameters = ModelParameters> {
  /** The simulation to build the model in, created by the host with the seed of the request. */
  readonly simulation: Simulation;
  /**
   * The values of the parameters: the defaults with those of the request on
   * top. The host changes them in place when asked (`set`), so the model
   * reads them in its events, not once while it is built.
   */
  readonly parameters: Readonly<TParameters>;
}

/** A model built in the worker: what the host shows of it. */
export interface WorkerModel {
  /** The populations that snapshots show, in this order. */
  readonly populations: readonly AnyPopulation[];
  /**
   * Records of the model for charts and panels (simulation.recordSnapshots):
   * each `run` reply brings those taken since the previous one. None by default.
   */
  readonly records?: SnapshotRecorder;
}

/**
 * A model the worker is built with. `TParameters` names its parameters, e.g.
 * `ModelDefinition<{ speed: number }>`, so the model reads them without checks.
 */
export interface ModelDefinition<TParameters extends ModelParameters = ModelParameters> {
  /** The parameters of the model and their default values; none by default. */
  readonly parameters?: TParameters;
  /** Builds the model in a new simulation. */
  build(setup: ModelSetup<TParameters>): WorkerModel;
}

/** Builds a model by name, in a new simulation; a model built earlier is dropped. */
export interface BuildRequest {
  readonly type: 'build';
  readonly id: number;
  readonly model: string;
  /** Seed of the simulation; default 0. */
  readonly seed?: number;
  /** Values of some of the model's parameters; the others keep their defaults. */
  readonly parameters?: ModelParameters;
}

/** Runs the model to a moment of model time (Simulation.run). */
export interface RunRequest {
  readonly type: 'run';
  readonly id: number;
  readonly until: number;
}

/** Takes a snapshot of every population of the model; their buffers come transferred. */
export interface SnapshotRequest {
  readonly type: 'snapshot';
  readonly id: number;
}

/** Changes a parameter of the model; the model sees the new value from its next event on. */
export interface SetRequest {
  readonly type: 'set';
  readonly id: number;
  readonly parameter: string;
  readonly value: number;
}

/** Gives back the buffers of snapshots, transferred, so the kernel can write into them again. */
export interface ReleaseRequest {
  readonly type: 'release';
  readonly id: number;
  readonly snapshots: readonly (ReturnedSnapshot & { readonly population: string })[];
}

export type KernelRequest = BuildRequest | RunRequest | SnapshotRequest | SetRequest | ReleaseRequest;

/** A population of a built model, as a viewer needs to show it. */
export interface PopulationInfo {
  readonly name: string;
  /** Names of the states by state code, as statechart.stateNames. */
  readonly stateNames: readonly string[];
}

export interface BuiltReply {
  readonly type: 'built';
  readonly id: number;
  /** Model time at the start. */
  readonly time: number;
  /** Values of all the parameters. */
  readonly parameters: ModelParameters;
  readonly populations: readonly PopulationInfo[];
}

export interface RanReply {
  readonly type: 'ran';
  readonly id: number;
  readonly time: number;
  /** Events fired during this run. */
  readonly events: number;
  readonly reason: RunEndReason;
  /** The records the model took since the previous run reply, oldest first; only if the model keeps records. */
  readonly records?: readonly Snapshot<JsonValue>[];
}

export interface SnapshotReply {
  readonly type: 'snapshot';
  readonly id: number;
  readonly time: number;
  /** One snapshot per population, in the order of WorkerModel.populations. */
  readonly populations: readonly PopulationSnapshot[];
}

export interface SetReply {
  readonly type: 'set';
  readonly id: number;
  readonly parameter: string;
  readonly value: number;
}

export interface ReleasedReply {
  readonly type: 'released';
  readonly id: number;
}

/** A request that failed; the model and the host stay as they were before it, unless the run itself failed. */
export interface ErrorReply {
  readonly type: 'error';
  readonly id: number;
  /** The code of the SimulationError; undefined for any other error. */
  readonly code: SimulationErrorCode | undefined;
  readonly message: string;
}

export type KernelReply = BuiltReply | RanReply | SnapshotReply | SetReply | ReleasedReply | ErrorReply;

/** A reply with the buffers to transfer with it: postMessage(reply, transfer). */
export interface KernelAnswer {
  readonly reply: KernelReply;
  readonly transfer: readonly ArrayBuffer[];
}
