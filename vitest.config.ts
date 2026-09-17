import { defineConfig } from 'vitest/config';

// The only project-wide test config: a global setup that clears the per-file
// SQLite scratch DBs before a run, so `vitest run` (which skips npm's
// `pretest`) is deterministic and does not fail on rows left by a prior run.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.globalSetup.ts'],
  },
});
