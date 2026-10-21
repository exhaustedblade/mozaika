import { defineProject } from 'vitest/config';

import { resolveFromSource } from '../../vite.shared.js';

export default defineProject({
  ...resolveFromSource,
  test: { name: 'mcp' },
});
