import { defineConfig } from 'vitest/config';

import { resolveFromSource } from '../../vite.shared.js';

export default defineConfig({
  ...resolveFromSource,
  // Relative asset paths: the same build works at the site root and under /pr-<number>/.
  base: './',
  test: { name: 'viewer' },
});
