// Markdown files are bundled as plain strings (see tsup and vitest configs).
declare module '*.md' {
  const content: string;
  export default content;
}
