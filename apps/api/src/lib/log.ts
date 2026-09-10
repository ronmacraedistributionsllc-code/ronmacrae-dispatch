import pino from "pino";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export function createLogger(level: LogLevel, name: string): pino.Logger {
  return pino({ level, name, base: { app: name } });
}

export type Logger = pino.Logger;
