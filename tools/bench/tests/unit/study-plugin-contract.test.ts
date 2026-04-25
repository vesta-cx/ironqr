import { describe, expect, it } from 'bun:test';
import {
  createStudyPluginRegistry,
  type StudyPlugin,
  type StudyPluginContext,
} from '../../src/study/index.js';

const noopStudy: StudyPlugin<{ ok: true }> = {
  id: 'view-order',
  title: 'IronQR view-order study',
  description: 'Ranks binary proposal views from corpus evidence.',
  version: '1',
  flags: [
    {
      name: 'max-assets',
      type: 'number',
      description: 'Limit approved corpus assets processed by the study.',
      default: 0,
    },
  ],
  async run(context: StudyPluginContext) {
    context.log(`assets=${context.assets.length}`);
    return {
      pluginId: this.id,
      assetCount: context.assets.length,
      summary: { ok: true },
      report: { output: context.output.reportFile },
    };
  },
};

describe('study plugin contract', () => {
  it('registers and resolves plugins by stable id', () => {
    const registry = createStudyPluginRegistry([{ plugin: noopStudy }]);

    expect(registry.list().map((plugin) => plugin.id)).toEqual(['view-order']);
    expect(registry.get('view-order')).toBe(noopStudy);
  });

  it('rejects duplicate plugin ids', () => {
    expect(() =>
      createStudyPluginRegistry([{ plugin: noopStudy }, { plugin: { ...noopStudy } }]),
    ).toThrow('Duplicate study plugin id: view-order');
  });

  it('passes typed context into plugin execution', async () => {
    const run = noopStudy.run;
    if (!run) throw new Error('noop study missing run hook');
    const result = await run.call(noopStudy, {
      repoRoot: '/repo',
      assets: [],
      output: { reportFile: '/repo/tools/bench/reports/study.json' },
      flags: { 'max-assets': 0 },
      reports: { accuracy: async () => null, performance: async () => null },
      cache: {
        has: () => false,
        read: async () => null,
        write: async () => {},
        remove: async () => false,
        purge: async () => 0,
        flush: async () => {},
        summary: () => ({
          enabled: true,
          file: '/repo/tools/bench/.cache/studies/view-order.json',
          hits: 0,
          misses: 0,
          writes: 0,
          invalidRows: 0,
          purgedRows: 0,
        }),
      },
      log: () => {},
    });

    expect(result).toEqual({
      pluginId: 'view-order',
      assetCount: 0,
      summary: { ok: true },
      report: { output: '/repo/tools/bench/reports/study.json' },
    });
  });
});
