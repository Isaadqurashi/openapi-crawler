import { v4 as uuidv4 } from "uuid";
import { config, LogLevel } from "./config";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface LogContext {
  event?: string;
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

/** UTC ISO 8601 timestamp ending in `Z`. */
export function utcTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function createLogger(initialExtra: LogContext = {}): Logger {
  const runId =
    (initialExtra.runId as string | undefined) ?? uuidv4().slice(0, 8);
  const threshold = LEVEL_PRIORITY[config.logLevel];

  function emit(level: LogLevel, message: string, extra?: LogContext): void {
    if (LEVEL_PRIORITY[level] < threshold) return;

    const event =
      extra?.event ?? (initialExtra.event as string | undefined) ?? message;

    const line = {
      timestamp: utcTimestamp(),
      level: level.toUpperCase(),
      run_id: runId,
      event,
      message,
      ...initialExtra,
      ...(extra || {})
    };

    const serialized = JSON.stringify(line);
    if (level === "error") {
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

export const logger = createLogger();

export default logger;
