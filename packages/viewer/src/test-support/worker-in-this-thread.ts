/** A stand-in for the Web Worker of the kernel, for the tests of the viewer. */
import { KernelHost, type KernelRequest, type ModelDefinition } from '@mozaika/kernel/worker';

import type { TimedReply, WorkerPort } from '../kernel-client.js';
import { answerTimed } from '../worker-answer.js';

/**
 * Runs the kernel's host in the same thread, with the same handler as the
 * worker's script, and posts each reply back on a later turn, as a worker's
 * message would come. `onRequest` sees each request as it is sent.
 */
export function workerInThisThread(
  models: Readonly<Record<string, ModelDefinition>>,
  onRequest?: (request: KernelRequest) => void,
): WorkerPort {
  const host = new KernelHost(models);
  const port: WorkerPort = {
    onmessage: null,
    postMessage(request: KernelRequest) {
      onRequest?.(request);
      const { message } = answerTimed(host, request, () => performance.now());
      queueMicrotask(() => port.onmessage?.({ data: message } as MessageEvent<TimedReply>));
    },
  };
  return port;
}
