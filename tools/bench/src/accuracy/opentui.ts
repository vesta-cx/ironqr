import { formatCompactDuration } from './dashboard/format.js';
import { renderRunFooter } from './dashboard/frame.js';
import type { BenchDashboardModel } from './dashboard/model.js';
import { renderScorecard } from './dashboard/scorecard.js';
import {
  renderActiveWorkers,
  renderRecentScans,
  renderSlowestFreshScans,
  type StudySlowestMetric,
} from './dashboard/tables.js';
import { renderTimingChart } from './dashboard/timing-chart.js';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiRenderer = Awaited<ReturnType<OpenTuiCore['createCliRenderer']>>;
type OpenTuiBox = InstanceType<OpenTuiCore['BoxRenderable']>;
type OpenTuiText = InstanceType<OpenTuiCore['TextRenderable']>;
type OpenTuiKeyEvent = import('@opentui/core').KeyEvent;
type StudyFocusWidget = 'views' | 'detectors' | 'active' | 'slowest' | 'events' | 'legend';

type OpenTuiPanel = {
  readonly box: OpenTuiBox;
  readonly body: OpenTuiText;
};

const CHART_PANEL_ROWS = 18;
const SCORECARD_PANEL_ROWS = 11;
const PANEL_BORDER_ROWS = 2;
const PANEL_TITLE_ROWS = 0;
const PANEL_BODY_BOTTOM_GUTTER_ROWS = 0;
const LEFT_COLUMN_RATIO = 0.42;
const ROOT_HORIZONTAL_PADDING = 8;
const TABLE_LAYOUT_RESERVED_ROWS = 26;
const RECENT_LAYOUT_RESERVED_ROWS = 24;
const PROGRESS_BAR_WIDTH = 56;
const DASHBOARD_REFRESH_INTERVAL_MS = 250;
const TABLE_ROW_FILL_SLACK = 6;
const ACTIVE_WORKER_MAX_BODY_ROWS = 11;
const FILTER_MODAL_MIN_ROWS = 22;
const FILTER_MODAL_MAX_ROWS = 30;
const FILTER_MODAL_WIDTH_RATIO = 0.42;
const FILTER_MODAL_MIN_WIDTH = 56;
const FILTER_MODAL_MAX_WIDTH = 80;

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
    readonly legend: OpenTuiPanel;
    readonly filterModal: OpenTuiPanel;
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
  private activeStudyWorkOffset = 0;
  private slowestStudyUnitsOffset = 0;
  private studyEventsOffset = 0;
  private studyLegendOffset = 0;
  private focusedStudyWidget: StudyFocusWidget = 'views';
  private filterModalOpen = false;
  private filterCursor = 0;
  private filterOffset = 0;
  private studySlowestMetric: StudySlowestMetric = 'p98';
  private readonly studyFilters: Record<'views' | 'detectors', StudyChartFilters> = {
    views: createStudyChartFilters(),
    detectors: createStudyChartFilters(),
  };

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
        screenMode: 'alternate-screen',
        clearOnShutdown: true,
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
        selectable: true,
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
        ...(isStudy ? { flexGrow: 1 } : { height: SCORECARD_PANEL_ROWS }),
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
        title: isStudy ? 'Study events' : 'Recent scans',
        accent: THEME.purple,
        flexGrow: 1,
        ...(isStudy ? { width: '68%' } : {}),
      });
      const legend = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'legend',
        title: 'Study legend',
        accent: THEME.cyan,
        width: '32%',
        flexGrow: 1,
      });
      const rightColumn = new BoxRenderable(renderer, {
        id: 'bench-dashboard-right-column',
        width: `${(1 - LEFT_COLUMN_RATIO) * 100}%`,
        height: '100%',
        flexDirection: 'row',
      });
      tablesRow.add(leftColumn);
      if (isStudy) {
        rightColumn.add(recent.box);
        rightColumn.add(legend.box);
        tablesRow.add(rightColumn);
      } else {
        tablesRow.add(recent.box);
      }

      const filterModal = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'filter-modal',
        title: 'Study filters',
        accent: THEME.white,
        width: '80%',
        height: FILTER_MODAL_MIN_ROWS,
        position: 'absolute',
        top: '25%',
        left: '15%',
        zIndex: 10,
      });
      filterModal.box.visible = false;

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
        selectable: true,
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
      if (!isStudy) root.add(scorecard.box);
      root.add(tablesRow);
      root.add(footerBox);
      root.add(filterModal.box);
      renderer.root.add(root);
      renderer.start();

      this.panels = {
        header,
        chart,
        detectorChart,
        scorecard,
        active,
        slowest,
        recent,
        legend,
        filterModal,
        footer,
      };
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
      if (this.dashboard.commandName === 'study' && this.filterModalOpen) {
        if (isFilterCloseKey(key)) {
          this.filterModalOpen = false;
          this.renderNow();
          return;
        }
        if (isScrollDownKey(key)) {
          this.moveFilterCursor(1);
          return;
        }
        if (isScrollUpKey(key)) {
          this.moveFilterCursor(-1);
          return;
        }
        if (isSpaceKey(key)) {
          this.toggleSelectedFilter();
          return;
        }
        if (key.name === 'a' || key.sequence === 'a') {
          this.clearFocusedFilters();
          return;
        }
      }
      if (key.name === 'q' && !key.ctrl && !key.meta) {
        this.quit();
        return;
      }
      if (key.name === 'p' && !key.ctrl && !key.meta) {
        this.renderPaused = !this.renderPaused;
        this.renderNow();
        return;
      }
      if (this.dashboard.commandName === 'study' && (key.name === 'f' || key.sequence === 'f')) {
        this.filterModalOpen = true;
        this.filterCursor = 0;
        this.filterOffset = 0;
        this.renderNow();
        return;
      }
      if (this.dashboard.commandName === 'study' && isTabKey(key)) {
        this.focusNextStudyWidget();
        return;
      }
      if (this.dashboard.commandName === 'study' && isScrollDownKey(key)) {
        this.scrollFocusedStudyWidget(1, isSingleRowScrollKey(key));
        return;
      }
      if (this.dashboard.commandName === 'study' && isScrollUpKey(key)) {
        this.scrollFocusedStudyWidget(-1, isSingleRowScrollKey(key));
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
    const widgets = this.focusableStudyWidgets();
    const index = widgets.indexOf(this.focusedStudyWidget);
    this.focusedStudyWidget = widgets[(index + 1 + widgets.length) % widgets.length] ?? 'detectors';
    this.renderNow();
  }

  private focusableStudyWidgets(): readonly StudyFocusWidget[] {
    return this.hasStudyViewTimings()
      ? ['views', 'detectors', 'active', 'slowest', 'events', 'legend']
      : ['detectors', 'active', 'slowest', 'events', 'legend'];
  }

  private focusedFilterTarget(): 'views' | 'detectors' {
    return this.focusedStudyWidget === 'views' ? 'views' : 'detectors';
  }

  private hasStudyViewTimings(): boolean {
    return this.dashboard.studyTimings.size > 0;
  }

  private scrollFocusedStudyWidget(delta: number, singleRow: boolean): void {
    const step = singleRow ? 1 : this.studyPageScrollSize();
    const scrollDelta = delta * step;
    switch (this.focusedStudyWidget) {
      case 'views':
        this.studyViewTimingOffset = clampOffset(
          this.studyViewTimingOffset + scrollDelta,
          this.dashboard.studyTimings.size,
        );
        break;
      case 'detectors':
        this.studyDetectorTimingOffset = clampOffset(
          this.studyDetectorTimingOffset + scrollDelta,
          this.dashboard.studyDetectorTimings.size,
        );
        break;
      case 'active':
        this.activeStudyWorkOffset = clampOffset(
          this.activeStudyWorkOffset + scrollDelta,
          this.dashboard.activeScans.size,
        );
        break;
      case 'slowest':
        this.slowestStudyUnitsOffset = clampOffset(
          this.slowestStudyUnitsOffset + scrollDelta,
          this.studySlowestRowCount(),
        );
        break;
      case 'events':
        this.studyEventsOffset = clampOffset(
          this.studyEventsOffset + scrollDelta,
          this.dashboard.studyEvents.length,
        );
        break;
      case 'legend':
        this.studyLegendOffset = clampOffset(
          this.studyLegendOffset + scrollDelta,
          studyLegendLineCount(),
        );
        break;
    }
    this.renderNow();
  }

  private studySlowestRowCount(): number {
    return [
      ...this.dashboard.studyDetectorTimings.values(),
      ...this.dashboard.studyTimings.values(),
    ].filter((row) => matchesStudyFilters(row, this.studyFilters[this.focusedFilterTarget()]))
      .length;
  }

  private studyPageScrollSize(): number {
    return Math.max(1, panelBodyRows(CHART_PANEL_ROWS) - 4);
  }

  private moveFilterCursor(delta: number): void {
    const count = selectableFilterRows().length;
    this.filterCursor = (this.filterCursor + delta + count) % count;
    this.ensureFilterCursorVisible();
    this.renderNow();
  }

  private ensureFilterCursorVisible(): void {
    const selectableCount = selectableFilterRows().length;
    const visibleIndexes = renderedFilterOptionIndexes(
      this.filterOffset,
      this.filterModalBodyRows(),
    );
    if (visibleIndexes.includes(this.filterCursor)) return;
    if (this.filterCursor < this.filterOffset) {
      this.filterOffset = this.filterCursor;
      return;
    }
    this.filterOffset = Math.max(0, Math.min(selectableCount - 1, this.filterCursor));
    while (
      this.filterOffset > 0 &&
      !renderedFilterOptionIndexes(this.filterOffset, this.filterModalBodyRows()).includes(
        this.filterCursor,
      )
    ) {
      this.filterOffset -= 1;
    }
  }

  private filterModalRows(): number {
    return Math.min(FILTER_MODAL_MAX_ROWS, this.renderer?.terminalHeight ?? FILTER_MODAL_MAX_ROWS);
  }

  private filterModalBodyRows(): number {
    return panelBodyRows(this.filterModalRows());
  }

  private centerFilterModal(): void {
    if (!this.panels || !this.renderer) return;
    const width = Math.min(
      FILTER_MODAL_MAX_WIDTH,
      Math.max(
        FILTER_MODAL_MIN_WIDTH,
        Math.floor(this.renderer.terminalWidth * FILTER_MODAL_WIDTH_RATIO),
      ),
    );
    const height = this.filterModalRows();
    this.panels.filterModal.box.width = width;
    this.panels.filterModal.box.height = height;
    this.panels.filterModal.box.left = Math.max(
      0,
      Math.floor((this.renderer.terminalWidth - width) / 2),
    );
    this.panels.filterModal.box.top = Math.max(
      0,
      Math.floor((this.renderer.terminalHeight - height) / 2),
    );
  }

  private toggleSelectedFilter(): void {
    const row = selectableFilterRows()[this.filterCursor];
    if (!row) return;
    if (row.group === 'metric') {
      this.studySlowestMetric = row.value as StudySlowestMetric;
      this.renderNow();
      return;
    }
    const filters = this.studyFilters[this.focusedFilterTarget()];
    const values = filters[row.group];
    if (values.has(row.value)) values.delete(row.value);
    else values.add(row.value);
    this.studyViewTimingOffset = 0;
    this.studyDetectorTimingOffset = 0;
    this.renderNow();
  }

  private clearFocusedFilters(): void {
    const filters = this.studyFilters[this.focusedFilterTarget()];
    filters.families.clear();
    filters.scalars.clear();
    filters.thresholds.clear();
    filters.polarities.clear();
    filters.cache.clear();
    this.studyViewTimingOffset = 0;
    this.studyDetectorTimingOffset = 0;
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
    if (this.dashboard.commandName !== 'study') return;
    panels.chart.box.borderColor = this.focusedStudyWidget === 'views' ? THEME.white : THEME.cyan;
    if (panels.detectorChart) {
      panels.detectorChart.box.borderColor =
        this.focusedStudyWidget === 'detectors' ? THEME.white : THEME.purple;
    }
    panels.active.box.borderColor = this.focusedStudyWidget === 'active' ? THEME.white : THEME.blue;
    panels.slowest.box.borderColor =
      this.focusedStudyWidget === 'slowest' ? THEME.white : THEME.amber;
    panels.recent.box.borderColor =
      this.focusedStudyWidget === 'events' ? THEME.white : THEME.purple;
    panels.legend.box.borderColor = this.focusedStudyWidget === 'legend' ? THEME.white : THEME.cyan;
  }

  private render(force = false): void {
    const panels = this.panels;
    if (!panels || this.stopped || (this.renderPaused && !force)) return;

    const width = process.stdout.columns ?? process.stderr.columns ?? 120;
    const height = process.stdout.rows ?? process.stderr.rows ?? 40;
    const contentWidth = Math.max(36, width - ROOT_HORIZONTAL_PADDING);
    if (this.filterModalOpen) {
      this.centerFilterModal();
      this.ensureFilterCursorVisible();
    }
    const showStudyViewChart = this.dashboard.commandName !== 'study' || this.hasStudyViewTimings();
    if (
      this.dashboard.commandName === 'study' &&
      !showStudyViewChart &&
      this.focusedStudyWidget === 'views'
    ) {
      this.focusedStudyWidget = 'detectors';
    }
    const studyViewChartWidth = Math.max(34, Math.floor(contentWidth * 0.42) - 4);
    const studyDetectorChartWidth = showStudyViewChart
      ? Math.max(40, contentWidth - studyViewChartWidth - 8)
      : Math.max(40, contentWidth - 4);
    const leftWidth = Math.max(34, Math.floor(contentWidth * LEFT_COLUMN_RATIO) - 4);
    const rightWidth = Math.max(40, contentWidth - leftWidth - 8);
    const legendWidth =
      this.dashboard.commandName === 'study' ? Math.max(24, Math.floor(rightWidth * 0.32) - 4) : 0;
    const recentWidth =
      this.dashboard.commandName === 'study'
        ? Math.max(40, rightWidth - legendWidth - 8)
        : rightWidth;
    const fallbackTableRows = Math.max(
      4,
      Math.floor((height - TABLE_LAYOUT_RESERVED_ROWS) / 2) + TABLE_ROW_FILL_SLACK,
    );
    const fallbackRecentRows = Math.max(
      4,
      height - RECENT_LAYOUT_RESERVED_ROWS + TABLE_ROW_FILL_SLACK,
    );
    const tableRows = fallbackTableRows;
    const activeRows =
      this.dashboard.commandName === 'study'
        ? Math.min(ACTIVE_WORKER_MAX_BODY_ROWS, tableRows)
        : tableRows;
    const recentRows = fallbackRecentRows;
    const eventRows = fallbackRecentRows;

    panels.header.content = headerText(this.dashboard, contentWidth);
    if (this.dashboard.commandName === 'study' && panels.detectorChart) {
      panels.chart.box.visible = showStudyViewChart;
      panels.chart.box.width = showStudyViewChart ? '42%' : 0;
      panels.detectorChart.box.width = showStudyViewChart ? '58%' : '100%';
    }
    this.updateStudyFocusBorders(panels);
    const chartBodyRows = panelBodyRows(CHART_PANEL_ROWS);
    panels.chart.body.content = showStudyViewChart
      ? panelBody(
          this.dashboard.commandName === 'study'
            ? renderStudyViewTimings(this.dashboard, {
                width: studyViewChartWidth,
                maxRows: chartBodyRows,
                offset: this.studyViewTimingOffset,
                focused: this.focusedStudyWidget === 'views',
                filters: this.studyFilters.views,
              })
            : renderTimingChart(this.dashboard, {
                width: contentWidth,
                barHeight: height < 34 ? 4 : 6,
              }),
          chartBodyRows,
        )
      : '';
    if (panels.detectorChart) {
      panels.detectorChart.body.content = panelBody(
        renderStudyDetectorTimings(this.dashboard, {
          width: studyDetectorChartWidth,
          maxRows: chartBodyRows,
          offset: this.studyDetectorTimingOffset,
          focused: this.focusedStudyWidget === 'detectors',
          filters: this.studyFilters.detectors,
        }),
        chartBodyRows,
      );
    }
    panels.scorecard.body.content = panelBody(
      this.dashboard.commandName === 'study'
        ? renderStudyEvents(this.dashboard, { width: recentWidth, maxRows: eventRows })
        : renderScorecard(this.dashboard, { width: contentWidth }),
      this.dashboard.commandName === 'study' ? eventRows + 1 : panelBodyRows(SCORECARD_PANEL_ROWS),
    );
    panels.filterModal.box.visible = this.dashboard.commandName === 'study' && this.filterModalOpen;
    panels.filterModal.body.content = this.filterModalOpen
      ? panelBody(
          renderStudyFilterModal({
            width: Math.max(40, panels.filterModal.box.width - 4),
            focus: this.focusedFilterTarget(),
            filters: this.studyFilters[this.focusedFilterTarget()],
            cursor: this.filterCursor,
            slowestMetric: this.studySlowestMetric,
            offset: this.filterOffset,
            maxRows: this.filterModalBodyRows(),
          }),
          this.filterModalBodyRows(),
        )
      : '';
    panels.active.body.content = panelBody(
      renderActiveWorkers(this.dashboard, {
        width: leftWidth,
        nowMs: Date.now(),
        maxRows: activeRows,
        offset: this.activeStudyWorkOffset,
      }),
      activeRows,
    );
    panels.slowest.body.content = panelBody(
      renderSlowestFreshScans(this.dashboard, {
        width: leftWidth,
        maxRows: tableRows,
        offset: this.slowestStudyUnitsOffset,
        studySlowestMetric: this.studySlowestMetric,
        ...(this.dashboard.commandName === 'study'
          ? { studyTimingFilters: this.studyFilters[this.focusedFilterTarget()] }
          : {}),
      }),
      tableRows,
    );
    panels.recent.body.content = panelBody(
      this.dashboard.commandName === 'study'
        ? renderStudyEvents(this.dashboard, {
            width: recentWidth,
            maxRows: recentRows,
            offset: this.studyEventsOffset,
          })
        : renderRecentScans(this.dashboard, { width: recentWidth, maxRows: recentRows }),
      recentRows,
    );
    panels.legend.box.visible = this.dashboard.commandName === 'study';
    panels.legend.body.content = panelBody(
      this.dashboard.commandName === 'study'
        ? renderStudyLegend({
            width: legendWidth,
            maxRows: recentRows,
            offset: this.studyLegendOffset,
          })
        : [],
      recentRows,
    );
    const footerStatus =
      this.dashboard.commandName === 'study'
        ? renderStudyFooterStatus(this.dashboard)
        : renderRunFooter(this.dashboard);
    const focusHint = this.hasStudyViewTimings()
      ? ` | tab=focus ${this.focusedStudyWidget}`
      : ' | focus detectors';
    panels.footer.content = `${footerStatus} | q=quit | p=${this.renderPaused ? 'resume' : 'freeze for copy'}${this.dashboard.commandName === 'study' ? `${focusHint} | metric=${this.studySlowestMetric} | f=filters | ↑/↓=page | opt+↑/↓ or j/k=line` : ''}`;
    this.renderer?.requestRender();
  }
}

