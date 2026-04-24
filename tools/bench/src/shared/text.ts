export const uniqueTexts = (values: readonly string[]): readonly string[] => {
  return [...new Set(values.filter((value) => value.length > 0))];
};

export const normalizeDecodedText = (value: string): string => {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0) end -= 1;
  return value.slice(0, end);
};
