import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLISION_HULL_RESPONSE_LIMIT_BYTES,
  ENVIRONMENT_ANIMATION_ENTRY_TYPED_BACKING_LIMIT_BYTES,
  ENVIRONMENT_ANIMATION_TYPED_BACKING_BUDGET_BYTES,
  ENVIRONMENT_MODEL_ENTRY_NUMERIC_ARRAY_LIMIT_ELEMENTS,
  ENVIRONMENT_MODEL_ENTRY_TYPED_BACKING_LIMIT_BYTES,
  ENVIRONMENT_MODEL_NUMERIC_ARRAY_BUDGET_ELEMENTS,
  ENVIRONMENT_MODEL_TYPED_BACKING_BUDGET_BYTES,
  VISUAL_MODEL_RESPONSE_LIMIT_BYTES,
  WMO_GROUP_RESPONSE_LIMIT_BYTES,
  WVA_ANIMATION_RESPONSE_LIMIT_BYTES,
  EnvironmentClient,
  decodedResidencyCost,
} from "../dist/code/browser/Terrain.js";

const settle = async (turns = 6) => {
  for (let turn = 0; turn < turns; turn++) await new Promise((resolve) => setImmediate(resolve));
};

function legacyModel(vertexCount = 1) {
  const data = new ArrayBuffer(16 + vertexCount * 20);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x56, 0x4d, 0x31]);
  view.setUint32(4, vertexCount, true);
  return data;
}

/** `animationId` makes otherwise equal blocks distinct: identical sidecars share one decoded set. */
function oneKeyAnimation(animationId = 0) {
  const data = new ArrayBuffer(48);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x56, 0x41, 0x31]);
  view.setUint32(4, data.byteLength, true);
  view.setUint16(8, 1, true);
  view.setUint16(10, 1, true);
  view.setUint16(12, animationId, true);
  view.setUint32(16, 1_000, true);
  view.setUint32(20, 1, true);
  view.setUint32(28, 1, true);
  return data;
}

function wmoHeader() {
  const data = new ArrayBuffer(64);
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  bytes.set([0x57, 0x57, 0x4d, 0x31]);
  view.setUint32(4, 1, true);
  view.setUint32(16, data.byteLength, true);
  view.setFloat32(24, -1, true);
  view.setFloat32(28, -1, true);
  view.setFloat32(32, -1, true);
  view.setFloat32(36, 1, true);
  view.setFloat32(40, 1, true);
  view.setFloat32(44, 1, true);
  view.setUint32(52, 1, true);
  return data;
}

function wmoGroup(index = 0) {
  const data = new ArrayBuffer(40);
  const view = new DataView(data);
  view.setUint32(0, 1, true);
  view.setUint8(10, 2);
  view.setUint16(12, index, true);
  view.setFloat32(16, 3, true);
  return data;
}

function responseWithArrayBuffer(data, headers) {
  return {
    ok: true,
    status: 200,
    ...(headers ? { headers } : {}),
    arrayBuffer: async () => data,
  };
}

function pathOf(url) {
  return new URL(String(url)).searchParams.get("path");
}

test("decodedResidencyCost deduplicates typed backing stores and counts only ordinary-array numbers", () => {
  const backing = new ArrayBuffer(64);
  const root = {
    first: new Uint8Array(backing, 0, 8),
    second: new Float32Array(backing, 16, 4),
    values: [1, "2", Number.NaN, [3], { scalar: 4 }],
  };
  root.values.push(root);
  assert.deepEqual(decodedResidencyCost(root), {
    typedBackingBytes: 64,
    numericArrayElements: 3,
  });
});

