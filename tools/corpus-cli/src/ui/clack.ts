import readline from 'node:readline';
import type { Option } from '@clack/prompts';
import * as p from '@clack/prompts';
import {
  CliCancelledError,
  type CliUi,
  type ConfirmPromptOptions,
  type SelectPromptOptions,
  type SelectValue,
  type TextPromptOptions,
} from '../ui.js';

const unwrap = <T>(value: T | symbol): T => {
  if (p.isCancel(value)) {
    throw new CliCancelledError();
  }

  return value as T;
};

/** Count how many physical terminal rows a set of logical lines occupies. */
const physicalRowCount = (lines: readonly string[], columns: number): number => {
  let rows = 0;
  for (const line of lines) {
    // Each logical line takes at least 1 row; long lines wrap to ceil(width / columns).
    const width = stripAnsi(line).length;
    rows += width === 0 ? 1 : Math.ceil(width / columns);
  }
  return rows;
};

// Strip ANSI escape sequences for accurate visible-width measurement.
const stripAnsi = (text: string): string => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes requires matching control chars
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
};

const clearRenderedRows = (rowCount: number): void => {
  if (rowCount <= 0) {
    return;
  }

  for (let index = 0; index < rowCount; index += 1) {
    process.stdout.write('\r\x1b[2K');
    if (index < rowCount - 1) {
      process.stdout.write('\x1b[1A');
    }
  }
  process.stdout.write('\r');
};

const writeRenderedLines = (lines: readonly string[], trailingNewline = false): void => {
  if (lines.length === 0) {
    return;
  }

  process.stdout.write(lines.join('\n'));
  if (trailingNewline) {
    process.stdout.write('\n');
  }
};

const sanitizeRenderedLine = (line: string): string => {
  return Array.from(line, (character) => {
    if (character === '\t') {
      return '\\t';
    }

    const code = character.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || code === 0x7f) {
      return `\\x${code.toString(16).padStart(2, '0')}`;
    }

    return character;
  }).join('');
};

