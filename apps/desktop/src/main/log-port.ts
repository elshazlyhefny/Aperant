/**
 * Electron-free logging seam.
 *
 * zeenha fork: this module exists so the CLI bundle can contain the task queue
 * manager. `app-logger.ts` imports `electron` and `electron-log`, which the CLI
 * cannot load. Code that must run in both places logs through `appLogPort`.
 * The desktop calls `setLogger(appLog)` from `app-logger.ts`; the CLI keeps the
 * default stderr logger.
 */

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

function writeStderr(level: string, args: unknown[]): void {
  try {
    process.stderr.write(`[${level}] ${args.map(formatArg).join(' ')}\n`);
  } catch {
    // Never throw from a logger.
  }
}

const noop = (): void => {};

/** Default logger: warn/error go to stderr, debug/info are silent. */
const defaultLogger: Logger = {
  debug: noop,
  info: noop,
  warn: (...args) => writeStderr('warn', args),
  error: (...args) => writeStderr('error', args),
  log: noop,
};

let currentLogger: Logger = defaultLogger;

/** Replace the logger that `appLogPort` forwards to. */
export function setLogger(logger: Logger): void {
  currentLogger = logger;
}

/** Proxy that always forwards to the current logger. */
export const appLogPort: Logger = {
  debug: (...args) => currentLogger.debug(...args),
  info: (...args) => currentLogger.info(...args),
  warn: (...args) => currentLogger.warn(...args),
  error: (...args) => currentLogger.error(...args),
  log: (...args) => currentLogger.log(...args),
};
