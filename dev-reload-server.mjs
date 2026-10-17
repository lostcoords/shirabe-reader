import { createServer } from "node:http";

export const DEVELOPMENT_RELOAD_PORT = 4188;

export function developmentBuildId(date = new Date(), suffix = randomSuffix()) {
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
  return `${stamp}-${suffix}`;
}

function randomSuffix() {
  return Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
}

export function startDevelopmentReloadServer({ port = DEVELOPMENT_RELOAD_PORT } = {}) {
  let id = "";
  const server = createServer((request, response) => {
    const path = request.url?.split("?")[0];
    if (request.method !== "GET" || path !== "/build.json") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ id }));
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address());
    });
  });
  return {
    ready,
    publish(next = developmentBuildId()) {
      id = next;
      return id;
    },
    current() {
      return id;
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