test("EnvironmentClient exports conservative defaults, accepts legacy calls, and validates overrides", () => {
  assert.deepEqual({
    modelTyped: ENVIRONMENT_MODEL_TYPED_BACKING_BUDGET_BYTES,
    modelNumeric: ENVIRONMENT_MODEL_NUMERIC_ARRAY_BUDGET_ELEMENTS,
    animationTyped: ENVIRONMENT_ANIMATION_TYPED_BACKING_BUDGET_BYTES,
    modelEntryTyped: ENVIRONMENT_MODEL_ENTRY_TYPED_BACKING_LIMIT_BYTES,
    modelEntryNumeric: ENVIRONMENT_MODEL_ENTRY_NUMERIC_ARRAY_LIMIT_ELEMENTS,
    animationEntryTyped: ENVIRONMENT_ANIMATION_ENTRY_TYPED_BACKING_LIMIT_BYTES,
    visualResponse: VISUAL_MODEL_RESPONSE_LIMIT_BYTES,
    groupResponse: WMO_GROUP_RESPONSE_LIMIT_BYTES,
    animationResponse: WVA_ANIMATION_RESPONSE_LIMIT_BYTES,
    hullResponse: COLLISION_HULL_RESPONSE_LIMIT_BYTES,
  }, {
    modelTyped: 64 * 1024 * 1024,
    modelNumeric: 8_000_000,
    animationTyped: 64 * 1024 * 1024,
    modelEntryTyped: 32 * 1024 * 1024,
    modelEntryNumeric: 4_000_000,
    animationEntryTyped: 24 * 1024 * 1024,
    visualResponse: 4 * 1024 * 1024,
    groupResponse: 2 * 1024 * 1024,
    animationResponse: 16 * 1024 * 1024,
    hullResponse: 16 * 1024 * 1024,
  });
  assert.doesNotThrow(() => new EnvironmentClient("ws://example.test/world", Date.now, 2, 3, 4));
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => new EnvironmentClient("ws://example.test/world", Date.now, 2, 3, 4, { modelTypedBackingBytes: value }),
      RangeError,
    );
  }
});

