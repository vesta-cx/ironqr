import { ironqrAccuracyEngine } from '../accuracy/adapters/ironqr.js';
import { jsqrAccuracyEngine } from '../accuracy/adapters/jsqr.js';
import { opencvAccuracyEngine, opencvMultiAccuracyEngine } from '../accuracy/adapters/opencv.js';
import { quircAccuracyEngine } from '../accuracy/adapters/quirc.js';
import { zbarAccuracyEngine } from '../accuracy/adapters/zbar.js';
import { zxingAccuracyEngine } from '../accuracy/adapters/zxing.js';
import { zxingCppAccuracyEngine } from '../accuracy/adapters/zxing-cpp.js';
import type { AccuracyEngine, AccuracyEngineDescriptor } from '../accuracy/types.js';

const ACCURACY_ENGINES = [
  ironqrAccuracyEngine,
  jsqrAccuracyEngine,
  zxingAccuracyEngine,
  zxingCppAccuracyEngine,
  quircAccuracyEngine,
  zbarAccuracyEngine,
  opencvAccuracyEngine,
  opencvMultiAccuracyEngine,
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

export const inspectAccuracyEngines = (): readonly AccuracyEngineDescriptor[] => {
  return listAccuracyEngines().map(describeAccuracyEngine);
};

export const resolveAccuracyEngines = (): readonly AccuracyEngine[] => {
  const engines = listAccuracyEngines();
  const unavailable = engines.filter((engine) => !engine.availability().available);
  if (unavailable.length > 0) {
    throw new Error(
      `Unavailable benchmark engine(s): ${unavailable
        .map((engine) => `${engine.id}: ${engine.availability().reason ?? 'unavailable'}`)
        .join('; ')}`,
    );
  }
  return engines;
};
