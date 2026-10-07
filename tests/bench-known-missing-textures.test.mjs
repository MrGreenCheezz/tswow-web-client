// 06.10-P1-00b: the bench accepts model-texture errors only when they are textures the corpus lacks (404).
import assert from "node:assert/strict";
import test from "node:test";

import {
  installKnownMissingTextureLedger, errorsAreKnownMissingTextures,
} from "../dist/code/browser/bench/KnownMissingTextures.js";

const ORIGIN = "http://127.0.0.1:5000";
const MISSING = `${ORIGIN}/texture?path=World%5CExpansion05%5CDoodads%5CWaterfallDrops.blp`;

function fakeTarget(statuses) {
  return {
    fetch: async (input) => {
      const url = typeof input === "string" ? input : input.url ?? input.href;
      const status = statuses[url];
      if (status === "throw") throw new TypeError("fetch failed");
      return { ok: (status ?? 200) < 400, status: status ?? 200, url };
    },
    createImageBitmap: async (blob) => {
      if (blob === "broken") throw new Error("undecodable");
      return { width: 1, height: 1 };
    },
  };
}

test("a texture the asset server answers 404 explains the model-texture errors", async () => {
  const target = fakeTarget({ [MISSING]: 404 });
  const ledger = installKnownMissingTextureLedger(target, ORIGIN);
  await target.fetch(`${ORIGIN}/texture?path=A.blp`);
  const response = await target.fetch(MISSING);
  assert.equal(response.status, 404, "the answer is passed through unchanged");
  await target.fetch(`${ORIGIN}/terrain/0/1/2`);
  assert.deepEqual([...ledger.missing], ["/texture?path=World%5CExpansion05%5CDoodads%5CWaterfallDrops.blp"]);
  assert.equal(ledger.otherFailures, 0);
  assert.equal(errorsAreKnownMissingTextures({ errors: 3, modelTexturesErrors: 3 }, ledger), true);
  assert.equal(errorsAreKnownMissingTextures({ errors: 0, modelTexturesErrors: 0 }, ledger), false, "no errors, nothing to explain");
  assert.equal(errorsAreKnownMissingTextures({ errors: 4, modelTexturesErrors: 3 }, ledger), false,
    "an error outside the model textures is never explained");
});

test("a 404 outside the texture route is not a missing texture", async () => {
  const target = fakeTarget({ [`${ORIGIN}/terrain/604/31/29`]: 404 });
  const ledger = installKnownMissingTextureLedger(target, ORIGIN);
  await target.fetch(`${ORIGIN}/terrain/604/31/29`);
  assert.equal(ledger.missing.size, 0);
  assert.equal(errorsAreKnownMissingTextures({ errors: 1, modelTexturesErrors: 1 }, ledger), false);
});

test("any other texture failure or a failed decode keeps the scene refused", async () => {
  for (const [label, act] of [
    ["500", async (target) => target.fetch(`${ORIGIN}/texture?path=B.blp`)],
    ["network", async (target) => target.fetch(`${ORIGIN}/texture?path=C.blp`).catch(() => {})],
    ["decode", async (target) => target.createImageBitmap("broken").catch(() => {})],
  ]) {
    const target = fakeTarget({ [MISSING]: 404, [`${ORIGIN}/texture?path=B.blp`]: 500, [`${ORIGIN}/texture?path=C.blp`]: "throw" });
    const ledger = installKnownMissingTextureLedger(target, ORIGIN);
    await target.fetch(MISSING);
    await act(target);
    assert.equal(ledger.otherFailures, 1, label);
    assert.equal(errorsAreKnownMissingTextures({ errors: 2, modelTexturesErrors: 2 }, ledger), false, label);
  }
});

test("a Request or URL object is classified like a string", async () => {
  const target = fakeTarget({ [MISSING]: 404 });
  const ledger = installKnownMissingTextureLedger(target, ORIGIN);
  await target.fetch(new URL(MISSING));
  await target.fetch({ url: MISSING });
  assert.equal(ledger.missing.size, 1);
});
