import { PACKAGE_NAME as KERNEL_PACKAGE_NAME } from '@mozaika/kernel';

/**
 * MCP server that lets an AI assistant build, change, run and watch models
 * (status, change, run, watch and the rest of the Architect tool vocabulary).
 *
 * Placeholder entry point; the server arrives in task F0-7.
 */
export const PACKAGE_NAME = '@mozaika/mcp';

/** Workspace packages this one is built on. */
export const DEPENDS_ON: readonly string[] = [KERNEL_PACKAGE_NAME];
