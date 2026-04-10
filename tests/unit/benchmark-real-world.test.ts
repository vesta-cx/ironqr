import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runRealWorldBenchmark } from '../../benchmark/real-world-runner.js';

describe('real-world benchmark runner', () => {
  it('reports zero counts when the corpus is empty and passes the exit gate', async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'qreader-bench-empty-'));
    const result = await runRealWorldBenchmark(repoRoot);

    expect(result.positives).toHaveLength(0);
    expect(result.negatives).toHaveLength(0);
    expect(result.decodeRate).toBe(1);
    expect(result.falsePositiveRate).toBe(0);
  });
});
