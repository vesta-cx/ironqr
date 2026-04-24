import { ironqrAccuracyEngine } from './adapters/ironqr.js';
import { jsqrAccuracyEngine } from './adapters/jsqr.js';
import { quircAccuracyEngine } from './adapters/quirc.js';
import { zbarAccuracyEngine } from './adapters/zbar.js';
import { zxingAccuracyEngine } from './adapters/zxing.js';
import { zxingCppAccuracyEngine } from './adapters/zxing-cpp.js';
import type { AccuracyEngine, AccuracyEngineDescriptor } from './types.js';

const ACCURACY_ENGINES = [
  ironqrAccuracyEngine,
  jsqrAccuracyEngine,
  zxingAccuracyEngine,
  zxingCppAccuracyEngine,
  quircAccuracyEngine,
  zbarAccuracyEngine,
] as const satisfies readonly AccuracyEngine[];

export const listAccuracyEngines = (): readonly AccuracyEngine[] => ACCURACY_ENGINES;

export const describeAccuracyEngine = (engine: AccuracyEngine): AccuracyEngineDescriptor => {
  const availability = engine.availability();
  return {
    id: engine.id,
    kind: engine.kind,
    capabilities: engine.capabilities,
    ...availability,
  };
};

export const getAccuracyEngineById = (engineId: string): AccuracyEngine => {
  const engine = ACCURACY_ENGINES.find((candidate) => candidate.id === engineId);
  if (!engine) {
    throw new Error(`Unknown accuracy engine: ${engineId}`);
  }
  return engine;
};
