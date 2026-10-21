// Settings shared by the Vite and Vitest configs of all workspace packages.
import { defaultClientConditions, defaultServerConditions, type UserConfig } from 'vite';

/**
 * Export condition that points a workspace package at its TypeScript sources
 * (see "exports" in each packages/<name>/package.json). TypeScript enables it
 * through "customConditions" in packages/<name>/tsconfig.json.
 */
export const SOURCE_CONDITION = '@mozaika/source';

/** Resolve workspace packages from source, so tests and the viewer need no prior build. */
export const resolveFromSource = {
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
} satisfies UserConfig;
