import { describe, expect, it } from 'bun:test';
import { createTraceCollector, createTraceCounter } from '../../../../packages/ironqr/src/index.js';
import { classifyIronqrFailure, summarizeIronqrTrace } from '../../src/accuracy/adapters/ironqr.js';
import { openAccuracyCacheStore } from '../../src/accuracy/cache.js';
import {
  isCacheableEngineResult,
  normalizeAccuracyEngineRunOptions,
} from '../../src/accuracy/runner.js';
import {
  scoreNegativeScan,
  scorePositiveScan,
  statusCodeForResult,
} from '../../src/accuracy/scoring.js';
import type {
  AccuracyEngine,
  AccuracyScanResult,
  EngineAssetResult,
  EngineFailureReason,
} from '../../src/accuracy/types.js';

const decodedScan = (text: string): AccuracyScanResult => ({
  status: 'decoded',
  attempted: true,
  succeeded: true,
  results: [{ text }],
  failureReason: null,
  error: null,
});

const noDecodeScan = (
  failureReason: Extract<
    EngineFailureReason,
    'failed_to_find_finders' | 'failed_to_resolve_geometry' | 'failed_to_decode' | 'no_decode'
  >,
): AccuracyScanResult => ({
  status: 'no-decode',
  attempted: true,
  succeeded: true,
  results: [],
  failureReason,
  error: null,
});

describe('accuracy scoring', () => {
  it('scores a positive full match as pass', () => {
    const outcome = scorePositiveScan(['HELLO'], decodedScan('HELLO'));
    expect(outcome.kind).toBe('pass');
    expect(outcome.matchedTexts).toEqual(['HELLO']);
  });

  it('scores a partial multi-code match as partial-pass', () => {
    const outcome = scorePositiveScan(['A', 'B'], decodedScan('A'));
    expect(outcome.kind).toBe('partial-pass');
    expect(outcome.matchedTexts).toEqual(['A']);
  });

  it('scores a no-decode positive with the engine-provided reason', () => {
    const outcome = scorePositiveScan(['HELLO'], noDecodeScan('failed_to_find_finders'));
    expect(outcome.kind).toBe('fail-no-decode');
    expect(outcome.failureReason).toBe('failed_to_find_finders');
  });

  it('scores a mismatched positive as fail-mismatch', () => {
    const outcome = scorePositiveScan(['HELLO'], decodedScan('WORLD'));
    expect(outcome.kind).toBe('fail-mismatch');
    expect(outcome.failureReason).toBe('text_mismatch');
  });

  it('does not pass a positive decode when expected text is missing', () => {
    const outcome = scorePositiveScan([], decodedScan('HELLO'));
    expect(outcome.kind).toBe('fail-mismatch');
    expect(outcome.failureReason).toBe('text_mismatch');
  });

  it('clears failure metadata from negative pass outcomes', () => {
    const outcome = scoreNegativeScan(noDecodeScan('no_decode'));
    expect(outcome.kind).toBe('pass');
    expect(outcome.failureReason).toBeNull();
    expect(outcome.error).toBeNull();
  });

  it('scores a negative decode as false-positive', () => {
    const outcome = scoreNegativeScan(decodedScan('HELLO'));
    expect(outcome.kind).toBe('false-positive');
    expect(outcome.failureReason).toBe('false_positive');
  });

  it('maps engine outcomes to compact table cells', () => {
    expect(
      statusCodeForResult({
        engineId: 'ironqr',
        label: 'qr-pos',
        outcome: 'fail-no-decode',
        decodedTexts: [],
        matchedTexts: [],
        failureReason: 'failed_to_decode',
        error: null,
        durationMs: 12.5,
        imageLoadDurationMs: null,
        totalJobDurationMs: 12.5,
        cached: false,
      }),
    ).toBe('no-decode');
  });
});

describe('accuracy run options', () => {
  it('keeps ironqr traces disabled unless explicitly requested', () => {
    expect(normalizeAccuracyEngineRunOptions()).toEqual({
      verbose: false,
      ironqrTraceMode: 'off',
    });
    expect(normalizeAccuracyEngineRunOptions({ verbose: true })).toEqual({
      verbose: true,
      ironqrTraceMode: 'off',
    });
    expect(normalizeAccuracyEngineRunOptions({ ironqrTraceMode: 'summary' })).toEqual({
      verbose: false,
      ironqrTraceMode: 'summary',
    });
  });
});