const promptMultilineText = async (options: TextPromptOptions): Promise<string> => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive terminal required for multiline text input');
  }

  readline.emitKeypressEvents(process.stdin);
  const wasPaused = process.stdin.isPaused();
  process.stdin.resume();
  process.stdin.setRawMode(true);

  let value = options.initialValue ?? '';
  let renderedRowCount = 0;
  let submitArmed = false;
  let status = 'Esc then Enter submit · Enter newline';
  const undoStack: string[] = [];
  const redoStack: string[] = [];

  const pushUndo = (): void => {
    undoStack.push(value);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  };

  const render = (): void => {
    clearRenderedRows(renderedRowCount);

    const lines = value.length > 0 ? value.split('\n') : [''];
    const rendered = [
      '│',
      `◇  ${sanitizeRenderedLine(options.message)}`,
      `│  ${sanitizeRenderedLine(status)}`,
      ...lines.map((line) => `│  ${sanitizeRenderedLine(line)}`),
    ];

    writeRenderedLines(rendered);
    renderedRowCount = physicalRowCount(rendered, process.stdout.columns || 80);
  };

  const renderSubmittedValue = (): void => {
    const lines = value.length > 0 ? value.split('\n') : [''];
    const rendered = [
      '│',
      `◇  ${sanitizeRenderedLine(options.message)}`,
      ...lines.map((line) => `│  ${sanitizeRenderedLine(line)}`),
    ];

    writeRenderedLines(rendered, true);
  };

  return new Promise<string>((resolve, reject) => {
    const cleanup = (): void => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(false);
      if (wasPaused) {
        process.stdin.pause();
      }
      clearRenderedRows(renderedRowCount);
    };

    const finish = (): void => {
      const validationError = options.validate?.(value);
      if (validationError) {
        status = validationError;
        render();
        return;
      }

      cleanup();
      renderSubmittedValue();
      resolve(value);
    };

    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };

    const onKeypress = (input: string, key: readline.Key): void => {
      if (key.ctrl && key.name === 'c') {
        fail(new CliCancelledError());
        return;
      }

      if (key.name === 'escape') {
        submitArmed = true;
        status = 'Press Enter to submit';
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        if (submitArmed) {
          finish();
          return;
        }

        pushUndo();
        value += '\n';
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      // Undo: ctrl+z
      if (key.ctrl && !key.shift && key.name === 'z') {
        if (undoStack.length > 0) {
          redoStack.push(value);
          value = undoStack.pop()!;
        }
        submitArmed = false;
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      // Redo: ctrl+y or ctrl+shift+z (shift+z reports as key.name='z' with key.shift)
      if ((key.ctrl && key.name === 'y') || (key.ctrl && key.shift && key.name === 'z')) {
        if (redoStack.length > 0) {
          undoStack.push(value);
          value = redoStack.pop()!;
        }
        submitArmed = false;
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      // Delete word backward: option+backspace (meta+backspace) or ctrl+w
      if ((key.meta && key.name === 'backspace') || (key.ctrl && key.name === 'w')) {
        pushUndo();
        submitArmed = false;
        // Remove trailing whitespace, then non-whitespace back to a boundary
        value = value.replace(/\S*\s*$/, '');
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      // Delete to start of line: ctrl+u
      if (key.ctrl && key.name === 'u') {
        pushUndo();
        submitArmed = false;
        const lastNewline = value.lastIndexOf('\n');
        value = lastNewline >= 0 ? value.slice(0, lastNewline) : '';
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      if (key.name === 'backspace') {
        pushUndo();
        submitArmed = false;
        value = value.slice(0, -1);
        status = 'Esc then Enter submit · Enter newline';
        render();
        return;
      }

      if (input && !key.ctrl && !key.meta) {
        pushUndo();
        submitArmed = false;
        value += input.replace(/\r\n?/g, '\n');
        status = 'Esc then Enter submit · Enter newline';
        render();
      }
    };

    process.stdin.on('keypress', onKeypress);
    render();
  });
};

type BufferedLevel = 'info' | 'warn' | 'debug';

interface BufferedLine {
  readonly level: BufferedLevel;
  readonly message: string;
}

/** Create a `CliUi` backed by clack prompts, buffering log output during active prompts. */
export const createClackUi = ({ verbose = false }: { verbose?: boolean } = {}): CliUi => {
  let activePromptCount = 0;
  const bufferedLines: BufferedLine[] = [];

  const flushBuffer = (): void => {
    while (bufferedLines.length > 0) {
      const entry = bufferedLines.shift();
      if (!entry) break;
      if (entry.level === 'warn') {
        console.warn(entry.message);
      } else {
        console.log(entry.message);
      }
    }
  };

  const writeOrBuffer = (level: BufferedLevel, message: string): void => {
    if (activePromptCount > 0) {
      if (level === 'debug') {
        return;
      }
      bufferedLines.push({ level, message });
      return;
    }

    if (level === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }
  };

  const withPrompt = async <T>(run: () => Promise<T>): Promise<T> => {
    activePromptCount += 1;
    try {
      return await run();
    } finally {
      activePromptCount -= 1;
      if (activePromptCount === 0) {
        flushBuffer();
      }
    }
  };

  return {
    verbose,
    intro(message) {
      p.intro(message);
    },
    outro(message) {
      p.outro(message);
    },
    cancel(message) {
      p.cancel(message);
    },
    info(message) {
      writeOrBuffer('info', message);
    },
    warn(message) {
      writeOrBuffer('warn', message);
    },
    debug(message) {
      if (verbose) {
        writeOrBuffer('debug', `\u2139 ${message}`);
      }
    },
    async text(options: TextPromptOptions): Promise<string> {
      return withPrompt(async () => {
        if (options.multiline) {
          return promptMultilineText(options);
        }

        const value = unwrap(
          await p.text({
            message: options.message,
            ...(options.placeholder ? { placeholder: options.placeholder } : {}),
            ...(options.initialValue ? { initialValue: options.initialValue } : {}),
            ...(options.validate ? { validate: options.validate } : {}),
          }),
        );
        return typeof value === 'string' ? value : '';
      });
    },
    async confirm(options: ConfirmPromptOptions): Promise<boolean> {
      return withPrompt(async () =>
        unwrap(
          await p.confirm({
            message: options.message,
            ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
          }),
        ),
      );
    },
    async select<T extends SelectValue>(options: SelectPromptOptions<T>): Promise<T> {
      return withPrompt(async () => {
        const promptOptions: Option<T>[] = [];
        for (const option of options.options) {
          if (option.hint) {
            promptOptions.push({
              value: option.value,
              label: option.label,
              hint: option.hint,
            } as Option<T>);
          } else {
            promptOptions.push({ value: option.value, label: option.label } as Option<T>);
          }
        }

        return unwrap(
          await p.select({
            message: options.message,
            ...(options.initialValue !== undefined ? { initialValue: options.initialValue } : {}),
            options: promptOptions,
          }),
        );
      });
    },
    async spin<T>(message: string, task: () => Promise<T>): Promise<T> {
      return withPrompt(async () => {
        const spinner = p.spinner();
        spinner.start(message);

        try {
          const result = await task();
          spinner.stop(message);
          return result;
        } catch (error) {
          spinner.stop(`${message} failed`);
          throw error;
        }
      });
    },
  };
};
