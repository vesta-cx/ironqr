import type { StudyPlugin } from './types.js';

export interface StudyPluginRegistration {
  readonly plugin: StudyPlugin;
}

export const createStudyPluginRegistry = (
  registrations: readonly StudyPluginRegistration[] = [],
): StudyPluginRegistry => new StudyPluginRegistry(registrations);

export class StudyPluginRegistry {
  readonly #plugins = new Map<string, StudyPlugin>();

  constructor(registrations: readonly StudyPluginRegistration[] = []) {
    for (const registration of registrations) this.register(registration.plugin);
  }

  register(plugin: StudyPlugin): void {
    if (!plugin.id.trim()) throw new Error('Study plugin id must not be empty');
    if (!plugin.version.trim())
      throw new Error(`Study plugin ${plugin.id} version must not be empty`);
    const existing = this.#plugins.get(plugin.id);
    if (existing) throw new Error(`Duplicate study plugin id: ${plugin.id}`);
    this.#plugins.set(plugin.id, plugin);
  }

  list(): readonly StudyPlugin[] {
    return Array.from(this.#plugins.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): StudyPlugin {
    const plugin = this.#plugins.get(id);
    if (!plugin) throw new Error(`Unknown study plugin: ${id}`);
    return plugin;
  }
}