describe('accuracy cacheability policy', () => {
  const passOnlyEngine: AccuracyEngine = {
    id: 'ironqr',
    kind: 'first-party',
    capabilities: {
      multiCode: true,
      inversion: 'native',
      rotation: 'native',
      runtime: 'js',
    },
    cache: {
      enabled: true,
      version: 'test',
      mode: 'pass-only',
    },
    availability: () => ({ available: true, reason: null }),
    scan: async () => noDecodeScan('no_decode'),
  };

  const result = (outcome: EngineAssetResult['outcome']): EngineAssetResult => ({
    engineId: passOnlyEngine.id,
    label: outcome === 'false-positive' ? 'qr-neg' : 'qr-pos',
    outcome,
    decodedTexts: [],
    matchedTexts: [],
    failureReason: null,
    error: null,
    durationMs: 1,
    imageLoadDurationMs: null,
    totalJobDurationMs: 1,
    cached: false,
  });

  it('caches only passing outcomes for pass-only engines', async () => {
    const cache = await openAccuracyCacheStore('/tmp/unused-accuracy-cache.json', {
      enabled: true,
      refresh: false,
    });

    expect(isCacheableEngineResult(passOnlyEngine, cache, result('pass'))).toBe(true);
    expect(isCacheableEngineResult(passOnlyEngine, cache, result('partial-pass'))).toBe(true);
    expect(isCacheableEngineResult(passOnlyEngine, cache, result('fail-no-decode'))).toBe(false);
    expect(isCacheableEngineResult(passOnlyEngine, cache, result('fail-mismatch'))).toBe(false);
    expect(isCacheableEngineResult(passOnlyEngine, cache, result('false-positive'))).toBe(false);
  });
});

describe('ironqr failure classification', () => {
  it('classifies missing proposals as failed_to_find_finders', () => {
    expect(classifyIronqrFailure([{ type: 'scan-started', width: 1, height: 1 }])).toBe(
      'failed_to_find_finders',
    );
  });

  it('classifies proposal-only traces as failed_to_resolve_geometry', () => {
    expect(
      classifyIronqrFailure([
        {
          type: 'proposal-generated',
          proposalId: 'p',
          proposalKind: 'finder-triple',
          binaryViewId: 'gray:otsu:normal',
          sources: ['row-scan'],
          estimatedVersions: [1],
        },
      ]),
    ).toBe('failed_to_resolve_geometry');
  });

  it('classifies decode attempts as failed_to_decode', () => {
    expect(
      classifyIronqrFailure([
        {
          type: 'decode-attempt-started',
          proposalId: 'p',
          geometryCandidateId: 'g',
          decodeBinaryViewId: 'gray:otsu:normal',
          sampler: 'cross-vote',
          refinement: 'none',
        },
      ]),
    ).toBe('failed_to_decode');
  });

  it('classifies counter summaries without storing full trace events', () => {
    expect(
      classifyIronqrFailure({
        'scan-started': 1,
        'proposal-generated': 2,
      }),
    ).toBe('failed_to_resolve_geometry');
  });

  it('summarizes low-overhead trace counters with clustering and failure breakdowns', () => {
    const trace = createTraceCounter();
    trace.emit({
      type: 'proposal-clusters-built',
      rankedProposalCount: 10,
      boundedProposalCount: 8,
      clusterCount: 3,
      representativeCount: 4,
      maxRepresentatives: 2,
    });
    trace.emit({
      type: 'decode-attempt-failed',
      proposalId: 'p',
      geometryCandidateId: 'g',
      decodeBinaryViewId: 'gray:otsu:normal',
      sampler: 'cross-vote',
      refinement: 'none',
      failure: 'timing-check',
    });
    trace.emit({
      type: 'decode-attempt-failed',
      proposalId: 'p',
      geometryCandidateId: 'g',
      decodeBinaryViewId: 'gray:otsu:normal',
      sampler: 'cross-vote',
      refinement: 'none',
      failure: 'decode_failed',
    });
    trace.emit({
      type: 'cluster-finished',
      clusterId: 'c1',
      clusterRank: 1,
      proposalCount: 2,
      representativeCount: 2,
      processedRepresentativeCount: 2,
      structuralFailureCount: 1,
      outcome: 'killed',
    });
    trace.emit({
      type: 'scan-finished',
      successCount: 0,
      proposalCount: 10,
      boundedProposalCount: 8,
      clusterCount: 3,
      representativeCount: 4,
      processedRepresentativeCount: 2,
      killedClusterCount: 1,
    });

    const summary = summarizeIronqrTrace(trace, 'summary');
    expect(summary.clustering?.clusterCount).toBe(3);
    expect(summary.scanFinished?.killedClusterCount).toBe(1);
    expect(summary.clusterOutcomes.killed).toBe(1);
    expect(summary.attemptFailures.timingCheck).toBe(1);
    expect(summary.attemptFailures.decodeFailed).toBe(1);
  });

  it('summarizes full traces and exposes the event count', () => {
    const trace = createTraceCollector();
    trace.emit({ type: 'scan-started', width: 1, height: 1 });
    trace.emit({
      type: 'proposal-generated',
      proposalId: 'p',
      proposalKind: 'finder-triple',
      binaryViewId: 'gray:otsu:normal',
      sources: ['row-scan'],
      estimatedVersions: [1],
    });
    trace.emit({
      type: 'scan-finished',
      successCount: 0,
      proposalCount: 1,
      boundedProposalCount: 1,
      clusterCount: 1,
      representativeCount: 1,
      processedRepresentativeCount: 0,
      killedClusterCount: 0,
    });

    const summary = summarizeIronqrTrace(trace, 'full');
    expect(summary.eventCount).toBe(3);
    expect(summary.events).toHaveLength(3);
  });
});
