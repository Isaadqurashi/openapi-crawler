import { v4 as uuidv4 } from "uuid";
import { config, LogLevel } from "./config";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface LogContext {
  [key: string]: unknown;
}

export interface Logger {
  runId: string;
  debug: (message: string, extra?: LogContext) => void;
  info: (message: string, extra?: LogContext) => void;
  warn: (message: string, extra?: LogContext) => void;
  error: (message: string, extra?: LogContext) => void;
  child: (extra: LogContext) => Logger;
}

/**
 * Build a logger that emits one JSON object per line. Every line carries the
 * same `runId` so an entire crawl run can be filtered out of a log stream.
 *
 * We bind level checks to the priority table so a noisy `debug` call costs
 * effectively nothing when LOG_LEVEL=info.
 */
export function createLogger(initialExtra: LogContext = {}): Logger {
  const runId =
    (initialExtra.runId as string | undefined) ?? uuidv4();
  const threshold = LEVEL_PRIORITY[config.logLevel];

  function emit(level: LogLevel, message: string, extra?: LogContext): void {
    if (LEVEL_PRIORITY[level] < threshold) return;

    const line = {
      runId,
      level,
      message,
      timestamp: new Date().toISOString(),
      ...initialExtra,
      ...(extra || {})
    };

    const serialized = JSON.stringify(line);
    if (level === "error") {
      // Send errors to stderr so they survive shell redirection of stdout.
      process.stderr.write(serialized + "\n");
    } else {
      process.stdout.write(serialized + "\n");
    }
  }

  const logger: Logger = {
    runId,
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
    child: (extra) => createLogger({ ...initialExtra, ...extra, runId })
  };

  return logger;
}

// Default singleton logger used by modules that don't need a child context.
export const logger = createLogger();

export default logger;
