export const assertHttpUrl = (value: string, label: string): void => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Expected http(s) URL for ${label}, got ${url.protocol}`);
  }
};
