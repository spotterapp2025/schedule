// Optional GET /health endpoint (set HEALTH_PORT) for Docker/Kubernetes/uptime monitors.
import http from "node:http";

/** @param {{port: number, status: () => {healthy: boolean}, logger: any}} options */
export function startHealthServer({ port, status, logger }) {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const body = status();
    res.writeHead(body.healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(port, () => logger.info(`Health check on http://localhost:${port}/health`));
  return { close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
