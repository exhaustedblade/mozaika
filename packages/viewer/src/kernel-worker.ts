/**
 * The Web Worker the kernel runs in (docs/ARCHITECTURE.md, "Ядро в Web
 * Worker"): it hands every message to the kernel's host and posts back the
 * reply with the time it took, transferring the buffers of snapshots rather
 * than copying them. The kernel itself knows nothing of workers or of the DOM.
 */
import { KernelHost, type KernelRequest } from '@mozaika/kernel/worker';

import { crowd } from './models/crowd.js';
import { servicePoint } from './models/service-point.js';
import { walkway } from './walkway.js';
import { answerTimed } from './worker-answer.js';

const host = new KernelHost({ walkway, servicePoint, crowd });

self.onmessage = (event: MessageEvent<KernelRequest>) => {
  const { message, transfer } = answerTimed(host, event.data, () => performance.now());
  self.postMessage(message, { transfer: [...transfer] });
};
