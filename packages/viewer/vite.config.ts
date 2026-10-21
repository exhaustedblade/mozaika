import { defineConfig } from 'vitest/config';

import { resolveFromSource } from '../../vite.shared.js';

export default defineConfig({
  ...resolveFromSource,
  // Relative asset paths: the same build works at the site root and under /pr-<number>/.
  base: './',
  build: {
    rolldownOptions: {
      // The pages of the preview: the home page and the scene benchmark.
      input: { main: 'index.html', bench: 'bench.html' },
    },
  },
  test: { name: 'viewer' },
});
