export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
}

export function createLogger(): Logger {
  const write = (level: string, message: string, extra?: unknown): void => {
    const line = `${new Date().toISOString()} ${level} ${message}`;
    const out = level === "error" || level === "warn" ? console.error : console.log;
    if (extra === undefined) out(line);
    else out(line, extra);
  };
  return {
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
}