const clampOffset = (offset: number, rowCount: number): number =>
  Math.min(Math.max(0, rowCount - 1), Math.max(0, offset));

const isTabKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'tab' || key.sequence === '\t') && !key.ctrl && !key.meta;

const isScrollDownKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'down' || key.name === 'j' || key.sequence === 'j') && !key.ctrl;

const isScrollUpKey = (key: OpenTuiKeyEvent): boolean =>
  (key.name === 'up' || key.name === 'k' || key.sequence === 'k') && !key.ctrl;

const isSingleRowScrollKey = (key: OpenTuiKeyEvent): boolean =>
  key.name === 'j' ||
  key.sequence === 'j' ||
  key.name === 'k' ||
  key.sequence === 'k' ||
  key.option ||
  key.meta;

const isSpaceKey = (key: OpenTuiKeyEvent): boolean => key.name === 'space' || key.sequence === ' ';

const isFilterCloseKey = (key: OpenTuiKeyEvent): boolean =>
  key.name === 'escape' || key.sequence === '\u001b' || key.name === 'f' || key.sequence === 'f';

type StudyFilterGroup = 'families' | 'scalars' | 'thresholds' | 'polarities' | 'cache' | 'metric';

interface StudyChartFilters {
  readonly families: Set<string>;
  readonly scalars: Set<string>;
  readonly thresholds: Set<string>;
  readonly polarities: Set<string>;
  readonly cache: Set<string>;
}

