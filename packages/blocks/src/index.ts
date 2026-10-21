import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';

/**
 * Library of process blocks (Source, Queue, Service, Delay, Sink and others),
 * each a kernel process with ports.
 *
 * Placeholder entry point; the first blocks arrive in task F0-3.
 */
export const PACKAGE_NAME = '@mozaika/blocks';

/** Workspace packages this one is built on. */
export const DEPENDS_ON: readonly string[] = [KERNEL_PACKAGE_NAME];
