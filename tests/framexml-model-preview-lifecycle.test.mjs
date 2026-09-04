import assert from "node:assert/strict";
import test from "node:test";
import { GlueModelStage } from "../dist/code/browser/glue/GlueModelStage.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function model() {
  // A real, untextured static model build is enough to observe scene ownership and disposal.
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 2]),
    normals: new Float32Array(9), uv0: new Float32Array(6), uv1: new Float32Array(6),
    indices: new Uint16Array([0, 1, 2]), submeshes: [], batches: [], textures: [],
    particleEmitters: [], ribbonEmitters: [], bounds: { min: [0, 0, 0], max: [1, 0, 2] },
  };
}

function harness() {
  const frame = { type: "PlayerModel", name: "AddonPreview", model: { file: "", sequence: 0 } };
  const element = { children: [], append(child) { this.children.push(child); child.parent = this; },
    ownerDocument: { createElement() { return { style: {}, setAttribute() {}, getContext() { return {}; },
      remove() { this.parent.children = this.parent.children.filter((child) => child !== this); },
    }; } },
  };
  const state = { visible: true, key: "A", resolutions: 0, rendererCalls: 0 };
  const views = [];
  const diagnostics = [];
  const pending = { A: deferred(), B: deferred() };
  const stage = new GlueModelStage({ gatewayOrigin: "http://gateway.invalid", models: () => [frame],
    elementFor: () => element, isVisible: () => state.visible,
    resolveModel() { state.resolutions += 1; return state.key ? { key: state.key, file: `${state.key}.m2` } : undefined; },
    onDiagnostic: (line) => diagnostics.push(line),
  });
  // Replace transport and WebGL only; reconciliation, model building and teardown remain real.
  stage.model = (path) => pending[path[0]].promise;
  stage.renderer = () => { state.rendererCalls += 1; return undefined; };
  const createView = stage.createView.bind(stage);
  stage.createView = (...args) => { const view = createView(...args); views.push(view); return view; };
  return { stage, state, views, diagnostics, pending, element };
}

test("hidden/empty addon previews do not resolve metadata or allocate a WebGL renderer", () => {
  const { stage, state } = harness();
  try {
    state.visible = false;
    stage.reconcile();
    stage.frame(1, 1000);
    assert.equal(stage.stats.views, 0);
    assert.equal(state.resolutions, 0);
    assert.equal(state.rendererCalls, 0);
    state.visible = true;
    state.key = "";
    stage.reconcile();
    stage.frame(1, 2000);
    assert.equal(stage.stats.views, 0);
    assert.equal(state.rendererCalls, 0);
  } finally { stage.dispose(); }
});

test("A to B to A while fetching publishes one model and disposes every owned geometry", async () => {
  const { stage, state, pending, views, diagnostics } = harness();
  try {
    stage.reconcile();
    state.key = "B"; stage.reconcile();
    state.key = "A"; stage.reconcile();
    pending.A.resolve(model());
    await settle();
    const view = views[0];
    const meshes = view.scene.children.filter((child) => child.isMesh);
    assert.equal(meshes.length, 1, "the obsolete first A request must not attach a second mesh");
    assert.equal(view.root, meshes[0]);
    let disposed = 0;
    meshes[0].geometry.addEventListener("dispose", () => { disposed += 1; });
    pending.B.resolve(model());
    await settle();
    assert.equal(view.scene.children.filter((child) => child.isMesh).length, 1);
    stage.dispose();
    assert.equal(disposed, 1);
    assert.equal(view.scene.children.filter((child) => child.isMesh).length, 0);
    assert.deepEqual(diagnostics, []);
  } finally { stage.dispose(); }
});

test("ClearModel and same-model re-entry reject the retired view's pending result", async () => {
  const { stage, state, pending, views, element, diagnostics } = harness();
  try {
    stage.reconcile();
    state.key = ""; stage.reconcile();
    assert.equal(element.children.length, 0, "ClearModel removes the old canvas immediately");
    state.key = "A"; stage.reconcile();
    assert.equal(views.length, 2);
    pending.A.resolve(model());
    await settle();
    assert.equal(views[0].scene.children.filter((child) => child.isMesh).length, 0);
    assert.equal(views[1].scene.children.filter((child) => child.isMesh).length, 1);
    assert.deepEqual(diagnostics, []);
  } finally { stage.dispose(); }
});

test("a result arriving after stage disposal cannot resurrect a mesh or canvas", async () => {
  const { stage, pending, views, element, diagnostics } = harness();
  stage.reconcile();
  stage.dispose();
  pending.A.resolve(model());
  await settle();
  assert.equal(stage.stats.views, 0);
  assert.equal(element.children.length, 0);
  assert.equal(views[0].scene.children.filter((child) => child.isMesh).length, 0);
  assert.deepEqual(diagnostics, []);
});
