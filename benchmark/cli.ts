import { runRealWorldBenchmark } from './real-world-runner.js';
import { buildReport, printRealWorldSummary, printSummary, writeReport } from './report.js';
import { runBenchmark } from './runner.js';

const result = await runBenchmark();
const report = buildReport(result);
printSummary(report);

const realWorld = await runRealWorldBenchmark(process.cwd());
printRealWorldSummary(realWorld);

const shouldFail =
  report.decodeRate < 1 ||
  report.falsePositiveRate > 0 ||
  realWorld.decodeRate < 1 ||
  realWorld.falsePositiveRate > 0;

try {
  await writeReport(report, realWorld);
} catch (error) {
  process.stderr.write(`Warning: failed to write benchmark-results.json: ${error}\n`);
}

if (shouldFail) {
  process.exit(1);
}