const createStudyChartFilters = (): StudyChartFilters => ({
  families: new Set(),
  scalars: new Set(),
  thresholds: new Set(),
  polarities: new Set(),
  cache: new Set(),
});

type StudyFilterRow =
  | { readonly kind: 'heading'; readonly label: string }
  | { readonly kind: 'option'; readonly group: StudyFilterGroup; readonly value: string };

const FILTER_ROWS: readonly StudyFilterRow[] = [
  { kind: 'heading', label: 'slowest metric' },
  ...['avg', 'p85', 'p95', 'p98', 'p99', 'max'].map((value) => ({
    kind: 'option' as const,
    group: 'metric' as const,
    value,
  })),
  { kind: 'heading', label: 'detector families' },
  ...['r', 'f', 'm', 'd'].map((value) => ({
    kind: 'option' as const,
    group: 'families' as const,
    value,
  })),
  { kind: 'heading', label: 'scalar channels' },
  ...['gray', 'oklab-l', 'oklab+a', 'oklab-a', 'oklab+b', 'oklab-b', 'r', 'g', 'b'].map(
    (value) => ({ kind: 'option' as const, group: 'scalars' as const, value }),
  ),
  { kind: 'heading', label: 'thresholds' },
  ...['o', 's', 'h'].map((value) => ({
    kind: 'option' as const,
    group: 'thresholds' as const,
    value,
  })),
  { kind: 'heading', label: 'polarity' },
  ...['n', 'i'].map((value) => ({ kind: 'option' as const, group: 'polarities' as const, value })),
  { kind: 'heading', label: 'cache state' },
  ...['fresh', 'cached', 'mixed'].map((value) => ({
    kind: 'option' as const,
    group: 'cache' as const,
    value,
  })),
];

