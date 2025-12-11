type GradientFn = ((text: string) => string) & { multiline: (text: string) => string };

const createGradient = (): GradientFn => {
  const fn = ((text: string) => text) as GradientFn;
  fn.multiline = (text: string) => text;
  return fn;
};

const gradient = jest.fn((_colors?: string[]) => createGradient()) as unknown as {
  (...args: unknown[]): GradientFn;
  [key: string]: GradientFn;
};

// Default gradient presets
const presets = [
  'atlas',
  'cristal',
  'teen',
  'mind',
  'morning',
  'vice',
  'passion',
  'fruit',
  'instagram',
  'retro',
  'summer',
  'rainbow',
  'pastel',
];
presets.forEach((preset) => {
  (gradient as Record<string, unknown>)[preset] = createGradient();
});

export default gradient;