test("aggregate model LRU plateaus by exact numeric elements and refetches an evicted identity", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(pathOf(url));
    return responseWithArrayBuffer(legacyModel());
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelNumericArrayElements: 6,
      modelEntryNumericArrayElements: 100,
    });
    client.model("A.m2", "critical");
    await settle();
    client.model("B.m2", "critical");
    await settle();
    assert.deepEqual({
      resident: client.stats.residentModels,
      numeric: client.stats.modelDecodedNumericArrayElements,
      overflow: client.stats.modelDecodedNumericArrayOverflowElements,
    }, { resident: 1, numeric: 5, overflow: 0 });
    client.model("A.m2", "critical");
    await settle();
    assert.equal(requests.filter((path) => path === "A.m2").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("active model pins publish exact overflow and converge below budget after footprint change", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseWithArrayBuffer(legacyModel());
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelNumericArrayElements: 6,
      modelEntryNumericArrayElements: 100,
    });
    client.beginResourceFrame();
    client.model("A.m2", "critical");
    client.model("B.m2", "critical");
    client.endResourceFrame();
    await settle();
    assert.deepEqual({
      numeric: client.stats.modelDecodedNumericArrayElements,
      overflow: client.stats.modelDecodedNumericArrayOverflowElements,
    }, { numeric: 10, overflow: 4 });
    client.beginResourceFrame();
    client.endResourceFrame();
    assert.deepEqual({
      resident: client.stats.residentModels,
      numeric: client.stats.modelDecodedNumericArrayElements,
      overflow: client.stats.modelDecodedNumericArrayOverflowElements,
    }, { resident: 1, numeric: 5, overflow: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model and animation aggregate budgets evict independently", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/visual/animations")
    ? responseWithArrayBuffer(oneKeyAnimation(pathOf(url) === "A.m2" ? 1 : 2))
    : responseWithArrayBuffer(legacyModel());
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelNumericArrayElements: 6,
      modelEntryNumericArrayElements: 100,
      animationTypedBackingBytes: 20,
      animationEntryTypedBackingBytes: 100,
    });
    client.model("A.m2", "critical");
    client.model("B.m2", "critical");
    client.animations("A.m2", 1, "critical");
    client.animations("B.m2", 1, "critical");
    await settle();
    assert.deepEqual({
      models: client.stats.residentModels,
      modelNumeric: client.stats.modelDecodedNumericArrayElements,
      animations: client.stats.residentAnimations,
      animationTyped: client.stats.animationDecodedTypedBackingBytes,
    }, { models: 1, modelNumeric: 5, animations: 1, animationTyped: 16 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hard decoded entry limits are terminal for the exact model and animation identities", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url).includes("/visual/animations")
      ? responseWithArrayBuffer(oneKeyAnimation())
      : responseWithArrayBuffer(legacyModel());
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelEntryNumericArrayElements: 4,
      animationEntryTypedBackingBytes: 15,
    });
    client.model("TooNumeric.m2", "critical");
    client.animations("TooTyped.m2", 1, "critical");
    await settle();
    assert.deepEqual({
      failedModels: client.stats.failedModels,
      missingModels: client.stats.knownMissingModels,
      failedAnimations: client.stats.failedAnimations,
    }, { failedModels: 1, missingModels: 0, failedAnimations: 1 });
    client.model("TooNumeric.m2", "critical");
    client.animations("TooTyped.m2", 1, "critical");
    await settle();
    assert.equal(requests.filter((url) => url.includes("TooNumeric.m2")).length, 1);
    assert.equal(requests.filter((url) => url.includes("TooTyped.m2")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounded responses reject declared, streamed, and arrayBuffer-fallback overflow without retries", async () => {
  const originalFetch = globalThis.fetch;
  const requests = new Map();
  let declaredCanceled = false;
  let streamCanceled = false;
  globalThis.fetch = async (url) => {
    const name = pathOf(url);
    requests.set(name, (requests.get(name) ?? 0) + 1);
    if (name === "Declared.m2") {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "33" }),
        body: { cancel: async () => { declaredCanceled = true; } },
        arrayBuffer: async () => { throw new Error("must not allocate declared overflow"); },
      };
    }
    if (name === "Streamed.m2") {
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(20));
          controller.enqueue(new Uint8Array(20));
        },
        cancel() { streamCanceled = true; },
      }));
    }
    return responseWithArrayBuffer(new ArrayBuffer(33));
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      visualModelResponseBytes: 32,
      animationResponseBytes: 32,
    });
    client.model("Declared.m2", "critical");
    client.model("Fallback.m2", "critical");
    client.animations("Streamed.m2", 1, "critical");
    await settle();
    assert.equal(declaredCanceled, true);
    assert.equal(streamCanceled, true);
    assert.deepEqual({ failedModels: client.stats.failedModels, failedAnimations: client.stats.failedAnimations }, {
      failedModels: 2,
      failedAnimations: 1,
    });
    client.model("Declared.m2", "critical");
    client.model("Fallback.m2", "critical");
    client.animations("Streamed.m2", 1, "critical");
    await settle();
    assert.deepEqual(Object.fromEntries(requests), {
      "Declared.m2": 1,
      "Fallback.m2": 1,
      "Streamed.m2": 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("collision-hull and WMO-group routes enforce their independent response limits", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    requests.push(String(url));
    if (address.pathname.includes("/environment/model/")) {
      return responseWithArrayBuffer(new ArrayBuffer(33));
    }
    if (address.searchParams.has("group")) return responseWithArrayBuffer(wmoGroup());
    if (address.searchParams.get("path") === "Hull.m2") return new Response(null, { status: 404 });
    return responseWithArrayBuffer(wmoHeader());
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      collisionHullResponseBytes: 32,
      modelGroupResponseBytes: 39,
      modelEntryTypedBackingBytes: 1_000,
      modelEntryNumericArrayElements: 1_000,
    });
    client.model("Hull.m2", "critical");
    client.model("Group.wmo", "critical");
    await settle();
    client.requestModelGroups("Group.wmo", [0]);
    await settle();
    assert.deepEqual({ failedModels: client.stats.failedModels, failedGroups: client.stats.failedGroups }, {
      failedModels: 1,
      failedGroups: 1,
    });
    client.model("Hull.m2", "critical");
    client.requestModelGroups("Group.wmo", [0]);
    await settle();
    assert.equal(requests.filter((url) => pathOf(url) === "Hull.m2").length, 1);
    assert.equal(requests.filter((url) => new URL(url).pathname.includes("/environment/model/")).length, 1);
    assert.equal(requests.filter((url) => new URL(url).searchParams.has("group")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("WMO group growth updates totals, evicts inactive parents, and terminally rejects hard overflow", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    requests.push(String(url));
    return responseWithArrayBuffer(address.searchParams.has("group") ? wmoGroup() : wmoHeader());
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelTypedBackingBytes: 30,
      modelEntryTypedBackingBytes: 1_000,
      modelEntryNumericArrayElements: 1_000,
    });
    client.model("A.wmo", "critical");
    client.model("B.wmo", "critical");
    await settle();
    client.requestModelGroups("A.wmo", [0]);
    await settle();
    assert.equal(client.stats.modelDecodedTypedBackingBytes, 24);
    client.requestModelGroups("B.wmo", [0]);
    await settle();
    assert.deepEqual({ resident: client.stats.residentModels, typed: client.stats.modelDecodedTypedBackingBytes }, {
      resident: 1,
      typed: 24,
    });
    client.model("A.wmo", "critical");
    await settle();
    assert.equal(requests.filter((url) => pathOf(url) === "A.wmo" && !new URL(url).searchParams.has("group")).length, 2);

    const hard = new EnvironmentClient("ws://example.test/world", Date.now, 64, 10, 10, {
      modelEntryTypedBackingBytes: 20,
      modelEntryNumericArrayElements: 1_000,
    });
    hard.model("Hard.wmo", "critical");
    await settle();
    hard.requestModelGroups("Hard.wmo", [0]);
    await settle();
    assert.equal(hard.stats.failedGroups, 1);
    assert.equal(hard.model("Hard.wmo")?.wmo?.groups[0]?.mesh, undefined);
    const before = requests.filter((url) => pathOf(url) === "Hard.wmo" && new URL(url).searchParams.has("group")).length;
    hard.requestModelGroups("Hard.wmo", [0]);
    await settle();
    assert.equal(requests.filter((url) => pathOf(url) === "Hard.wmo" && new URL(url).searchParams.has("group")).length, before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("late group completion for an evicted parent never changes current cache totals", async () => {
  const originalFetch = globalThis.fetch;
  let releaseGroup;
  globalThis.fetch = async (url) => {
    const address = new URL(String(url));
    if (address.searchParams.has("group")) {
      return new Promise((resolve) => { releaseGroup = resolve; });
    }
    return responseWithArrayBuffer(wmoHeader());
  };
  try {
    const client = new EnvironmentClient("ws://example.test/world", Date.now, 64, 1, 10, {
      modelEntryTypedBackingBytes: 1_000,
      modelEntryNumericArrayElements: 1_000,
    });
    client.model("Old.wmo", "critical");
    await settle();
    client.requestModelGroups("Old.wmo", [0]);
    await settle(2);
    client.model("Current.wmo", "critical");
    await settle();
    assert.equal(client.stats.modelDecodedTypedBackingBytes, 0);
    releaseGroup(responseWithArrayBuffer(wmoGroup()));
    await settle();
    assert.deepEqual({ resident: client.stats.residentModels, typed: client.stats.modelDecodedTypedBackingBytes }, {
      resident: 1,
      typed: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dispose clears decoded ownership totals without mutating returned payloads", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/visual/animations")
    ? responseWithArrayBuffer(oneKeyAnimation())
    : responseWithArrayBuffer(legacyModel());
  try {
    const client = new EnvironmentClient("ws://example.test/world");
    client.model("Owned.m2", "critical");
    client.animations("Owned.m2", 1, "critical");
    await settle();
    const model = client.model("Owned.m2");
    const animations = client.animations("Owned.m2", 1);
    client.dispose();
    assert.deepEqual({
      modelTyped: client.stats.modelDecodedTypedBackingBytes,
      modelNumeric: client.stats.modelDecodedNumericArrayElements,
      animationTyped: client.stats.animationDecodedTypedBackingBytes,
      animationNumeric: client.stats.animationDecodedNumericArrayElements,
    }, { modelTyped: 0, modelNumeric: 0, animationTyped: 0, animationNumeric: 0 });
    assert.equal(model?.vertices.length, 3);
    assert.equal(animations?.[0]?.channels[0]?.values.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
