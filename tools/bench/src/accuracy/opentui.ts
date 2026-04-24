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
  readonly title: OpenTuiText;
  readonly body: OpenTuiText;
};

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
  private stopped = false;

  constructor(
    private readonly dashboard: BenchDashboardModel,
    private readonly onQuit: () => never = () => process.exit(130),
  ) {}

  start(): void {
    if (this.startPromise) return;
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

  private async startAsync(): Promise<void> {
    try {
      const { BoxRenderable, TextRenderable, createCliRenderer } = await import('@opentui/core');
      const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 12 });
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

      const chart = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'chart',
        title: 'Timing by outcome',
        accent: THEME.cyan,
        height: 13,
      });
      const scorecard = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'scorecard',
        title: 'Accuracy scorecard',
        accent: THEME.green,
        height: 10,
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
        width: '42%',
        height: '100%',
        flexDirection: 'column',
      });
      const active = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'active',
        title: 'Active workers',
        accent: THEME.blue,
        flexGrow: 1,
      });
      const slowest = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'slowest',
        title: 'Slowest fresh scans',
        accent: THEME.amber,
        flexGrow: 1,
      });
      leftColumn.add(active.box);
      leftColumn.add(slowest.box);

      const recent = createPanel(BoxRenderable, TextRenderable, renderer, {
        id: 'recent',
        title: 'Recent scans',
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
      root.add(chart.box);
      root.add(scorecard.box);
      root.add(tablesRow);
      root.add(footerBox);
      renderer.root.add(root);
      renderer.start();

      this.panels = { header, chart, scorecard, active, slowest, recent, footer };
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

  private quit(): never {
    this.cleanup();
    return this.onQuit();
  }

  private cleanup(): void {
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

  private render(): void {
    const panels = this.panels;
    if (!panels || this.stopped) return;

    const width = process.stdout.columns ?? process.stderr.columns ?? 120;
    const height = process.stdout.rows ?? process.stderr.rows ?? 40;
    const contentWidth = Math.max(36, width - 8);
    const leftWidth = Math.max(34, Math.floor(contentWidth * 0.42) - 4);
    const recentWidth = Math.max(40, contentWidth - leftWidth - 8);
    const tableRows = Math.max(4, Math.floor((height - 26) / 2));
    const recentRows = Math.max(4, height - 24);

    panels.header.content = headerText(this.dashboard);
    panels.chart.body.content = withoutTitle(
      renderTimingChart(this.dashboard, {
        width: contentWidth,
        barHeight: height < 34 ? 3 : 4,
      }),
    );
    panels.scorecard.body.content = withoutTitle(
      renderScorecard(this.dashboard, { width: contentWidth }),
    );
    panels.active.body.content = withoutTitle(
      renderActiveWorkers(this.dashboard, {
        width: leftWidth,
        nowMs: Date.now(),
        maxRows: tableRows,
      }),
    );
    panels.slowest.body.content = withoutTitle(
      renderSlowestFreshScans(this.dashboard, { width: leftWidth, maxRows: tableRows }),
    );
    panels.recent.body.content = withoutTitle(
      renderRecentScans(this.dashboard, { width: recentWidth, maxRows: recentRows }),
    );
    panels.footer.content = renderRunFooter(this.dashboard);
  }
}

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
  },
): OpenTuiPanel => {
  const boxOptions = {
    id: `bench-dashboard-${options.id}-panel`,
    width: '100%',
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
  });
  const body = new TextRenderable(renderer, {
    id: `bench-dashboard-${options.id}-body`,
    content: '',
    fg: THEME.text,
    bg: 'transparent',
    selectable: false,
    flexGrow: 1,
    flexShrink: 1,
  });
  box.add(title);
  box.add(body);
  return { box, title, body };
};

const withoutTitle = (lines: readonly string[]): string => lines.slice(1).join('\n');

const headerText = (dashboard: BenchDashboardModel): string => {
  const percent = dashboard.totalJobs > 0 ? dashboard.completedJobs / dashboard.totalJobs : 0;
  const completeWidth = Math.round(percent * 24);
  const progress = `${'█'.repeat(completeWidth)}${'░'.repeat(24 - completeWidth)}`;
  return `IRONQR BENCH  ${stageBadge(dashboard.stage)}  ${progress}  ${dashboard.completedJobs}/${dashboard.totalJobs} jobs  ${dashboard.message}`;
};

const stageBadge = (stage: BenchDashboardModel['stage']): string => {
  if (stage === 'done') return 'DONE';
  if (stage === 'benchmark') return 'RUN';
  return stage.toUpperCase();
};
