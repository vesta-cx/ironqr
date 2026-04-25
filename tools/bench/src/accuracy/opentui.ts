import { formatCompactDuration } from './dashboard/format.js';
import { renderRunFooter } from './dashboard/frame.js';
import type { BenchDashboardModel } from './dashboard/model.js';
import { renderScorecard } from './dashboard/scorecard.js';
import {
  renderActiveWorkers,
  renderRecentScans,
  renderSlowestFreshScans,
} from './dashboard/tables.js';
import { renderTimingChart } from './dashboard/timing-chart.js';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiRenderer = Awaited<ReturnType<OpenTuiCore['createCliRenderer']>>;
type OpenTuiBox = InstanceType<OpenTuiCore['BoxRenderable']>;
type OpenTuiText = InstanceType<OpenTuiCore['TextRenderable']>;
type OpenTuiKeyEvent = import('@opentui/core').KeyEvent;

type OpenTuiPanel = {
  readonly box: OpenTuiBox;
  readonly body: OpenTuiText;
};

const CHART_PANEL_ROWS = 17;
const SCORECARD_PANEL_ROWS = 11;
const PANEL_BORDER_ROWS = 2;
const PANEL_TITLE_ROWS = 1;
const PANEL_BODY_BOTTOM_GUTTER_ROWS = 1;
const LEFT_COLUMN_RATIO = 0.42;
const ROOT_HORIZONTAL_PADDING = 8;
const TABLE_LAYOUT_RESERVED_ROWS = 26;
const RECENT_LAYOUT_RESERVED_ROWS = 24;
const PROGRESS_BAR_WIDTH = 24;
const DASHBOARD_REFRESH_INTERVAL_MS = 250;

const panelBodyRows = (panelRows: number): number =>
  Math.max(0, panelRows - PANEL_BORDER_ROWS - PANEL_TITLE_ROWS - PANEL_BODY_BOTTOM_GUTTER_ROWS);

const THEME = {
  background: '#07111f',
  panel: '#0f172a',
  panelAlt: '#111827',
  border: '#334155',
  cyan: '#22d3ee',
  blue: '#60a5fa',
  green: '#34d399',
  amber: '#fbbf24',
  red: '#fb7185',
  purple: '#c084fc',
  text: '#dbeafe',
  muted: '#94a3b8',
  white: '#f8fafc',
} as const;

