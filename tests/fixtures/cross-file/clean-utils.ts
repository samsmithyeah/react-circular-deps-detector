// This utility file has NO circular dependencies - only exports functions

export function helperFunction(input: string): string {
  return input.trim().toLowerCase();
}

export function anotherHelper<T extends Record<string, unknown>>(data: T): T & { helper: string } {
  return {
    ...data,
    helper: 'processed',
  };
}
