import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment: main-process code is pure Node. Renderer tests that need
    // a DOM opt in per-file with `// @vitest-environment jsdom`.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    reporters: ['default'],
    setupFiles: ['test/setup-dom.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/main/**', 'src/shared/**', 'src/renderer/**'],
      exclude: ['src/main/index.ts'],
    },
  },
});