export class BenchOpenTuiDashboard {
  private renderer: OpenTuiRenderer | null = null;
  private panels: {
    readonly header: OpenTuiText;
    readonly chart: OpenTuiPanel;
    readonly detectorChart: OpenTuiPanel | null;
    readonly scorecard: OpenTuiPanel;
    readonly active: OpenTuiPanel;
    readonly slowest: OpenTuiPanel;
    readonly recent: OpenTuiPanel;
    readonly footer: OpenTuiText;
  } | null = null;
  private startPromise: Promise<void> | null = null;
  private keyHandler: ((key: OpenTuiKeyEvent) => void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private renderQueued = false;
  private renderPaused = false;
  private stopped = false;
  private refreshTimer: NodeJS.Timeout | null = null;
  private studyViewTimingOffset = 0;
  private studyDetectorTimingOffset = 0;
  private focusedStudyWidget: 'views' | 'detectors' = 'views';

  constructor(
    private readonly dashboard: BenchDashboardModel,
    private readonly onQuit: () => void = () => {},
  ) {}

  start(): void {
    if (this.startPromise) return;
    this.startRefreshTimer();
    this.startPromise = this.startAsync();
  }

  update(): void {
    if (this.stopped) return;
    this.start();
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  stop(): void {
    this.render();
    this.cleanup();
    this.stopped = true;
  }

  private startRefreshTimer(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setInterval(() => {
      this.render();
    }, DASHBOARD_REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
  }

  private async startAsync(): Promise<void> {
    try {
      const { BoxRenderable, TextRenderable, createCliRenderer } = await import('@opentui/core');
      const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 12,
        screenMode: 'main-screen',
        clearOnShutdown: false,
        useMouse: false,
        enableMouseMovement: false,
      });
      if (this.stopped) {
        renderer.destroy();
        return;
      }

      this.renderer = renderer;
      renderer.setBackgroundColor(THEME.background);
      this.installQuitHandlers(renderer);

      const root = new BoxRenderable(renderer, {
        id: 'bench-dashboard-root',
        width: '100%',
        height: '100%',
        flexDirection: 'column',
        padding: 1,
        backgroundColor: THEME.background,
      });

      const headerBox = new BoxRenderable(renderer, {
        id: 'bench-dashboard-header',
        width: '100%',
        height: 3,
        flexDirection: 'row',
        alignItems: 'center',
        border: true,
        borderStyle: 'rounded',
        borderColor: THEME.cyan,
        backgroundColor: '#082f49',
        paddingLeft: 2,
      });
      const header = new TextRenderable(renderer, {
        id: 'bench-dashboard-header-text',
        content: '',
        fg: THEME.white,
        bg: 'transparent',
        selectable: false,
      });
      headerBox.add(header);

      const isStudy = this.dashboard.commandName === 'study';
      const chart = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'chart',
        title: isStudy ? 'Study view timings' : 'Timing by outcome',
        accent: THEME.cyan,
        height: CHART_PANEL_ROWS,
        ...(isStudy ? { width: '42%' } : {}),
      });
      const detectorChart = isStudy
        ? createPanel(BoxRenderable, TextRenderable, renderer, {
            id: 'detector-chart',
            title: 'Study detector timings',
            accent: THEME.purple,
            height: CHART_PANEL_ROWS,
            width: '58%',
          })
        : null;
      const scorecard = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'scorecard',
        title: isStudy ? 'Study events' : 'Accuracy scorecard',
        accent: THEME.green,
        height: SCORECARD_PANEL_ROWS,
      });

      const tablesRow = new BoxRenderable(renderer, {
        id: 'bench-dashboard-tables',
        width: '100%',
        flexGrow: 1,
        flexShrink: 1,
        flexDirection: 'row',
      });
      const leftColumn = new BoxRenderable(renderer, {
        id: 'bench-dashboard-left-column',
        width: `${LEFT_COLUMN_RATIO * 100}%`,
        height: '100%',
        flexDirection: 'column',
      });
      const active = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'active',
        title: isStudy ? 'Active study work' : 'Active workers',
        accent: THEME.blue,
        flexGrow: 1,
      });
      const slowest = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'slowest',
        title: isStudy ? 'Slowest study units' : 'Slowest fresh scans',
        accent: THEME.amber,
        flexGrow: 1,
      });
      leftColumn.add(active.box);
      leftColumn.add(slowest.box);

      const recent = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'recent',
        title: isStudy ? 'Recent study units' : 'Recent scans',
        accent: THEME.purple,
        flexGrow: 1,
      });
      tablesRow.add(leftColumn);
      tablesRow.add(recent.box);

      const footerBox = new BoxRenderable(renderer, {
        id: 'bench-dashboard-footer',
        width: '100%',
        height: 3,
        border: true,
        borderStyle: 'rounded',
        borderColor: THEME.border,
        backgroundColor: THEME.panelAlt,
        paddingLeft: 2,
        alignItems: 'center',
      });
      const footer = new TextRenderable(renderer, {
        id: 'bench-dashboard-footer-text',
        content: '',
        fg: THEME.muted,
        bg: 'transparent',
        selectable: false,
      });
      footerBox.add(footer);

      root.add(headerBox);
      if (detectorChart) {
        const chartRow = new BoxRenderable(renderer, {
          id: 'bench-dashboard-study-chart-row',
          width: '100%',
          height: CHART_PANEL_ROWS,
          flexDirection: 'row',
        });
        chartRow.add(chart.box);
        chartRow.add(detectorChart.box);
        root.add(chartRow);
      } else {
        root.add(chart.box);
      }
      root.add(scorecard.box);
      root.add(tablesRow);
      root.add(footerBox);
      renderer.root.add(root);
      renderer.start();

      this.panels = { header, chart, detectorChart, scorecard, active, slowest, recent, footer };
      this.render();
    } catch (error) {
      this.cleanup();
      this.stopped = true;
      process.stderr.write(
        `[bench] OpenTUI progress failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private installQuitHandlers(renderer: OpenTuiRenderer): void {
    this.keyHandler = (key: OpenTuiKeyEvent): void => {
      if (key.name === 'q' && !key.ctrl && !key.meta) {
        this.quit();
        return;
      }
      if (key.name === 'p' && !key.ctrl && !key.meta) {
        this.renderPaused = !this.renderPaused;
        this.renderNow();
        return;
      }
      if (this.dashboard.commandName === 'study' && isTabKey(key)) {
        this.focusNextStudyWidget();
        return;
      }
      if (this.dashboard.commandName === 'study' && isScrollDownKey(key)) {
        this.scrollFocusedStudyWidget(1);
        return;
      }
      if (this.dashboard.commandName === 'study' && isScrollUpKey(key)) {
        this.scrollFocusedStudyWidget(-1);
        return;
      }
      if ((key.name === 'c' && key.ctrl) || key.sequence === '\u0003') {
        this.quit();
      }
    };
    renderer.keyInput.on('keypress', this.keyHandler);

    this.sigintHandler = () => {
      this.quit();
    };
    process.once('SIGINT', this.sigintHandler);
  }

  private quit(): void {
    this.dashboard.stage = 'benchmark';
    this.dashboard.message = 'stopping after requested interrupt';
    this.cleanup();
    this.onQuit();
  }

  private focusNextStudyWidget(): void {
    this.focusedStudyWidget = this.focusedStudyWidget === 'views' ? 'detectors' : 'views';
    this.renderNow();
  }

  private scrollFocusedStudyWidget(delta: number): void {
    if (this.focusedStudyWidget === 'detectors') {
      const maxOffset = Math.max(0, this.dashboard.studyDetectorTimings.size - 1);
      this.studyDetectorTimingOffset = Math.min(
        maxOffset,
        Math.max(0, this.studyDetectorTimingOffset + delta),
      );
      this.renderNow();
      return;
    }
    const maxOffset = Math.max(0, this.dashboard.studyTimings.size - 1);
    this.studyViewTimingOffset = Math.min(
      maxOffset,
      Math.max(0, this.studyViewTimingOffset + delta),
    );
    this.renderNow();
  }

  private cleanup(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    const renderer = this.renderer;
    if (renderer && this.keyHandler) {
      renderer.keyInput.off('keypress', this.keyHandler);
    }
    if (this.sigintHandler) {
      process.off('SIGINT', this.sigintHandler);
    }
    this.keyHandler = null;
    this.sigintHandler = null;
    this.panels = null;
    this.renderer = null;
    renderer?.destroy();
  }

  private renderNow(): void {
    this.render(true);
    this.renderer?.requestRender();
  }

  private updateStudyFocusBorders(panels: NonNullable<BenchOpenTuiDashboard['panels']>): void {
    if (this.dashboard.commandName !== 'study' || !panels.detectorChart) return;
    panels.chart.box.borderColor = this.focusedStudyWidget === 'views' ? THEME.white : THEME.cyan;
    panels.detectorChart.box.borderColor =
      this.focusedStudyWidget === 'detectors' ? THEME.white : THEME.purple;
  }

  private render(force = false): void {
    const panels = this.panels;
    if (!panels || this.stopped || (this.renderPaused && !force)) return;

    const width = process.stdout.columns ?? process.stderr.columns ?? 120;
    const height = process.stdout.rows ?? process.stderr.rows ?? 40;
    const contentWidth = Math.max(36, width - ROOT_HORIZONTAL_PADDING);
    const studyViewChartWidth = Math.max(34, Math.floor(contentWidth * 0.42) - 4);
    const studyDetectorChartWidth = Math.max(40, contentWidth - studyViewChartWidth - 8);
    const leftWidth = Math.max(34, Math.floor(contentWidth * LEFT_COLUMN_RATIO) - 4);
    const recentWidth = Math.max(40, contentWidth - leftWidth - 8);
    const fallbackTableRows = Math.max(4, Math.floor((height - TABLE_LAYOUT_RESERVED_ROWS) / 2));
    const fallbackRecentRows = Math.max(4, height - RECENT_LAYOUT_RESERVED_ROWS);
    const tableRows = Math.min(
      fallbackTableRows,
      measuredPanelDataRows(panels.active.box.height, fallbackTableRows),
      measuredPanelDataRows(panels.slowest.box.height, fallbackTableRows),
    );
    const recentRows = Math.min(
      fallbackRecentRows,
      measuredPanelDataRows(panels.recent.box.height, fallbackRecentRows),
    );

    panels.header.content = headerText(this.dashboard);
    this.updateStudyFocusBorders(panels);
    const chartBodyRows = panelBodyRows(CHART_PANEL_ROWS);
    panels.chart.body.content = panelBody(
      this.dashboard.commandName === 'study'
        ? renderStudyViewTimings(this.dashboard, {
            width: studyViewChartWidth,
            maxRows: chartBodyRows,
            offset: this.studyViewTimingOffset,
            focused: this.focusedStudyWidget === 'views',
          })
        : renderTimingChart(this.dashboard, {
            width: contentWidth,
            barHeight: height < 34 ? 4 : 6,
          }),
      chartBodyRows,
    );
    if (panels.detectorChart) {
      panels.detectorChart.body.content = panelBody(
        renderStudyDetectorTimings(this.dashboard, {
          width: studyDetectorChartWidth,
          maxRows: chartBodyRows,
          offset: this.studyDetectorTimingOffset,
          focused: this.focusedStudyWidget === 'detectors',
        }),
        chartBodyRows,
      );
    }
    panels.scorecard.body.content = panelBody(
      this.dashboard.commandName === 'study'
        ? renderStudyEvents(this.dashboard, { width: contentWidth })
        : renderScorecard(this.dashboard, { width: contentWidth }),
      panelBodyRows(SCORECARD_PANEL_ROWS),
    );
    panels.active.body.content = panelBody(
      renderActiveWorkers(this.dashboard, {
        width: leftWidth,
        nowMs: Date.now(),
        maxRows: tableRows,
      }),
      tableRows + 1,
    );
    panels.slowest.body.content = panelBody(
      renderSlowestFreshScans(this.dashboard, { width: leftWidth, maxRows: tableRows }),
      tableRows + 1,
    );
    panels.recent.body.content = panelBody(
      renderRecentScans(this.dashboard, { width: recentWidth, maxRows: recentRows }),
      recentRows + 1,
    );
    panels.footer.content = `${renderRunFooter(this.dashboard)} | q=quit | p=${this.renderPaused ? 'resume' : 'freeze for copy'}${this.dashboard.commandName === 'study' ? ` | tab=focus ${this.focusedStudyWidget} | ↑/↓ j/k=scroll focused` : ''}`;
    this.renderer?.requestRender();
  }
}

const isTabKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'tab' || key.sequence === '\t') && !key.ctrl && !key.meta;

const isScrollDownKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'down' || key.name === 'j' || key.sequence === 'j') && !key.ctrl && !key.meta;

const isScrollUpKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'up' || key.name === 'k' || key.sequence === 'k') && !key.ctrl && !key.meta;

const createPanel = (
  BoxRenderable: OpenTuiCore['BoxRenderable'],
  TextRenderable: OpenTuiCore['TextRenderable'],
  renderer: OpenTuiRenderer,
  options: {
    readonly id: string;
    readonly title: string;
    readonly accent: string;
    readonly height?: number;
    readonly flexGrow?: number;
    readonly width?: number | 'auto' | `${number}%`;
  },
): OpenTuiPanel => {
  const boxOptions = {
    id: `bench-dashboard-${options.id}-panel`,
    width: options.width ?? '100%',
    flexShrink: 1,
    flexDirection: 'column',
    border: true,
    borderStyle: 'rounded',
    borderColor: options.accent,
    backgroundColor: THEME.panel,
    paddingLeft: 1,
    paddingRight: 1,
  } as const;
  const box = new BoxRenderable(renderer, {
    ...boxOptions,
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.flexGrow === undefined ? {} : { flexGrow: options.flexGrow }),
  });
  const title = new TextRenderable(renderer, {
    id: `bench-dashboard-${options.id}-title`,
    content: ` ${options.title.toUpperCase()} `,
    fg: options.accent,
    bg: 'transparent',
    selectable: false,
    width: '100%',
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
  });
  const body = new TextRenderable(renderer, {
    id: `bench-dashboard-${options.id}-body`,
    content: '',
    fg: THEME.text,
    bg: 'transparent',
    selectable: false,
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    wrapMode: 'none',
    truncate: true,
  });
  box.add(title);
  box.add(body);
  return { box, body };
};

const panelDataRows = (panelRows: number): number => Math.max(0, panelBodyRows(panelRows) - 1);

const measuredPanelDataRows = (panelRows: number, fallback: number): number => {
  return panelRows > 0 ? panelDataRows(panelRows) : fallback;
};

const panelBody = (lines: readonly string[], maxRows: number): string => {
  return lines.slice(1, maxRows + 1).join('\n');
};

const renderStudyViewTimings = (
  dashboard: BenchDashboardModel,
  options: {
    readonly width: number;
    readonly maxRows: number;
    readonly offset: number;
    readonly focused: boolean;
  },
): readonly string[] => {
  const cache = cacheTotals(dashboard);
  const lines = [
    'study view timings',
    truncateLine(
      `phase=${dashboard.stage} workers=${dashboard.workerCount || '-'} ${dashboard.message}`,
      options.width,
    ),
    truncateLine(
      `assets ${dashboard.preparedAssets}/${dashboard.assetCount} units ${dashboard.completedJobs}/${dashboard.totalJobs} active=${dashboard.activeScans.size}`,
      options.width,
    ),
    truncateLine(
      `cache=${dashboard.cacheEnabled ? 'on' : 'off'} h/m/w=${cache.hits}/${cache.misses}/${cache.writes}`,
      options.width,
    ),
  ];
  const chartRows = Math.max(4, options.maxRows - lines.length);
  lines.push(
    ...renderStudyTimingBars('views', [...dashboard.studyTimings.values()], {
      width: options.width,
      maxRows: chartRows,
      offset: options.offset,
      maxLabelWidth: 30,
    }),
  );
  return lines;
};

const renderStudyDetectorTimings = (
  dashboard: BenchDashboardModel,
  options: {
    readonly width: number;
    readonly maxRows: number;
    readonly offset: number;
    readonly focused: boolean;
  },
): readonly string[] => {
  const lines = [
    'study detector timings',
    truncateLine('a/b/d=candidates c=control', options.width),
  ];
  const chartRows = Math.max(4, options.maxRows - lines.length);
  lines.push(
    ...renderStudyTimingBars('detectors', [...dashboard.studyDetectorTimings.values()], {
      width: options.width,
      maxRows: chartRows,
      offset: options.offset,
      maxLabelWidth: 44,
    }),
  );
  return lines;
};

const renderStudyTimingBars = (
  title: string,
  inputRows: readonly { readonly id: string; readonly totalMs: number; readonly count: number }[],
  options: {
    readonly width: number;
    readonly maxRows: number;
    readonly offset: number;
    readonly maxLabelWidth: number;
  },
): readonly string[] => {
  const rows = [...inputRows].sort(
    (left, right) => averageStudyTimingMs(right) - averageStudyTimingMs(left),
  );
  if (rows.length === 0) return [truncateLine(`${title} 0/0 — waiting…`, options.width)];
  const maxBars = Math.max(1, options.maxRows - 2);
  const maxOffset = Math.max(0, rows.length - maxBars);
  const offset = Math.min(Math.max(0, options.offset), maxOffset);
  const visibleRows = rows.slice(offset, offset + maxBars);
  const first = offset + 1;
  const last = Math.min(rows.length, offset + visibleRows.length);
  const valueWidth = 14;
  const minBarWidth = 5;
  const labelWidth = Math.max(
    10,
    Math.min(options.maxLabelWidth, options.width - valueWidth - minBarWidth - 4),
  );
  const barWidth = Math.max(minBarWidth, options.width - labelWidth - valueWidth - 4);
  const maxAverage = Math.max(1, ...rows.map(averageStudyTimingMs));
  return [
    truncateLine(
      `${title} ${first}-${last}/${rows.length} pos=${offset + 1}/${rows.length}`,
      options.width,
    ),
    ...visibleRows.map((row) => {
      const average = averageStudyTimingMs(row);
      const filled = Math.max(1, Math.round((average / maxAverage) * barWidth));
      const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}`;
      return truncateLine(
        `${padStudyCell(row.id, labelWidth)} ${bar} ${formatStudyTiming(average, row.count)}`,
        options.width,
      );
    }),
  ];
};

