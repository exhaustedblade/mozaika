/**
 * The viewer's side of the kernel in a Web Worker: sends requests and gives
 * back promises of their replies (docs/ARCHITECTURE.md, "Ядро в Web Worker").
 */
import type {
  BuiltReply,
  KernelReply,
  KernelRequest,
  ModelParameters,
  RanReply,
  SnapshotReply,
} from '@mozaika/kernel/worker';

/**
 * A reply as the viewer's worker posts it: the kernel's reply and the time
 * the worker took to handle the request (worker-answer.ts). The kernel reads
 * no clock, so the worker's script measures it.
 */
export type Timed<T extends KernelReply> = T & {
  /** Milliseconds the kernel spent on the request in the worker, by the worker's clock. */
  readonly workerMilliseconds: number;
};

export type TimedReply = Timed<KernelReply>;

/** A request without its number: the client numbers requests itself. */
type Request = KernelRequest extends infer R ? (R extends KernelRequest ? Omit<R, 'id'> : never) : never;

/** The reply of a request that failed, as an error. */
export class KernelError extends Error {
  override readonly name = 'KernelError';
  readonly code: string | undefined;

  constructor(code: string | undefined, message: string) {
    super(message);
    this.code = code;
  }
}

/** What the client needs of a worker: the part of Worker it uses, so tests can stand in for one. */
export interface WorkerPort {
  postMessage(message: KernelRequest, options: { transfer: Transferable[] }): void;
  onmessage: ((event: MessageEvent<TimedReply>) => void) | null;
}

export class KernelClient {
  readonly #worker: WorkerPort;
  readonly #waiting = new Map<number, (reply: TimedReply) => void>();
  #nextId = 1;

  constructor(worker: WorkerPort) {
    this.#worker = worker;
    worker.onmessage = (event) => {
      const resolve = this.#waiting.get(event.data.id);
      this.#waiting.delete(event.data.id);
      resolve?.(event.data);
    };
  }

  build(model: string, seed: number, parameters?: ModelParameters): Promise<Timed<BuiltReply>> {
    const request: Request =
      parameters === undefined ? { type: 'build', model, seed } : { type: 'build', model, seed, parameters };
    return this.#ask(request, 'built');
  }

  /** Runs the model to `until`; the reply brings the model's records taken on the way, if it keeps any. */
  run(until: number): Promise<Timed<RanReply>> {
    return this.#ask({ type: 'run', until }, 'ran');
  }

  /** A snapshot of every population; give it back with release() once drawn. */
  snapshot(): Promise<Timed<SnapshotReply>> {
    return this.#ask({ type: 'snapshot' }, 'snapshot');
  }

  async set(parameter: string, value: number): Promise<void> {
    await this.#ask({ type: 'set', parameter, value }, 'set');
  }

  /** Gives the buffers of a snapshot back to the kernel, transferred; the snapshot is unusable afterwards. */
  async release(snapshot: SnapshotReply): Promise<void> {
    const transfer = snapshot.populations.map((population) => population.buffer);
    await this.#ask({ type: 'release', snapshots: snapshot.populations }, 'released', transfer);
  }

  #ask<T extends KernelReply['type']>(
    request: Request,
    expected: T,
    transfer: Transferable[] = [],
  ): Promise<Timed<Extract<KernelReply, { type: T }>>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, (reply) => {
        if (reply.type === expected) {
          resolve(reply as Timed<Extract<KernelReply, { type: T }>>);
        } else if (reply.type === 'error') {
          reject(new KernelError(reply.code, reply.message));
        } else {
          reject(new KernelError(undefined, `Expected a "${expected}" reply, got "${reply.type}"`));
        }
      });
      this.#worker.postMessage({ ...request, id }, { transfer });
    });
  }
}
