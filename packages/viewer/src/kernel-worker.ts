/**
 * The Web Worker the kernel runs in (docs/ARCHITECTURE.md, "Ядро в Web
 * Worker"): it hands every message to the kernel's host and posts back the
 * reply, transferring the buffers of snapshots rather than copying them.
 * The kernel itself knows nothing of workers or of the DOM.
 */
import { KernelHost, type KernelRequest } from '@mozaika/kernel/worker';

import { walkway } from './walkway.js';

const host = new KernelHost({ walkway });

self.onmessage = (event: MessageEvent<KernelRequest>) => {
  const { reply, transfer } = host.handle(event.data);
  self.postMessage(reply, { transfer: [...transfer] });
};
