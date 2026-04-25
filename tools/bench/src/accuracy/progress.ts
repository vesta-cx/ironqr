import { type BenchProgressReporter, createBenchProgressReporter } from '../ui/progress.js';

export type AccuracyProgressReporter = BenchProgressReporter;

export const createAccuracyProgressReporter = (options: {
  readonly enabled: boolean;
  readonly stderr?: NodeJS.WriteStream;
  readonly requestStop?: () => void;
}): AccuracyProgressReporter =>
  createBenchProgressReporter({
    commandName: 'accuracy',
    enabled: options.enabled,
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    ...(options.requestStop === undefined ? {} : { requestStop: options.requestStop }),
  });