const selectableFilterRows = (): readonly Extract<StudyFilterRow, { readonly kind: 'option' }>[] =>
  FILTER_ROWS.filter(
    (row): row is Extract<StudyFilterRow, { readonly kind: 'option' }> => row.kind === 'option',
  );

const renderedFilterOptionIndexes = (offset: number, maxRows: number): readonly number[] => {
  const indexes: number[] = [];
  let lineCount = 2;
  let previousGroup: StudyFilterGroup | null = null;
  for (const [index, row] of selectableFilterRows().entries()) {
    if (index < offset) continue;
    const headingRows = row.group === previousGroup ? 0 : 1;
    if (lineCount + headingRows + 1 > maxRows) break;
    lineCount += headingRows + 1;
    previousGroup = row.group;
    indexes.push(index);
  }
  return indexes;
};

const filterGroupLabel = (group: StudyFilterGroup): string => {
  switch (group) {
    case 'metric':
      return 'slowest metric';
    case 'families':
      return 'detector families';
    case 'scalars':
      return 'scalar channels';
    case 'thresholds':
      return 'thresholds';
    case 'polarities':
      return 'polarity';
    case 'cache':
      return 'cache state';
  }
};

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
    readonly position?: 'absolute' | 'relative' | 'static';
    readonly top?: number | 'auto' | `${number}%`;
    readonly left?: number | 'auto' | `${number}%`;
    readonly zIndex?: number;
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
    title: ` ${options.title.toUpperCase()} `,
    paddingLeft: 1,
    paddingRight: 1,
    ...(options.position === undefined ? {} : { position: options.position }),
    ...(options.top === undefined ? {} : { top: options.top }),
    ...(options.left === undefined ? {} : { left: options.left }),
    ...(options.zIndex === undefined ? {} : { zIndex: options.zIndex }),
  } as const;
  const box = new BoxRenderable(renderer, {
    ...boxOptions,
    ...(options.height === undefined ? {} : { height: options.height }),
    ...(options.flexGrow === undefined ? {} : { flexGrow: options.flexGrow }),
  });
  const body = new TextRenderable(renderer, {
    id: `bench-dashboard-${options.id}-body`,
    content: '',
    fg: THEME.text,
    bg: 'transparent',
    selectable: true,
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    wrapMode: 'none',
    truncate: true,
  });
  box.add(body);
  return { box, body };
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
    readonly filters: StudyChartFilters;
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
      `jobs ${studyJobProgress(dashboard)} assets ${dashboard.completedJobs}/${dashboard.totalJobs} active=${dashboard.activeScans.size}`,
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
      filters: options.filters,
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
    readonly filters: StudyChartFilters;
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
      filters: options.filters,
    }),
  );
  return lines;
};

