import assert from "node:assert/strict";
import test from "node:test";
import { developmentBuildLabel, shouldReloadDevelopmentBuild } from "../src/common/development-build.js";

const loaded = "20261017T165402184-ab";
const next = "20261017T165403002-cd";

test("a dev build stamp shows the clock, not only the release version", () => {
  assert.equal(developmentBuildLabel("0.3.0", loaded), "0.3.0 · 16:54:02.184");
  assert.equal(developmentBuildLabel("0.3.0", "0.3.0"), null);
  assert.equal(developmentBuildLabel("0.3.0", "http://127.0.0.1/build.json"), null);
});

test("the watcher reloads only when the announced stamp is a new valid build", () => {
  assert.equal(shouldReloadDevelopmentBuild(loaded, next), true);
  assert.equal(shouldReloadDevelopmentBuild(loaded, loaded), false);
  assert.equal(shouldReloadDevelopmentBuild("", next), false);
  assert.equal(shouldReloadDevelopmentBuild(loaded, "reload"), false);
  assert.equal(shouldReloadDevelopmentBuild(loaded, { id: next }), false);
});
