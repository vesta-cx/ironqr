import os from 'node:os';
import path from 'node:path';

export const collapseHome = (value: string): string => {
  const home = os.homedir();
  if (home.length === 0) return value;
  return value === home || value.startsWith(`${home}${path.sep}`)
    ? `~${value.slice(home.length)}`
    : value;
};
