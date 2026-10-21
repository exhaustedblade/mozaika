/**
 * The kernel in a Web Worker (docs/ARCHITECTURE.md, "Ядро в Web Worker"):
 * the host that runs a model on requests, and the types of the messages.
 * Imported by the worker's script of a viewer as `@mozaika/kernel/worker`;
 * it uses no DOM, so the kernel still renders nothing and knows no browser.
 */
export { KernelHost } from './worker/host.js';
export type {
  BuildRequest,
  BuiltReply,
  ErrorReply,
  KernelAnswer,
  KernelReply,
  KernelRequest,
  ModelDefinition,
  ModelParameters,
  ModelSetup,
  PopulationInfo,
  RanReply,
  ReleasedReply,
  ReleaseRequest,
  RunRequest,
  SetReply,
  SetRequest,
  SnapshotReply,
  SnapshotRequest,
  WorkerModel,
} from './worker/protocol.js';
