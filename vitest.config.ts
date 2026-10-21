import { defineConfig } from 'vitest/config';

// Each package is a separate test project with its own config file.
export default defineConfig({
  test: {
    projects: ['packages/*'],
  },
});
