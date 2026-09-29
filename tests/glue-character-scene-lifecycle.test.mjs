import assert from "node:assert/strict";
import test from "node:test";
import { GlueCharacterScene } from "../dist/code/browser/glue/GlueCharacterScene.js";

const MODEL_PATH = "Character\\Human\\Male\\HumanMale.m2";

function look(key = "human") {
  return {
    key,
    displayId: 1,
    race: 1,
    sex: 0,
    skin: 0,
    face: 0,
    hairStyle: 0,
    hairColor: 0,
    facialHair: 0,
    items: "",
    label: key,
  };
}

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    json: async () => value,
  };
}

function modelMetadata() {
  return jsonResponse([{
    id: 1,
    model: MODEL_PATH,
    scale: 1,
    collisionHeight: 2,
    mountHeight: 0,
    textures: "",
  }]);
}

function appearance() {
  return jsonResponse({
    body: [],
    hair: "",
    cloak: "",
    geosets: [],
    attached: [],
  });
}

function createScene(readLook, onPlace = () => {}) {
  return new GlueCharacterScene({
    gatewayOrigin: "http://gateway",
    bridge: { getFrame: () => undefined },
    stage: {
      setActor: (...args) => {
        onPlace(...args);
        return false;
      },
    },
    look: readLook,
    facing: () => 0,
  });
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

test("dispose aborts every scene boundary and rejects a late model publish", async () => {
  const originalFetch = globalThis.fetch;
  let currentLook = look();
  let displaySignal;
  let appearanceSignal;
  let modelSignal;
  let resolveModel;
  let placements = 0;
  const scene = createScene(() => currentLook, () => { placements += 1; });

  globalThis.fetch = (input, options = {}) => {
    const url = String(input);
    if (url.includes("/dbc/creature-models")) {
      displaySignal = options.signal;
      return Promise.resolve(modelMetadata());
    }
    if (url.includes("/dbc/character-appearance")) {
      appearanceSignal = options.signal;
      return Promise.resolve(appearance());
    }
    if (url.includes("/visual/model")) {
      modelSignal = options.signal;
      return new Promise((resolve) => { resolveModel = resolve; });
    }
    throw new Error(`unexpected route: ${url}`);
  };

  try {
    scene.update();
    await waitFor(() => resolveModel !== undefined, "model request did not start");
    scene.dispose();

    assert.ok(displaySignal instanceof AbortSignal);
    assert.ok(appearanceSignal instanceof AbortSignal);
    assert.ok(modelSignal instanceof AbortSignal);
    assert.equal(displaySignal, appearanceSignal);
    assert.equal(appearanceSignal, modelSignal);
    assert.equal(modelSignal.aborted, true);

    // Resolve the old request after disposal. Its continuation must observe the abort/epoch and
    // must not install an actor or a stale diagnostic into the reusable scene.
    resolveModel({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(16),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scene.report.wanted, "");
    assert.equal(scene.report.built, false);
    assert.equal(scene.report.problem, "");
    assert.equal(placements, 0);
  } finally {
    scene.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("a failed parallel route aborts its sibling and allows a same-look retry", async () => {
  const originalFetch = globalThis.fetch;
  let currentLook = look("retry");
  let displayCalls = 0;
  let appearanceCalls = 0;
  let firstAppearanceSignal;
  let resolveFirstAppearance;
  let modelSignal;
  const scene = createScene(() => currentLook);

  globalThis.fetch = (input, options = {}) => {
    const url = String(input);
    if (url.includes("/dbc/creature-models")) {
      displayCalls += 1;
      if (displayCalls === 1) return Promise.reject(new Error("display unavailable"));
      return Promise.resolve(modelMetadata());
    }
    if (url.includes("/dbc/character-appearance")) {
      appearanceCalls += 1;
      if (appearanceCalls === 1) {
        firstAppearanceSignal = options.signal;
        return new Promise((resolve) => { resolveFirstAppearance = resolve; });
      }
      return Promise.resolve(appearance());
    }
    if (url.includes("/visual/model")) {
      modelSignal = options.signal;
      return new Promise(() => {});
    }
    throw new Error(`unexpected route: ${url}`);
  };

  try {
    scene.update();
    await waitFor(
      () => firstAppearanceSignal?.aborted === true && scene.report.wanted === "",
      "failed route did not abort sibling and clear the retry key",
    );
    assert.match(scene.report.problem, /retry: display unavailable/);
    assert.equal(displayCalls, 1);
    assert.equal(appearanceCalls, 1);

    // The key is intentionally unchanged: clearing #wanted above is what makes this a real retry.
    scene.update();
    await waitFor(() => displayCalls === 2 && appearanceCalls === 2, "same-look retry did not start");
    await waitFor(() => modelSignal !== undefined, "retry did not reach model loading");
    assert.equal(firstAppearanceSignal.aborted, true);
  } finally {
    scene.dispose();
    resolveFirstAppearance?.(appearance());
    globalThis.fetch = originalFetch;
  }
});

test("the same pending look is coalesced into one request per route", async () => {
  const originalFetch = globalThis.fetch;
  let currentLook = look("same");
  let modelResolve;
  const counts = { display: 0, appearance: 0, model: 0 };
  const scene = createScene(() => currentLook);

  globalThis.fetch = (input, options = {}) => {
    const url = String(input);
    if (url.includes("/dbc/creature-models")) {
      counts.display += 1;
      assert.ok(options.signal instanceof AbortSignal);
      return Promise.resolve(modelMetadata());
    }
    if (url.includes("/dbc/character-appearance")) {
      counts.appearance += 1;
      assert.ok(options.signal instanceof AbortSignal);
      return Promise.resolve(appearance());
    }
    if (url.includes("/visual/model")) {
      counts.model += 1;
      assert.ok(options.signal instanceof AbortSignal);
      return new Promise((resolve) => { modelResolve = resolve; });
    }
    throw new Error(`unexpected route: ${url}`);
  };

  try {
    scene.update();
    scene.update();
    await waitFor(() => modelResolve !== undefined, "coalesced model request did not start");
    assert.deepEqual(counts, { display: 1, appearance: 1, model: 1 });
    scene.dispose();
    modelResolve({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(16),
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    scene.dispose();
    globalThis.fetch = originalFetch;
  }
});

test("display metadata and appearance start in parallel with one abort signal", async () => {
  const originalFetch = globalThis.fetch;
  let currentLook = look("parallel");
  let displayResolve;
  let appearanceResolve;
  let modelSignal;
  let resolveModel;
  let displayStarted = false;
  let appearanceStarted = false;
  let displaySignal;
  let appearanceSignal;
  const scene = createScene(() => currentLook);

  globalThis.fetch = (input, options = {}) => {
    const url = String(input);
    if (url.includes("/dbc/creature-models")) {
      displayStarted = true;
      displaySignal = options.signal;
      return new Promise((resolve) => { displayResolve = resolve; });
    }
    if (url.includes("/dbc/character-appearance")) {
      appearanceStarted = true;
      appearanceSignal = options.signal;
      return new Promise((resolve) => { appearanceResolve = resolve; });
    }
    if (url.includes("/visual/model")) {
      modelSignal = options.signal;
      return new Promise((resolve) => { resolveModel = resolve; });
    }
    throw new Error(`unexpected route: ${url}`);
  };

  try {
    scene.update();
    await waitFor(() => displayStarted && appearanceStarted, "parallel routes did not both start");
    assert.ok(displaySignal instanceof AbortSignal);
    assert.equal(displaySignal, appearanceSignal);

    displayResolve(modelMetadata());
    appearanceResolve(appearance());
    await waitFor(() => modelSignal !== undefined, "model boundary did not follow parallel routes");
    scene.dispose();
    assert.equal(displaySignal.aborted, true);
    assert.equal(appearanceSignal.aborted, true);
    assert.equal(modelSignal.aborted, true);
    resolveModel({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(16),
    });
  } finally {
    scene.dispose();
    globalThis.fetch = originalFetch;
  }
});
