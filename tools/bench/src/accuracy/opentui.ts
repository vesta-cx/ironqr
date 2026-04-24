import { renderDashboardFrame } from './dashboard/frame.js';
import type { BenchDashboardModel } from './dashboard/model.js';

type OpenTuiCore = typeof import('@opentui/core');
type OpenTuiRenderer = Awaited<ReturnType<OpenTuiCore['createCliRenderer']>>;
type OpenTuiText = InstanceType<OpenTuiCore['TextRenderable']>;

export class BenchOpenTuiDashboard {
  private renderer: OpenTuiRenderer | null = null;
  private text: OpenTuiText | null = null;
  private startPromise: Promise<void> | null = null;
  private renderQueued = false;
  private stopped = false;

  constructor(private readonly dashboard: BenchDashboardModel) {}

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
    this.stopped = true;
    this.render();
    this.text = null;
    const renderer = this.renderer;
    this.renderer = null;
    renderer?.destroy();
  }

  private async startAsync(): Promise<void> {
    try {
      const { createCliRenderer, TextRenderable } = await import('@opentui/core');
      const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 12 });
      if (this.stopped) {
        renderer.destroy();
        return;
      }

      const text = new TextRenderable(renderer, {
        id: 'bench-dashboard-text',
        content: '',
        width: '100%',
        height: '100%',
        selectable: false,
      });
      renderer.root.add(text);
      renderer.start();

      this.renderer = renderer;
      this.text = text;
      this.render();
    } catch (error) {
      this.stopped = true;
      process.stderr.write(
        `[bench] OpenTUI progress failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  private render(): void {
    const text = this.text;
    if (!text || this.stopped) return;
    text.content = renderDashboardFrame(this.dashboard, {
      width: process.stdout.columns ?? process.stderr.columns ?? 120,
      height: process.stdout.rows ?? process.stderr.rows ?? 40,
    });
  }
}
