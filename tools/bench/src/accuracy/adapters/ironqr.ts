import {
  createTraceCollector,
  createTraceCounter,
  scanFrame,
} from '../../../../../packages/ironqr/src/index.js';
import type {
  ClusterFinishedEvent,
  IronqrTraceEvent,
  ProposalClustersBuiltEvent,
  ScanFinishedEvent,
  TraceCollector,
  TraceCounter,
} from '../../../../../packages/ironqr/src/pipeline/trace.js';
import { normalizeDecodedText } from '../../shared/text.js';
import type {
  AccuracyEngine,
  AccuracyEngineRunOptions,
  AccuracyScanDiagnostics,
  AccuracyScanResult,
  EngineFailureReason,
  IronqrTraceMode,
} from '../types.js';
import { createAvailableAvailability, failureResult, successResult } from './shared.js';

type IronqrTraceSummary = Partial<Record<IronqrTraceEvent['type'], number>>;

type IronqrFailureTrace = readonly IronqrTraceEvent[] | IronqrTraceSummary;

type IronqrTraceSource = TraceCollector | TraceCounter;

/** Infer the deepest first-party failure stage from ironqr trace activity. */
export const classifyIronqrFailure = (trace: IronqrFailureTrace): EngineFailureReason => {
  if (hasTraceEvent(trace, 'decode-attempt-started')) {
    return 'failed_to_decode';
  }
  if (hasTraceEvent(trace, 'geometry-candidate-created')) {
    return 'failed_to_decode';
  }
  if (hasTraceEvent(trace, 'proposal-generated')) {
    return 'failed_to_resolve_geometry';
  }
  return 'failed_to_find_finders';
};

const hasTraceEvent = (trace: IronqrFailureTrace, type: IronqrTraceEvent['type']): boolean => {
  if (Array.isArray(trace)) {
    return trace.some((event) => event.type === type);
  }
  const summary = trace as IronqrTraceSummary;
  return (summary[type] ?? 0) > 0;
};

export const summarizeIronqrTrace = (
  trace: IronqrTraceSource,
  traceMode: IronqrTraceMode,
): AccuracyScanDiagnostics => {
  const source = traceSource(trace);
  const counts =
    source.kind === 'collector' ? countTraceEvents(source.events) : { ...source.counter.counts };
  const clustering =
    source.kind === 'counter'
      ? source.counter.clustering
      : (source.events.find(
          (event): event is ProposalClustersBuiltEvent => event.type === 'proposal-clusters-built',
        ) ?? null);
  const scanFinished =
    source.kind === 'counter'
      ? source.counter.scanFinished
      : (source.events.find(
          (event): event is ScanFinishedEvent => event.type === 'scan-finished',
        ) ?? null);
  const clusterFinishedEvents =
    source.kind === 'counter'
      ? [...source.counter.clusterOutcomes]
      : source.events.filter(
          (event): event is ClusterFinishedEvent => event.type === 'cluster-finished',
        );

  return {
    kind: 'ironqr-trace',
    traceMode,
    counts,
    clustering,
    scanFinished,
    clusterOutcomes: {
      decoded: clusterFinishedEvents.filter((event) => event.outcome === 'decoded').length,
      duplicate: clusterFinishedEvents.filter((event) => event.outcome === 'duplicate').length,
      killed: clusterFinishedEvents.filter((event) => event.outcome === 'killed').length,
      exhausted: clusterFinishedEvents.filter((event) => event.outcome === 'exhausted').length,
    },
    attemptFailures: {
      timingCheck:
        source.kind === 'counter'
          ? (source.counter.attemptFailures['timing-check'] ?? 0)
          : countAttemptFailures(source.events, 'timing-check'),
      decodeFailed:
        source.kind === 'counter'
          ? (source.counter.attemptFailures.decode_failed ?? 0)
          : countAttemptFailures(source.events, 'decode_failed'),
      internalError:
        source.kind === 'counter'
          ? (source.counter.attemptFailures.internal_error ?? 0)
          : countAttemptFailures(source.events, 'internal_error'),
    },
    ...(source.kind === 'collector' ? { eventCount: source.events.length } : {}),
    ...(source.kind === 'collector' && traceMode === 'full' ? { events: source.events } : {}),
  };
};

const traceSource = (
  trace: IronqrTraceSource,
):
  | { readonly kind: 'collector'; readonly events: readonly IronqrTraceEvent[] }
  | { readonly kind: 'counter'; readonly counter: TraceCounter } => {
  if ('events' in trace) return { kind: 'collector', events: trace.events };
  return { kind: 'counter', counter: trace };
};

const countTraceEvents = (events: readonly IronqrTraceEvent[]): IronqrTraceSummary => {
  const counts: IronqrTraceSummary = {};
  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  return counts;
};

const countAttemptFailures = (
  events: readonly IronqrTraceEvent[],
  failure: 'timing-check' | 'decode_failed' | 'internal_error',
): number => {
  return events.filter(
    (event) => event.type === 'decode-attempt-failed' && event.failure === failure,
  ).length;
};

const createIronqrTrace = (mode: IronqrTraceMode): IronqrTraceSource | null => {
  switch (mode) {
    case 'off':
      return null;
    case 'full':
      return createTraceCollector();
    default:
      return createTraceCounter();
  }
};

const scanWithIronqr = async (
  asset: Parameters<AccuracyEngine['scan']>[0],
  options: AccuracyEngineRunOptions = {},
): Promise<AccuracyScanResult> => {
  const traceMode = options.ironqrTraceMode ?? 'summary';
  const trace = createIronqrTrace(traceMode);
  try {
    const image = await asset.loadImage();
    const allowMultiple = asset.expectedTexts.length > 1;
    const results = await scanFrame(image, {
      allowMultiple,
      ...(trace === null ? {} : { traceSink: trace }),
    });
    const diagnostics = trace === null ? null : summarizeIronqrTrace(trace, traceMode);
    if (results.length === 0) {
      return successResult(
        [],
        trace === null
          ? 'no_decode'
          : classifyIronqrFailure('counts' in trace ? trace.counts : trace.events),
        diagnostics,
      );
    }
    return successResult(
      results.flatMap((result) => {
        const text = normalizeDecodedText(result.payload.text);
        return text.length > 0
          ? [{ text, ...(result.payload.kind ? { kind: result.payload.kind } : {}) }]
          : [];
      }),
      null,
      diagnostics,
    );
  } catch (error) {
    return failureResult(
      error,
      'engine_error',
      trace === null ? null : summarizeIronqrTrace(trace, traceMode),
    );
  }
};

export const ironqrAccuracyEngine: AccuracyEngine = {
  id: 'ironqr',
  kind: 'first-party',
  capabilities: {
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'js',
  },
  cache: { enabled: true, version: 'live-pass-v1', mode: 'pass-only' },
  availability: createAvailableAvailability,
  scan: scanWithIronqr,
};
