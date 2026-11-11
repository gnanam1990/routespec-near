/** Error code of a synchronous call, or NO_ERROR. */
export function codeOfThrow(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}
