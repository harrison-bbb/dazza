import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Mirror tsup's text loader so prompts import as strings in tests too.
      name: 'markdown-as-text',
      transform(code, id) {
        return id.endsWith('.md') ? `export default ${JSON.stringify(code)};` : undefined;
      },
    },
  ],
  test: {
    include: ['test/**/*.test.ts', 'web/src/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Git, process start-up and the PowerShell stray-process check are slow on Windows runners.
    testTimeout: process.platform === 'win32' ? 60_000 : 5_000,
  },
});
