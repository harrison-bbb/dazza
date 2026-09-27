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
    include: ['test/**/*.test.ts'],
  },
});
