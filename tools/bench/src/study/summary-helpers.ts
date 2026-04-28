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

export const parseVariantList = <Variant extends string>(options: {
  readonly value: string | number | boolean | undefined;
  readonly defaultValues: readonly Variant[];
  readonly controlValue: Variant;
  readonly unknownLabel: string;
  readonly controlLabel?: string;
  readonly studyId: string;
  readonly flagName?: string;
}): readonly Variant[] => {
  const raw = typeof options.value === 'string' ? options.value.trim() : '';
  const variants =
    raw.length === 0
      ? options.defaultValues
      : raw.split(',').map((variant) => variant.trim() as Variant);
  const known = new Set<Variant>(options.defaultValues);
  for (const variant of variants) {
    if (!known.has(variant)) throw new Error(`unknown ${options.unknownLabel}: ${variant}`);
  }
  if (!variants.includes(options.controlValue)) {
    const controlLabel = options.controlLabel ?? options.controlValue;
    throw new Error(`${options.studyId} requires ${controlLabel}`);
  }
  return variants;
};

export const parseStringChoice = <Choice extends string>(options: {
  readonly value: string | number | boolean | undefined;
  readonly defaultValue: Choice;
  readonly choices: readonly Choice[];
  readonly label: string;
}): Choice => {
  const choice =
    typeof options.value === 'string' ? (options.value.trim() as Choice) : options.defaultValue;
  if (!options.choices.includes(choice)) throw new Error(`unknown ${options.label}: ${choice}`);
  return choice;
};

export const uniqueValues = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

export const sumBy = <T>(items: readonly T[], value: (item: T) => number): number =>
  items.reduce((total, item) => total + value(item), 0);

export const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(sumBy(values, (value) => value) / values.length);

export const round = (value: number): number => Math.round(value * 100) / 100;

export const round1 = (value: number): number => Math.round(value * 10) / 10;
