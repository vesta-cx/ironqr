import { spawn } from 'node:child_process';
import {
  createAvailableAvailability,
  failureResult,
  normalizeDecodedText,
  serializeAsync,
} from './adapters/shared.js';
import type {
  AccuracyEngine,
  AccuracyEngineAvailability,
  AccuracyEngineCapabilities,
  AccuracyScanCode,
  AccuracyScanResult,
} from './types.js';

export interface AccuracyBridgeRequest {
  readonly version: 1;
  readonly type: 'scan-image';
  readonly imagePath: string;
  readonly formats: readonly string[];
  readonly allowMultiple: boolean;
}

export interface AccuracyBridgeResponse {
  readonly version: 1;
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly results: readonly AccuracyScanCode[];
  readonly error?: string;
}

interface BridgeEngineOptions {
  readonly id: string;
  readonly kind?: AccuracyEngine['kind'];
  readonly capabilities: AccuracyEngineCapabilities;
  readonly commandEnvVar: string;
  readonly unavailableReason: string;
  readonly request: Omit<AccuracyBridgeRequest, 'version' | 'type' | 'imagePath'>;
}

const configuredCommand = (envVar: string): string | null => {
  const value = process.env[envVar]?.trim();
  return value ? value : null;
};

const availabilityForCommand = (
  envVar: string,
  unavailableReason: string,
): AccuracyEngineAvailability => {
  return configuredCommand(envVar)
    ? createAvailableAvailability()
    : {
        available: false,
        reason: unavailableReason,
      };
};

const normalizeBridgeResponse = (response: AccuracyBridgeResponse): AccuracyScanResult => {
  return {
    attempted: response.attempted,
    succeeded: response.succeeded,
    results: response.results.map((result) => ({
      text: normalizeDecodedText(result.text),
      ...(result.kind ? { kind: result.kind } : {}),
    })),
    ...(response.error ? { error: response.error } : {}),
  };
};

const runBridgeCommand = async (
  command: string,
  request: AccuracyBridgeRequest,
): Promise<AccuracyScanResult> => {
  return await new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];

    child.stdout.on('data', (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Uint8Array) => stderr.push(chunk));
    child.on('error', (error) => resolve(failureResult(error)));
    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        resolve(
          failureResult(stderrText || `bridge command exited with code ${code ?? 'unknown'}`),
        );
        return;
      }

      try {
        const response = JSON.parse(stdoutText) as AccuracyBridgeResponse;
        if (response.version !== 1) {
          resolve(
            failureResult(`unsupported bridge response version: ${String(response.version)}`),
          );
          return;
        }
        resolve(normalizeBridgeResponse(response));
      } catch (error) {
        resolve(
          failureResult(
            stderrText ||
              `failed to parse bridge response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();
  });
};

export const createBridgeAccuracyEngine = (options: BridgeEngineOptions): AccuracyEngine => {
  const availability = (): AccuracyEngineAvailability => {
    return availabilityForCommand(options.commandEnvVar, options.unavailableReason);
  };

  const scanImage = serializeAsync(async (imagePath: string): Promise<AccuracyScanResult> => {
    const command = configuredCommand(options.commandEnvVar);
    if (!command) {
      return failureResult(options.unavailableReason);
    }

    return await runBridgeCommand(command, {
      version: 1,
      type: 'scan-image',
      imagePath,
      ...options.request,
    });
  });

  return {
    id: options.id,
    kind: options.kind ?? 'third-party',
    capabilities: options.capabilities,
    availability,
    scanImage,
  };
};
