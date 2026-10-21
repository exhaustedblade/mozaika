/**
 * The M/M/c/K model on blocks, Source → Service → Sink, and its independent
 * replications for the statistical tests. Not part of the package build.
 */
import { Random, Simulation } from '@mozaika/kernel';
import { REPLICATIONS } from '@mozaika/kernel/test-support';

import { ResourcePool, Service, Sink, Source } from '../index.js';

export interface QueueingParameters {
  /** λ: mean number of arrivals per unit of time (Poisson arrivals). */
  readonly arrivalRate: number;
  /** μ: mean number of services one server completes per unit of time (exponential service). */
  readonly serviceRate: number;
  /** c: number of identical servers. */
  readonly servers: number;
  /** K: most entities in the system, waiting or in service; default unlimited. */
  readonly capacity?: number;
}

export interface QueueingModel {
  readonly simulation: Simulation;
  readonly source: Source;
  readonly servers: ResourcePool;
  readonly service: Service;
  readonly sink: Sink;
}

/** Builds Source → Service → Sink with exponential interarrival and service times. */
export function buildQueueingModel(simulation: Simulation, parameters: QueueingParameters): QueueingModel {
  const servers = new ResourcePool(simulation, { name: 'servers', capacity: parameters.servers });
  const source = new Source(simulation, {
    name: 'arrivals',
    interval: (random) => random.exponential(1 / parameters.arrivalRate),
  });
  const service = new Service(simulation, {
    name: 'service',
    pool: servers,
    duration: (random) => random.exponential(1 / parameters.serviceRate),
    capacity: parameters.capacity ?? Infinity,
  });
  const sink = new Sink(simulation, { name: 'exit' });
  source.connect(service).connect(sink);
  return { simulation, source, servers, service, sink };
}

/**
 * Replication/deletion (Law, ch. 9): each replication starts empty, runs
 * through the warm-up, resets the statistics and then measures over the window.
 */
export interface RunLength {
  /** Model time discarded at the start, while the empty system fills up. */
  readonly warmUp: number;
  /** Model time measured after the warm-up. */
  readonly window: number;
}

/** What one replication measured over its window. */
export interface ReplicationEstimates {
  /** L̂: time-average number of entities in the system (the Service block). */
  readonly inSystem: number;
  /** L̂q: time-average number of entities waiting for a server. */
  readonly waiting: number;
  /** Ŵ: mean time in the system of the entities that left during the window. */
  readonly timeInSystem: number;
  /** Ŵq: mean wait of the entities that started service during the window. */
  readonly waitTime: number;
  /** Time-average fraction of busy servers. */
  readonly utilization: number;
  /** λ̂: entities that left during the window, per unit of time. */
  readonly throughput: number;
  /** Fraction of the window's arrivals that found the system full. */
  readonly lossFraction: number;
}

export function runReplication(parameters: QueueingParameters, runLength: RunLength, random: Random): ReplicationEstimates {
  const simulation = new Simulation({ random });
  const { source, servers, service, sink } = buildQueueingModel(simulation, parameters);

  simulation.run(runLength.warmUp);
  servers.resetStatistics();
  service.resetStatistics();
  sink.resetStatistics();
  const arrivalsBefore = source.arrivals;
  const lostBefore = source.lost;

  simulation.run(runLength.warmUp + runLength.window);
  return {
    inSystem: service.stats.content.mean,
    waiting: service.stats.queueLength.mean,
    timeInSystem: sink.stats.timeInSystem.mean,
    waitTime: service.stats.waitTime.mean,
    utilization: servers.utilization,
    throughput: sink.stats.timeInSystem.count / runLength.window,
    lossFraction: (source.lost - lostBefore) / (source.arrivals - arrivalsBefore),
  };
}

/** REPLICATIONS independent replications: replication k draws from stream ['replication', k] of `seed`. */
export function runReplications(
  parameters: QueueingParameters,
  runLength: RunLength,
  seed: number,
): ReplicationEstimates[] {
  return Array.from({ length: REPLICATIONS }, (_, k) =>
    runReplication(parameters, runLength, new Random(seed, ['replication', String(k)])),
  );
}
