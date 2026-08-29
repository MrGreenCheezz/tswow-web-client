import assert from "node:assert/strict";
import test from "node:test";

import { CharacterAtlasClient } from "../dist/code/browser/CharacterAtlas.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installPage({ fetch, createImageBitmap }) {
  const canvases = [];
  const original = {
    fetch: globalThis.fetch,
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
  };
  globalThis.fetch = fetch;
  globalThis.createImageBitmap = createImageBitmap;
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      const canvas = {
        width: 0,
        height: 0,
        drawn: [],
        getContext: () => ({ drawImage: (...args) => canvas.drawn.push(args) }),
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  return {
    canvases,
    restore() {
      globalThis.fetch = original.fetch;
      globalThis.document = original.document;
      globalThis.createImageBitmap = original.createImageBitmap;
    },
  };
}

const found = { ok: true, status: 200, blob: async () => ({}) };
const layer = (path) => [{ path }];
const turn = () => new Promise((resolve) => setImmediate(resolve));

for (const stage of ["fetch", "blob", "decode"]) {
  test(`dispose rejects a late ${stage} result without resurrecting atlas state`, async () => {
    const gate = deferred();
    let closes = 0;
    const bitmap = { width: 256, height: 128, close: () => { closes++; } };
    let blobCalls = 0;
    let decodeCalls = 0;
    const response = {
      ok: true,
      status: 200,
      blob: async () => {
        blobCalls++;
        return stage === "blob" ? gate.promise : {};
      },
    };
    const page = installPage({
      fetch: () => stage === "fetch" ? gate.promise : Promise.resolve(response),
      createImageBitmap: async () => {
        decodeCalls++;
        return stage === "decode" ? gate.promise : bitmap;
      },
    });
    try {
      const atlas = new CharacterAtlasClient("http://lifecycle.test");
      const composing = atlas.compose("late", layer("late.blp"));
      if (stage !== "fetch") await turn();
      assert.deepEqual([blobCalls, decodeCalls], stage === "fetch" ? [0, 0]
        : stage === "blob" ? [1, 0] : [1, 1],
      `the request is paused at the ${stage} gate before disposal`);

      atlas.dispose();
      atlas.dispose();
      assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });

      if (stage === "fetch") gate.resolve(response);
      else if (stage === "blob") gate.resolve({});
      else gate.resolve(bitmap);
      assert.equal(await composing, undefined);
      await turn();

      assert.equal(closes, stage === "decode" ? 1 : 0,
        "work already inside decode closes its late bitmap; earlier aborts never allocate one");
      assert.equal(page.canvases.length, 0, "a stale compose never allocates an atlas canvas");
      assert.equal(atlas.get("late"), undefined);
      assert.equal(atlas.generation("late"), 0);
      assert.equal(atlas.failures, 0);
      assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 },
        "late settlement cannot change disposed readiness state");
    } finally {
      page.restore();
    }
  });
}

test("a late transport failure after dispose cannot recreate retry ownership", async () => {
  const gate = deferred();
  const page = installPage({
    fetch: () => gate.promise,
    createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("failed-late", layer("failed-late.blp"));
    atlas.dispose();
    gate.reject(new Error("late network failure"));
    assert.equal(await composing, undefined);
    assert.equal(atlas.failures, 0);
    assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });
  } finally {
    page.restore();
  }
});

test("an owned canvas failure resolves empty instead of rejecting a fire-and-forget compose", async () => {
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close() {} }),
  });
  try {
    globalThis.document.createElement = () => { throw new Error("canvas exploded"); };
    const atlas = new CharacterAtlasClient("http://lifecycle.test");

    await assert.doesNotReject(async () => {
      assert.equal(await atlas.compose("canvas-error", layer("canvas-error.blp")), undefined);
    }, "renderer callers use void compose, so an owned build failure must not reject");
    assert.deepEqual(atlas.stats, { pending: 0, success: 1, error: 1, generation: 2 });

    assert.equal(await atlas.compose("canvas-error", layer("canvas-error.blp")), undefined,
      "the terminal look is not rebuilt on the next renderer frame");
    assert.equal(page.canvases.length, 0);
    atlas.dispose();
  } finally {
    page.restore();
  }
});

