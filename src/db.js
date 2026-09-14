// MySQL pool. Always pass values through `params` (`?` placeholders), never into the SQL string.
import mysql from "mysql2/promise";

/** @param {{host: string, port: number, user: string, password: string, database: string, connectionLimit: number}} options */
export function createDb(options) {
  const pool = mysql.createPool({
    ...options,
    timezone: "Z",
    dateStrings: ["DATE"],
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
  });
  return {
    /** @param {string} sql @param {unknown[]} [params] */
    async query(sql, params = []) {
      const [rows] = await pool.query(sql, params);
      return /** @type {any} */ (rows);
    },
    close: () => pool.end(),
  };
}
