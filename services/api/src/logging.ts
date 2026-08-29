import type { ApiConfig } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a child logger that stamps every line with extra fields. */
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel | 'silent', number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

/** Structured single-line JSON logging — the only thing that writes to stdout. */
export function createLogger(config: Pick<ApiConfig, 'logLevel'>, base: LogFields = {}): Logger {
  const threshold = LEVEL_ORDER[config.logLevel];

  function emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...base,
      ...fields,
    });
    if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger(config, { ...base, ...fields }),
  };
}

export const silentLogger: Logger = createLogger({ logLevel: 'silent' });
