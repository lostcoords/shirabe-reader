import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { developmentBuildId, startDevelopmentReloadServer } from "../dev-reload-server.mjs";

const pattern = /^\d{8}T(\d{2})(\d{2})(\d{2})(\d{3})-[0-9a-f]{2}$/;

test("the reload server publishes the same stamp the extension accepts", async () => {
  const source = await readFile(new URL("../src/common/development-build.ts", import.meta.url), "utf8");
  assert.match(source, /DEVELOPMENT_BUILD_PATTERN = \/\^\\d\{8\}T/);
  const server = startDevelopmentReloadServer({ port: 0 });
  try {
    const address = await server.ready;
    assert.equal(address.address, "127.0.0.1");
    const first = await fetch(`http://127.0.0.1:${address.port}/build.json`).then((response) => response.json());
    assert.equal(first.id, "");
    const id = server.publish(developmentBuildId(new Date("2026-10-17T16:54:02.184Z"), "ab"));
    assert.match(id, pattern);
    const published = await fetch(`http://127.0.0.1:${address.port}/build.json?t=1`).then((response) => response.json());
    assert.equal(published.id, id);
    const missing = await fetch(`http://127.0.0.1:${address.port}/reload`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
  }
});