test("release cancels exact compose publication and old finally preserves its replacement", async () => {
  const responses = new Map();
  const bitmaps = new Map();
  let closes = 0;
  const page = installPage({
    fetch: (url) => {
      const path = decodeURIComponent(String(url).replace(/^.*\?path=/, ""));
      let gate = responses.get(path);
      if (!gate) {
        gate = deferred();
        responses.set(path, gate);
      }
      return gate.promise;
    },
    createImageBitmap: async (blob) => {
      const bitmap = { width: 256, height: 128, path: blob.path, close: () => { closes++; } };
      bitmaps.set(blob.path, bitmap);
      return bitmap;
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const oldCompose = atlas.compose("look", layer("old.blp"));
    atlas.release("look");
    const replacement = atlas.compose("look", layer("new.blp"));

    responses.get("old.blp").resolve({
      ok: true, status: 200, blob: async () => ({ path: "old.blp" }),
    });
    assert.equal(await oldCompose, undefined);
    assert.equal(page.canvases.length, 0, "the released request cannot publish an atlas");
    assert.equal(atlas.failures, 0);
    assert.equal(atlas.stats.generation, 0,
      "the released source is stale and cannot change global readiness generation");
    assert.equal(atlas.stats.pending, 2,
      "old finally leaves the replacement compose and its image request registered");

    responses.get("new.blp").resolve({
      ok: true, status: 200, blob: async () => ({ path: "new.blp" }),
    });
    const texture = await replacement;
    assert.ok(texture);
    assert.equal(atlas.get("look"), texture);
    assert.equal(page.canvases.length, 1);
    assert.equal(closes, 0, "release keeps source images available to other looks");

    atlas.dispose();
    assert.equal(closes, 1, "the aborted old source is never decoded; the replacement closes once");
  } finally {
    page.restore();
  }
});

test("a released cached-source build is inert and may be replaced under the same key", async () => {
  let closes = 0;
  let fetches = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => { fetches++; return found; },
    createImageBitmap: async () => bitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    assert.ok(await atlas.compose("seed", layer("shared.blp")));
    const canvases = page.canvases.length;
    const generation = atlas.stats.generation;

    const stale = atlas.compose("look", layer("shared.blp"));
    atlas.release("look");
    assert.equal(await stale, undefined);
    assert.equal(atlas.stats.generation, generation,
      "the released compose does not settle readiness or failure state");
    assert.equal(page.canvases.length, canvases,
      "the stale cached-source continuation does not allocate a canvas");

    const replacement = atlas.compose("look", layer("shared.blp"));
    assert.ok(await replacement);
    assert.equal(fetches, 1, "release does not discard the session source cache");
    assert.equal(page.canvases.length, canvases + 1);
    assert.equal(closes, 0);
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("release removes ownership before a dispose listener composes the same key", async () => {
  let closes = 0;
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close: () => { closes++; } }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const old = await atlas.compose("reentrant", layer("old-reentrant.blp"));
    assert.ok(old);
    let oldDisposals = 0;
    let replacementPromise;
    old.addEventListener("dispose", () => {
      oldDisposals++;
      replacementPromise = atlas.compose("reentrant", layer("new-reentrant.blp"));
    });

    atlas.release("reentrant");
    assert.equal(oldDisposals, 1);
    assert.ok(replacementPromise, "the synchronous listener started replacement ownership");
    const replacement = await replacementPromise;
    assert.ok(replacement);
    assert.notEqual(replacement, old, "the disposed atlas is never returned as the replacement");
    assert.equal(atlas.get("reentrant"), replacement,
      "the outer release cannot delete a replacement created by its dispose listener");

    atlas.dispose();
    assert.equal(oldDisposals, 1, "the released texture is disposed exactly once");
    assert.equal(closes, 2, "both source identities remain shared until client disposal");
  } finally {
    page.restore();
  }
});

test("inactive no-atlas work is pruned independently of successful texture-cache size", async () => {
  const page = installPage({
    fetch: async (url) => String(url).includes("terminal")
      ? { ok: false, status: 404 }
      : { ok: false, status: 500 },
    createImageBitmap: async () => { throw new Error("failed responses are never decoded"); },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test", () => 0);
    assert.equal(await atlas.compose("kept-retry", layer("retry.blp")), undefined);
    assert.equal(await atlas.compose("gone-terminal", layer("terminal.blp")), undefined);
    assert.equal(atlas.size, 0, "no-paint ownership is invisible to the composed texture count");
    assert.equal(atlas.stats.pending, 1);
    assert.equal(atlas.stats.error, 1);

    atlas.pruneInactiveWork(new Set(["kept-retry"]));
    assert.equal(atlas.stats.pending, 1, "the prospective current-frame look remains owned");
    assert.equal(atlas.stats.error, 0, "the invisible terminal look no longer blocks readiness");

    atlas.pruneInactiveWork(new Set());
    assert.equal(atlas.stats.pending, 0, "an invisible finite retry is cancelled under the count cap");
    assert.equal(atlas.failures, 0);
    atlas.dispose();
  } finally {
    page.restore();
  }
});

test("pruning the last no-atlas owner aborts its exact source and ignores a late transport answer", async () => {
  const transport = deferred();
  let signal;
  let aborts = 0;
  let decodes = 0;
  let closes = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: (_url, options) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => { aborts++; });
      return transport.promise;
    },
    createImageBitmap: async () => {
      decodes++;
      return bitmap;
    },
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("gone", layer("gone.blp"));
    await turn();
    assert.equal(atlas.stats.pending, 2, "one source read and its compose are both visible initially");
    const generation = atlas.stats.generation;

    atlas.commitPins(new Set(), new Set());
    atlas.pruneInactiveWork(new Set());
    assert.equal(signal?.aborted, true);
    assert.equal(aborts, 1);
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.residencyStats.sources.activeLeases, 0);
    assert.equal(atlas.stats.pending, 0);

    // The test transport deliberately ignores AbortSignal and still resolves. Exact request
    // identity must suppress it before decode/admission/generation changes.
    transport.resolve(found);
    assert.equal(await composing, undefined);
    await turn();
    assert.equal(decodes, 0);
    assert.equal(closes, 0);
    assert.equal(atlas.stats.generation, generation);
    assert.equal(atlas.residencyStats.sources.count, 0);
  } finally {
    page.restore();
  }
});

