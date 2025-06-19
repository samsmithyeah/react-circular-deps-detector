// This utility file has NO circular dependencies - only exports functions

export function helperFunction(input: string): string {
  return input.trim().toLowerCase();
}

export function anotherHelper(data: any): any {
  return {
    ...data,
    helper: 'processed',
  };
}