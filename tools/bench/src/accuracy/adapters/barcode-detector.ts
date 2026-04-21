import { createBridgeAccuracyEngine } from '../bridge.js';
import type { AccuracyEngine } from '../types.js';
import { createCapabilities } from './shared.js';

const BARCODE_DETECTOR_COMMAND_ENV = 'IRONQR_BENCH_BARCODE_DETECTOR_COMMAND';

export const barcodeDetectorAccuracyEngine: AccuracyEngine = createBridgeAccuracyEngine({
  id: 'barcode-detector',
  capabilities: createCapabilities({
    multiCode: true,
    inversion: 'native',
    rotation: 'native',
    runtime: 'browser',
  }),
  commandEnvVar: BARCODE_DETECTOR_COMMAND_ENV,
  unavailableReason: `set ${BARCODE_DETECTOR_COMMAND_ENV} to a browser bridge command that reads the accuracy bridge JSON protocol from stdin`,
  request: {
    formats: ['qr_code'],
    allowMultiple: true,
  },
});
