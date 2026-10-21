import { KernelHost, type KernelRequest, type RanReply, type SnapshotReply } from '@mozaika/kernel/worker';
import { describe, expect, it } from 'vitest';

import { KernelClient, type Timed } from './kernel-client.js';
import { SnapshotFeed } from './snapshot-feed.js';
import { workerInThisThread } from './test-support/worker-in-this-thread.js';
import { walkway } from './walkway.js';
import { answerTimed } from './worker-answer.js';

/** Lets the replies of the worker stand-in, posted as microtasks, arrive. */
function replies(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A walkway built in a worker stand-in, with the types of the requests it got. */
async function builtWalkway(): Promise<{ client: KernelClient; requests: string[] }> {
  const requests: string[] = [];
  const port = workerInThisThread({ walkway }, (request: KernelRequest) => requests.push(request.type));
  const client = new KernelClient(port);
  await client.build('walkway', 1);
  requests.length = 0;
  return { client, requests };
}

describe('snapshot feed', () => {
  it('asks for a run and a snapshot when one is due, and none while one is on its way', async () => {
    const { client, requests } = await builtWalkway();
    const taken: Timed<SnapshotReply>[] = [];
    const feed = new SnapshotFeed(client, {
      minInterval: 50,
      onSnapshot: (snapshot) => taken.push(snapshot),
      onError: (error) => {
        throw error;
      },
    });
    expect(feed.latest).toBeUndefined();
    feed.frame(5, 0);
    feed.frame(5.1, 16);
    await replies();
    expect(taken.map((snapshot) => snapshot.time)).toEqual([5]);
    expect(feed.latest).toBe(5);
    // Answered, but less than minInterval after the last request: not yet.
    feed.frame(5.2, 33);
    await replies();
    expect(taken).toHaveLength(1);
    feed.frame(5.3, 50);
    await replies();
    expect(taken.map((snapshot) => snapshot.time)).toEqual([5, 5.3]);
    expect(requests).toEqual(['run', 'snapshot', 'release', 'run', 'snapshot', 'release']);
  });

  it('gives the buffers of each snapshot back as soon as it is taken in, so the kernel never runs out', async () => {
    const { client } = await builtWalkway();
    const errors: unknown[] = [];
    const runs: Timed<RanReply>[] = [];
    let sizes = 0;
    const feed = new SnapshotFeed(client, {
      minInterval: 0,
      onSnapshot: (snapshot, ran) => {
        sizes += snapshot.populations[0]?.size ?? 0;
        runs.push(ran);
      },
      onError: (error) => errors.push(error),
    });
    for (let frame = 1; frame <= 10; frame++) {
      feed.frame(frame, frame * 100);
      await replies();
    }
    expect(errors).toEqual([]);
    expect(runs.map((ran) => ran.time)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sizes).toBeGreaterThan(100);
  });

  it('passes on what fails, and stops asking', async () => {
    const { client, requests } = await builtWalkway();
    const errors: unknown[] = [];
    const feed = new SnapshotFeed(client, {
      minInterval: 0,
      onSnapshot: () => {
        throw new Error('the graphics card is gone');
      },
      onError: (error) => errors.push(error),
    });
    feed.frame(1, 0);
    await replies();
    feed.frame(2, 100);
    await replies();
    expect(errors).toEqual([new Error('the graphics card is gone')]);
    expect(requests.filter((type) => type === 'snapshot')).toHaveLength(1);
  });
});

describe('timed answers of the worker', () => {
  it('add the time the kernel took to handle the request, by the clock of the worker', () => {
    const host = new KernelHost({ walkway });
    const ticks = [10, 10.5, 20, 23.25];
    const clock = (): number => ticks.shift() ?? Number.NaN;
    expect(answerTimed(host, { type: 'build', id: 1, model: 'walkway' }, clock).message).toMatchObject({
      type: 'built',
      workerMilliseconds: 0.5,
    });
    const { message, transfer } = answerTimed(host, { type: 'snapshot', id: 2 }, clock);
    expect(message).toMatchObject({ type: 'snapshot', workerMilliseconds: 3.25 });
    expect(transfer).toHaveLength(1);
  });
});
