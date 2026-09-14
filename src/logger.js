// Small leveled logger with ISO timestamps. Never pass push tokens or personal data in `meta`.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function formatMeta(meta) {
  try {
    return JSON.stringify(meta, (_key, value) =>
      value instanceof Error ? { error: value.message, code: /** @type {NodeJS.ErrnoException} */ (value).code } : value
    );
  } catch {
    return String(meta);
  }
}

export function createLogger({ level = "info", sink = console } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (name, method) => (message, meta) => {
    if (LEVELS[name] < threshold) return;
    const suffix = meta === undefined ? "" : ` ${formatMeta(meta)}`;
    sink[method](`${new Date().toISOString()} ${name.toUpperCase().padEnd(5)} ${message}${suffix}`);
  };
  return {
    debug: write("debug", "log"),
    info: write("info", "log"),
    warn: write("warn", "warn"),
    error: write("error", "error"),
  };
}