const padStudyCell = (value: string, width: number): string => {
  const truncated = truncateLine(value, width);
  return `${truncated}${' '.repeat(Math.max(0, width - truncated.length))}`;
};

const averageStudyTimingMs = (row: { readonly totalMs: number; readonly count: number }): number =>
  row.totalMs / Math.max(1, row.count);

const formatStudyTiming = (averageMs: number, count: number): string =>
  `${formatCompactDuration(averageMs)} n=${count}`;

const renderStudyEvents = (
  dashboard: BenchDashboardModel,
  options: { readonly width: number },
): readonly string[] => {
  const rows = dashboard.studyEvents.slice(-8).reverse();
  const lines = ['study events'];
  if (rows.length === 0) {
    lines.push('none yet');
    return lines;
  }
  for (const row of rows) lines.push(truncateLine(row, options.width));
  return lines;
};

const cacheTotals = (dashboard: BenchDashboardModel) => {
  let hits = 0;
  let misses = 0;
  let writes = 0;
  for (const engine of dashboard.engines.values()) {
    hits += engine.cacheHits;
    misses += engine.cacheMisses;
    writes += engine.cacheWrites;
  }
  return { hits, misses, writes };
};

const truncateLine = (value: string, width: number): string =>
  value.length > width ? value.slice(0, Math.max(0, width - 1)) : value;

const headerText = (dashboard: BenchDashboardModel): string => {
  const percent = clamp01(
    dashboard.totalJobs > 0 ? dashboard.completedJobs / dashboard.totalJobs : 0,
  );
  const completeWidth = Math.round(percent * PROGRESS_BAR_WIDTH);
  const progress = `${'█'.repeat(completeWidth)}${'░'.repeat(PROGRESS_BAR_WIDTH - completeWidth)}`;
  return `IRONQR BENCH  ${stageBadge(dashboard.stage)}  ${progress}  ${dashboard.completedJobs}/${dashboard.totalJobs} jobs  ${dashboard.message}`;
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const stageBadge = (stage: BenchDashboardModel['stage']): string => {
  if (stage === 'done') return 'DONE';
  if (stage === 'benchmark') return 'RUN';
  return stage.toUpperCase();
};
