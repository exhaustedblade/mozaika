/**
 * How the viewer's worker answers a request: the kernel's host handles it,
 * and the answer carries the time that took by the worker's clock — the time
 * of a snapshot in the worker, which the benchmark page shows. The kernel
 * itself reads no clock (docs/ARCHITECTURE.md, "Ядро времени").
 */
import type { KernelHost, KernelRequest } from '@mozaika/kernel/worker';

import type { TimedReply } from './kernel-client.js';

/** A reply to post and the buffers to transfer with it. */
export interface TimedAnswer {
  readonly message: TimedReply;
  readonly transfer: readonly ArrayBuffer[];
}

/** Handles `request` with `host`, timing it with `now` (milliseconds, e.g. performance.now). */
export function answerTimed(host: KernelHost, request: KernelRequest, now: () => number): TimedAnswer {
  const started = now();
  const { reply, transfer } = host.handle(request);
  const workerMilliseconds = now() - started;
  return { message: { ...reply, workerMilliseconds }, transfer };
}