test("a released candidate chain cannot acquire an alternate source after its primary aborts", async () => {
  const primary = deferred();
  const fetched = [];
  const page = installPage({
    fetch: (url) => {
      const path = new URL(url).searchParams.get("path");
      fetched.push(path);
      if (path === "primary.blp") return primary.promise;
      return Promise.resolve(found);
    },
    createImageBitmap: async () => ({ width: 256, height: 128, close() {} }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const composing = atlas.compose("gone-chain", [{
      path: "primary.blp",
      candidates: ["primary.blp", "alternate.blp"],
    }]);
    await turn();
    atlas.release("gone-chain");
    primary.resolve(found);
    assert.equal(await composing, undefined);
    await turn();
    assert.deepEqual(fetched, ["primary.blp"],
      "the stale continuation cannot create ownership that release never had a chance to visit");
    assert.equal(atlas.residencyStats.sources.count, 0);
    assert.equal(atlas.stats.generation, 0);
  } finally {
    page.restore();
  }
});

test("retain cancels only unretained compose publication and preserves the kept look", async () => {
  let closes = 0;
  const bitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => bitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    assert.ok(await atlas.compose("seed", layer("shared.blp")));
    const generation = atlas.stats.generation;
    const kept = atlas.compose("kept", layer("shared.blp"));
    const dropped = atlas.compose("dropped", layer("shared.blp"));

    atlas.retain(new Set(["seed", "kept"]));
    assert.equal(await dropped, undefined);
    assert.ok(await kept);
    assert.equal(atlas.get("dropped"), undefined);
    assert.ok(atlas.get("kept"));
    assert.equal(atlas.stats.generation, generation + 1,
      "only the retained composition settles readiness");
    assert.equal(page.canvases.length, 2, "the unretained continuation never allocates a canvas");
    assert.equal(closes, 0, "retain/release do not own the shared source cache");
    atlas.dispose();
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("dispose closes aliased ready bitmaps once and leaves every public operation inert", async () => {
  let closes = 0;
  let fetches = 0;
  const sharedBitmap = { width: 256, height: 128, close: () => { closes++; } };
  const page = installPage({
    fetch: async () => { fetches++; return found; },
    createImageBitmap: async () => sharedBitmap,
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const first = await atlas.compose("first", layer("first.blp"));
    const second = await atlas.compose("second", layer("second.blp"));
    assert.ok(first && second);
    let textureDisposals = 0;
    first.addEventListener("dispose", () => { textureDisposals++; });
    second.addEventListener("dispose", () => { textureDisposals++; });

    atlas.dispose();
    atlas.dispose();
    assert.equal(closes, 1, "one decoder identity is closed once even when two paths returned it");
    assert.equal(textureDisposals, 2);
    assert.deepEqual(atlas.stats, { pending: 0, success: 0, error: 0, generation: 0 });

    assert.equal(atlas.get("first"), undefined);
    assert.equal(atlas.generation("first"), 0);
    assert.equal(await atlas.compose("after", layer("after.blp")), undefined);
    atlas.refresh();
    atlas.retain(new Set(["first"]));
    atlas.pruneInactiveWork(new Set(["first"]));
    atlas.release("first");
    atlas.setAnisotropy(8);
    assert.equal(fetches, 2, "post-dispose operations cannot start new work");
    assert.equal(page.canvases.length, 2);
    assert.equal(closes, 1);
  } finally {
    page.restore();
  }
});

test("dispose publishes empty state before listeners and continues after a listener throws", async () => {
  let closes = 0;
  const page = installPage({
    fetch: async () => found,
    createImageBitmap: async () => ({ width: 256, height: 128, close: () => { closes++; } }),
  });
  try {
    const atlas = new CharacterAtlasClient("http://lifecycle.test");
    const first = await atlas.compose("throwing-first", layer("throwing-first.blp"));
    const second = await atlas.compose("throwing-second", layer("throwing-second.blp"));
    assert.ok(first && second);
    let secondDisposals = 0;
    let observedSize;
    let observedStats;
    first.addEventListener("dispose", () => {
      observedSize = atlas.size;
      observedStats = atlas.stats;
      throw new Error("listener exploded");
    });
    second.addEventListener("dispose", () => { secondDisposals++; });

    assert.doesNotThrow(() => atlas.dispose());
    assert.equal(observedSize, 0, "a synchronous listener observes the closed ownership boundary");
    assert.deepEqual(observedStats, { pending: 0, success: 0, error: 0, generation: 0 });
    assert.equal(secondDisposals, 1, "one bad listener cannot strand later textures");
    assert.equal(closes, 2, "ready source images are still released after the throwing listener");
  } finally {
    page.restore();
  }
});
