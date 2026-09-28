/** Run `fn` once things have been quiet for `ms`, however many calls came in. */
export function debounce(fn: () => unknown, ms: number): () => void {
  let timer: NodeJS.Timeout | undefined;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(() => void fn(), ms);
  };
}
