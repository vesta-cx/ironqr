export const positiveIntegerFlag = (
  value: string | number | boolean | undefined,
  fallback: number,
  name: string,
  studyId: string,
): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${studyId} --${name} must be a positive integer`);
  }
  return value;
};

export const uniqueValues = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

export const sumBy = <T>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);

export const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(sumBy(values, (value) => value) / values.length);

export const round = (value: number): number => Math.round(value * 100) / 100;

export const round1 = (value: number): number => Math.round(value * 10) / 10;