const renderStudyTimingBars = (
  title: string,
  inputRows: readonly {
    readonly id: string;
    readonly totalMs: number;
    readonly count: number;
    readonly outputCount: number;
    readonly cachedCount: number;
  }[],
  options: {
    readonly width: number;
    readonly maxRows: number;
    readonly offset: number;
    readonly maxLabelWidth: number;
    readonly filters: StudyChartFilters;
  },
): readonly string[] => {
  const allRows = inputRows.length;
  const rows = inputRows
    .filter((row) => matchesStudyFilters(row, options.filters))
    .sort((left, right) => averageStudyTimingMs(right) - averageStudyTimingMs(left));
  if (rows.length === 0) {
    const suffix =
      activeFilterCount(options.filters) > 0
        ? ` filters=${activeFilterCount(options.filters)}`
        : '';
    return [truncateLine(`${title} 0/0 of ${allRows}${suffix} — no matches`, options.width)];
  }
  const maxBars = Math.max(1, options.maxRows - 1);
  const maxOffset = Math.max(0, rows.length - maxBars);
  const offset = Math.min(Math.max(0, options.offset), maxOffset);
  const visibleRows = rows.slice(offset, offset + maxBars);
  const first = offset + 1;
  const last = Math.min(rows.length, offset + visibleRows.length);
  const valueWidth = 22;
  const minBarWidth = 5;
  const labelWidth = Math.max(
    10,
    Math.min(options.maxLabelWidth, options.width - valueWidth - minBarWidth - 4),
  );
  const barWidth = Math.max(minBarWidth, options.width - labelWidth - valueWidth - 4);
  const maxAverage = Math.max(1, ...rows.map(averageStudyTimingMs));
  return [
    truncateLine(
      `${title} ${first}-${last}/${rows.length}${rows.length === allRows ? '' : ` of ${allRows}`} pos=${offset + 1}/${rows.length}${activeFilterCount(options.filters) > 0 ? ` filters=${activeFilterCount(options.filters)}` : ''}`,
      options.width,
    ),
    ...visibleRows.map((row) => {
      const average = averageStudyTimingMs(row);
      const filled = Math.max(1, Math.round((average / maxAverage) * barWidth));
      const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, barWidth - filled))}`;
      return truncateLine(
        `${padStudyCell(row.id, labelWidth)} ${bar} ${formatStudyTiming(average, row.count, row.outputCount, row.cachedCount)}`,
        options.width,
      );
    }),
  ];
};

const matchesStudyFilters = (
  row: {
    readonly id: string;
    readonly count: number;
    readonly cachedCount: number;
  },
  filters: StudyChartFilters,
): boolean => {
  const parsed = parseStudyTimingId(row.id);
  return (
    matchesGroup(filters.families, parsed.family) &&
    matchesGroup(filters.scalars, parsed.scalar) &&
    matchesGroup(filters.thresholds, parsed.threshold) &&
    matchesGroup(filters.polarities, parsed.polarity) &&
    matchesCacheFilter(filters.cache, row)
  );
};

const matchesGroup = (selected: ReadonlySet<string>, value: string): boolean =>
  selected.size === 0 || selected.has(value);

const matchesCacheFilter = (
  selected: ReadonlySet<string>,
  row: { readonly count: number; readonly cachedCount: number },
): boolean => {
  if (selected.size === 0) return true;
  const fresh = row.count - row.cachedCount;
  const states = new Set<string>();
  if (fresh > 0) states.add('fresh');
  if (row.cachedCount > 0) states.add('cached');
  if (fresh > 0 && row.cachedCount > 0) states.add('mixed');
  return [...selected].some((entry) => states.has(entry));
};

const parseStudyTimingId = (
  id: string,
): {
  readonly family: string;
  readonly scalar: string;
  readonly threshold: string;
  readonly polarity: string;
} => {
  const parts = id.split(':');
  return {
    family: parts.length >= 5 ? (parts[1] ?? '') : (parts[0] ?? ''),
    scalar: parts.at(-3) ?? '',
    threshold: parts.at(-2) ?? '',
    polarity: parts.at(-1) ?? '',
  };
};

const activeFilterCount = (filters: StudyChartFilters): number =>
  filters.families.size +
  filters.scalars.size +
  filters.thresholds.size +
  filters.polarities.size +
  filters.cache.size;

const renderStudyFilterModal = (options: {
  readonly width: number;
  readonly focus: 'views' | 'detectors';
  readonly filters: StudyChartFilters;
  readonly cursor: number;
  readonly slowestMetric: StudySlowestMetric;
  readonly offset: number;
  readonly maxRows: number;
}): readonly string[] => {
  const lines = [
    'study filters',
    truncateLine(
      `filtering ${options.focus}; ↑/↓ select, space toggle, a clear, esc/f close`,
      options.width,
    ),
  ];
  let previousGroup: StudyFilterGroup | null = null;
  const visibleIndexes = renderedFilterOptionIndexes(options.offset, options.maxRows);
  for (const index of visibleIndexes) {
    const row = selectableFilterRows()[index];
    if (!row) continue;
    if (row.group !== previousGroup) {
      lines.push(truncateLine(filterGroupLabel(row.group), options.width));
      previousGroup = row.group;
    }
    const selected =
      row.group === 'metric'
        ? options.slowestMetric === row.value
        : options.filters[row.group].has(row.value);
    const cursor = index === options.cursor ? '›' : ' ';
    lines.push(
      truncateLine(
        `${cursor} ${selected ? '[x]' : '[ ]'} ${row.group}:${row.value}`,
        options.width,
      ),
    );
  }
  const visibleRows = visibleIndexes.length;
  if (selectableFilterRows().length > visibleRows) {
    lines[0] = truncateLine(
      `study filters ${options.offset + 1}-${Math.min(selectableFilterRows().length, options.offset + visibleRows)}/${selectableFilterRows().length}`,
      options.width,
    );
  }
  while (lines.length > 0 && lines.length > options.maxRows) {
    lines.pop();
  }
  return lines;
};

const padStudyCell = (value: string, width: number): string => {
  const truncated = truncateLine(value, width);
  return `${truncated}${' '.repeat(Math.max(0, width - truncated.length))}`;
};

const averageStudyTimingMs = (row: { readonly totalMs: number; readonly count: number }): number =>
  row.totalMs / Math.max(1, row.count);

const formatStudyTiming = (
  averageMs: number,
  count: number,
  outputCount: number,
  cachedCount: number,
): string => `${formatCompactDuration(averageMs)} p=${outputCount} jobs=${count} c=${cachedCount}`;

const studyLegendLines = (): readonly string[] => [
  'study legend',
  'ids',
  'inline = inline-flood',
  'run-map = run-map matcher',
  'dense = dense-stats',
  'spatial = spatial-bin',
  'run-length = run-length-ccl',
  'run-pattern = run-pattern',
  'axis-x = axis-intersect',
  'shared-runs = shared-runs',
  '',
  'families',
  'f=flood m=matcher',
  'r=row d=dedupe',
  '',
  'views',
  'o=otsu s=sauvola h=hybrid',
  'n=normal i=inverted',
  '',
  'bars',
  'p=outputs jobs=rows c=cached',
];

const studyLegendLineCount = (): number => Math.max(0, studyLegendLines().length - 1);

const renderStudyLegend = (options: {
  readonly width: number;
  readonly maxRows: number;
  readonly offset: number;
}): readonly string[] => {
  const [title = 'study legend', ...rows] = studyLegendLines();
  return [
    title,
    ...rows
      .slice(options.offset, options.offset + options.maxRows)
      .map((line) => truncateLine(line, options.width)),
  ];
};

const renderStudyEvents = (
  dashboard: BenchDashboardModel,
  options: { readonly width: number; readonly maxRows: number; readonly offset?: number },
): readonly string[] => {
  const offset = Math.max(0, options.offset ?? 0);
  const rows = [...dashboard.studyEvents]
    .reverse()
    .slice(offset, offset + Math.max(1, options.maxRows));
  const lines = ['study events'];
  if (rows.length === 0) {
    lines.push('none yet');
    return lines;
  }
  for (const row of rows) lines.push(truncateLine(row, options.width));
  return lines;
};

const renderStudyFooterStatus = (dashboard: BenchDashboardModel): string => {
  const cache = cacheTotals(dashboard);
  return [
    'bench study',
    `stage=${dashboard.stage}`,
    `jobs=${studyJobProgress(dashboard)}`,
    `assets=${dashboard.completedJobs}/${dashboard.totalJobs}`,
    `workers=${dashboard.workerCount || '-'}`,
    `cache=${dashboard.cacheEnabled ? 'on' : 'off'}:${cache.hits}/${cache.misses}/${cache.writes}`,
  ].join(' | ');
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

const headerText = (dashboard: BenchDashboardModel, width: number): string => {
  const completed =
    dashboard.commandName === 'study' ? dashboard.studyCompletedUnits : dashboard.completedJobs;
  const total = dashboard.commandName === 'study' ? dashboard.studyTotalUnits : dashboard.totalJobs;
  const percent = clamp01(total > 0 ? completed / total : 0);
  const labelWidth = `IRONQR BENCH  ${stageBadge(dashboard.stage)}  `.length;
  const suffix = dashboard.commandName === 'study' ? '' : `  ${dashboard.message}`;
  const countText = `  ${completed}/${total} jobs${suffix}`;
  const dynamicBarWidth = Math.max(PROGRESS_BAR_WIDTH, width - labelWidth - countText.length - 1);
  const completeWidth = Math.round(percent * dynamicBarWidth);
  const progress = `${'█'.repeat(completeWidth)}${'░'.repeat(dynamicBarWidth - completeWidth)}`;
  return `IRONQR BENCH  ${stageBadge(dashboard.stage)}  ${progress}${countText}`;
};

const studyJobProgress = (dashboard: BenchDashboardModel): string =>
  `${dashboard.studyCompletedUnits}/${dashboard.studyTotalUnits || '-'}`;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const stageBadge = (stage: BenchDashboardModel['stage']): string => {
  if (stage === 'done') return 'DONE';
  if (stage === 'benchmark') return 'RUN';
  return stage.toUpperCase();
};
