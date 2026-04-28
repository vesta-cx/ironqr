const STUDY_TIMING_PREFIX = '__bench_study_timing__';
const DASHBOARD_EVENT_BATCH_BUDGET_MS = 8;
const DASHBOARD_EVENT_BATCH_MAX_ITEMS = 500;

export type StudyTimingEvent = {
  readonly id: string;
  readonly durationMs: number;
  readonly group?: 'view' | 'detector';
  readonly outputCount?: number;
  readonly cached?: boolean;
};

export interface StudyDashboardEventQueue {
  readonly enqueue: (message: string) => void;
  readonly flush: (drain: boolean) => void;
  readonly cancel: () => void;
}

export const createStudyDashboardEventQueue = (options: {
  readonly commandName: string;
  readonly setMessage: (message: string) => void;
  readonly pushEvent: (message: string) => void;
  readonly onTiming: (event: StudyTimingEvent) => void;
  readonly render: () => void;
}): StudyDashboardEventQueue => {
  const pendingStudyTimings: StudyTimingEvent[] = [];
  const pendingMessages: string[] = [];
  let pendingStudyTimingCursor = 0;
  let pendingMessageCursor = 0;
  let flushTimer: NodeJS.Timeout | null = null;

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => flush(false), 0);
  };

  const compactProcessedEvents = (): void => {
    if (pendingMessageCursor > 0 && pendingMessageCursor >= pendingMessages.length) {
      pendingMessages.length = 0;
      pendingMessageCursor = 0;
    }
    if (pendingStudyTimingCursor > 0 && pendingStudyTimingCursor >= pendingStudyTimings.length) {
      pendingStudyTimings.length = 0;
      pendingStudyTimingCursor = 0;
    }
  };

  const flush = (drain: boolean): void => {
    flushTimer = null;
    const startedAt = performance.now();
    let processed = 0;
    while (pendingMessageCursor < pendingMessages.length) {
      const message = pendingMessages[pendingMessageCursor];
      pendingMessageCursor += 1;
      if (message === undefined) break;
      options.setMessage(`${options.commandName}: ${message}`);
      options.pushEvent(message);
      processed += 1;
      if (!drain && shouldPauseDashboardFlush(startedAt, processed)) break;
    }
    compactProcessedEvents();
    while (
      pendingMessageCursor >= pendingMessages.length &&
      pendingStudyTimingCursor < pendingStudyTimings.length
    ) {
      const studyTiming = pendingStudyTimings[pendingStudyTimingCursor];
      pendingStudyTimingCursor += 1;
      if (studyTiming === undefined) break;
      options.onTiming(studyTiming);
      if (!studyTiming.cached) options.pushEvent(formatStudyTimingEvent(studyTiming));
      processed += 1;
      if (!drain && shouldPauseDashboardFlush(startedAt, processed)) break;
    }
    if (processed > 0) options.render();
    compactProcessedEvents();
    if (
      !drain &&
      (pendingMessageCursor < pendingMessages.length ||
        pendingStudyTimingCursor < pendingStudyTimings.length)
    ) {
      scheduleFlush();
    }
  };

  return {
    enqueue: (message) => {
      const studyTiming = parseStudyTimingMessage(message);
      if (studyTiming) pendingStudyTimings.push(studyTiming);
      else pendingMessages.push(message);
      scheduleFlush();
    },
    flush,
    cancel: () => {
      if (flushTimer === null) return;
      clearTimeout(flushTimer);
      flushTimer = null;
    },
  };
};

const shouldPauseDashboardFlush = (startedAt: number, processed: number): boolean =>
  processed >= DASHBOARD_EVENT_BATCH_MAX_ITEMS ||
  performance.now() - startedAt >= DASHBOARD_EVENT_BATCH_BUDGET_MS;

const formatStudyTimingEvent = (event: StudyTimingEvent): string => {
  const group = event.group ?? 'study';
  const output = event.outputCount === undefined ? '' : ` outputs=${event.outputCount}`;
  return `${group} ${event.id} ${formatStudyTimingDuration(event.durationMs)}${output}`;
};

const formatStudyTimingDuration = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '-';
  if (durationMs < 1_000) return `${Math.round(durationMs * 10) / 10}ms`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 100) / 10}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
};

const parseStudyTimingMessage = (message: string): StudyTimingEvent | null => {
  if (!message.startsWith(STUDY_TIMING_PREFIX)) return null;
  try {
    const payload = JSON.parse(message.slice(STUDY_TIMING_PREFIX.length)) as Record<
      string,
      unknown
    >;
    if (typeof payload.id !== 'string' || typeof payload.durationMs !== 'number') return null;
    const group =
      payload.group === 'detector' || payload.group === 'view' ? payload.group : undefined;
    const outputCount = typeof payload.outputCount === 'number' ? payload.outputCount : undefined;
    const cached = typeof payload.cached === 'boolean' ? payload.cached : undefined;
    return {
      id: payload.id,
      durationMs: payload.durationMs,
      ...(group === undefined ? {} : { group }),
      ...(outputCount === undefined ? {} : { outputCount }),
      ...(cached === undefined ? {} : { cached }),
    };
  } catch {
    return null;
  }
};
