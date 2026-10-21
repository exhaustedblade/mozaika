import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';

/**
 * Library of process blocks built on the kernel: entities come from a Source,
 * wait in a Queue, are served by a Service with units of a ResourcePool, are
 * held by a Delay and leave through a Sink. Every entity is an agent of a
 * population, and the blocks move it with kernel events of their own, without
 * a process per entity. Behaviour: docs/BLOCKS.md.
 */
export const PACKAGE_NAME = '@mozaika/blocks';

/** Workspace packages this one is built on. */
export const DEPENDS_ON: readonly string[] = [KERNEL_PACKAGE_NAME];

export type { BlockAction, BlockActionArgs } from './actions.js';
export type { Block, EntityReceiver, HoldingBlockOptions, RequestOutcome, UnitRequester } from './block.js';
export { Delay, type DelayOptions } from './delay.js';
export type { Distribution } from './distribution.js';
export type { AnyAgent } from './entity.js';
export { Queue, type QueueOptions } from './queue.js';
export { ResourcePool, type ResourcePoolOptions } from './resource-pool.js';
export { Service, type ServiceOptions } from './service.js';
export { Sink, type SinkOptions } from './sink.js';
export { type EntityFactory, Source, type SourceOptions } from './source.js';
export { Tally, TimeAverage } from './statistics.js';
