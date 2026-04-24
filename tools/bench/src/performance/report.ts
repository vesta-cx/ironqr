import { collapseHome } from '../shared/paths.js';

export const printPerformancePlaceholder = (
  binPath: string,
  result: { readonly message: string },
): void => {
  console.log(`bin: ${collapseHome(binPath)}`);
  console.log('description: Benchmark QR decoder throughput and latency');
  console.log(`status: ${JSON.stringify(result.message)}`);
};
