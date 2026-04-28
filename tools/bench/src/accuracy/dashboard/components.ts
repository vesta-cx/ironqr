const FRACTIONAL_BAR_SEGMENTS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const;

export const fractionalBar = (
  ratio: number,
  width: number,
  options: { readonly minVisible?: boolean } = {},
): string => {
  const normalizedWidth = Math.max(0, Math.floor(width));
  if (normalizedWidth === 0) return '';
  const normalizedRatio = clamp01(Number.isFinite(ratio) ? ratio : 0);
  const totalEighths = Math.min(
    normalizedWidth * 8,
    Math.max(
      options.minVisible && normalizedRatio > 0 ? 1 : 0,
      Math.round(normalizedRatio * normalizedWidth * 8),
    ),
  );
  const fullCells = Math.floor(totalEighths / 8);
  const partialEighths = totalEighths % 8;
  const partial = partialEighths === 0 ? '' : (FRACTIONAL_BAR_SEGMENTS[partialEighths - 1] ?? '');
  const filledWidth = fullCells + (partial ? 1 : 0);
  return `${'█'.repeat(fullCells)}${partial}${' '.repeat(Math.max(0, normalizedWidth - filledWidth))}`;
};

export const truncateLine = (value: string, width: number): string =>
  value.length > width ? value.slice(0, Math.max(0, width - 1)) : value;

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
