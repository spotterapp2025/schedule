// Test doubles: no database, network or real push notifications are used by the test suite.
export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

export const token = (n) => `ExponentPushToken[test-${n}]`;

/** Fake database that routes queries by their leading /* tag *\/ comment (untagged queries use `default`). */
export function createFakeDb(routes = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      const tag = /\/\*\s*([\w:]+)\s*\*\//.exec(sql)?.[1];
      const handler = (tag && routes[tag]) ?? routes.default;
      return handler ? handler(params, sql) : [];
    },
    async close() {},
  };
}

export function staticCapabilities(caps) {
  return { current: () => caps, refresh: async () => caps, refreshIfStale: async () => caps };
}

/** Number of `?` placeholders (an array bound to `IN (?)` is still one parameter). */
export const placeholderCount = (sql) => (sql.match(/\?/g) ?? []).length;
