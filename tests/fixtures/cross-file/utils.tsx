import { MyComponent } from './component';

// This utility file completes the circular dependency:
// utils.tsx → component.tsx → context.tsx → utils.tsx

export function processData<T extends Record<string, unknown>>(data: T) {
  return {
    ...data,
    processed: true,
    timestamp: Date.now(),
  };
}

export function validateInput(data: unknown): boolean {
  return data !== null && typeof data === 'object';
}

export function transformData<T extends Record<string, unknown>>(data: T) {
  // This creates a circular dependency by importing from component
  // which imports from context which imports from this file
  console.log('Transforming data with component type:', typeof MyComponent);

  return {
    ...data,
    transformed: true,
    componentRef: MyComponent.name,
  };
}
