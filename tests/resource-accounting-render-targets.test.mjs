import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { PortraitRenderer } from "../dist/code/browser/PortraitRenderer.js";
import { ResourceAccountingLedger } from "../dist/code/browser/ResourceAccounting.js";
import { benchmarkResourceCheckpoint } from "../dist/code/browser/RenderBenchmarkRuntime.js";

function emptyIdentitySection(bytesName) {
  return {
    [bytesName]: 0,
    knownByteResources: 0,
    unknownByteResources: 0,
    uniqueResources: 0,
    owners: 0,
    references: 0,
    sharedResources: 0,
  };
}

test("render-target attachment identity is the Texture object, never its shared Source", () => {
  const first = new THREE.WebGLRenderTarget(4, 2);
  const second = new THREE.WebGLRenderTarget(4, 2);
  second.texture.source = first.texture.source;
  const ledger = new ResourceAccountingLedger();

  ledger.referenceGpuRenderTarget("first-target", first);
  ledger.referenceGpuRenderTarget("first-target", first);
  ledger.referenceGpuRenderTarget("second-target", second);
  ledger.referenceGpuTexture("material", first.texture);
  const snapshot = ledger.snapshot();

  assert.deepEqual(snapshot.gpuTextures, {
    estimatedLogicalTextureBytes: 64,
    knownByteResources: 2,
    unknownByteResources: 0,
    uniqueResources: 2,
    owners: 3,
    references: 3,
    sharedResources: 1,
  });
  assert.deepEqual(snapshot.gpuRenderbuffers, {
    estimatedLogicalRenderbufferBytes: 48,
    knownByteResources: 2,
    unknownByteResources: 0,
    uniqueResources: 2,
    owners: 2,
    references: 2,
    sharedResources: 0,
  });
});

test("manual target.texture replacement is one conservative unknown allocation in either visit order", () => {
  for (const order of ["target-first", "texture-first"]) {
    const target = new THREE.WebGLRenderTarget(4, 2);
    const replacement = new THREE.DataTexture(new Uint8Array(4 * 2 * 4), 4, 2);
    target.texture = replacement;
    assert.equal(replacement.renderTarget, null,
      "r185's texture setter does not restore the attachment back-reference");
    assert.equal(replacement.isRenderTargetTexture, false);

    const ledger = new ResourceAccountingLedger();
    if (order === "target-first") {
      ledger.referenceGpuRenderTarget("target", target);
      ledger.referenceGpuTexture("material", replacement);
    } else {
      ledger.referenceGpuTexture("material", replacement);
      ledger.referenceGpuRenderTarget("target", target);
    }
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 0,
      `${order}: ambiguous attachment identity must not claim known bytes twice`);
    assert.equal(snapshot.gpuTextures.knownByteResources, 0);
    assert.equal(snapshot.gpuTextures.unknownByteResources, 1,
      `${order}: the replacement remains one explicit unknown allocation`);
    assert.equal(snapshot.gpuTextures.uniqueResources, 1);
  }
});

test("non-MSAA 2D targets account generated/manual mips and every MRT attachment", () => {
  const generated = new THREE.WebGLRenderTarget(4, 2, {
    depthBuffer: false,
    generateMipmaps: true,
  });
  const manual = new THREE.WebGLRenderTarget(4, 2, { depthBuffer: false });
  manual.texture.mipmaps = [{}, {}, {}];
  const mrt = new THREE.WebGLRenderTarget(4, 2, { count: 2, depthBuffer: false });
  const ledger = new ResourceAccountingLedger();

  ledger.referenceGpuRenderTarget("generated", generated);
  ledger.referenceGpuRenderTarget("manual", manual);
  ledger.referenceGpuRenderTarget("mrt", mrt);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 44 + 44 + 64);
  assert.equal(snapshot.gpuTextures.knownByteResources, 4);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
  assert.deepEqual(snapshot.gpuRenderbuffers,
    emptyIdentitySection("estimatedLogicalRenderbufferBytes"));
});

test("depth texture replaces the depth renderbuffer; depth-off and stencil layouts stay exact", () => {
  const withDepthTexture = new THREE.WebGLRenderTarget(4, 2, {
    depthTexture: new THREE.DepthTexture(4, 2),
  });
  const noDepth = new THREE.WebGLRenderTarget(4, 2, { depthBuffer: false });
  const stencil = new THREE.WebGLRenderTarget(4, 2, { stencilBuffer: true });

  const depthLedger = new ResourceAccountingLedger();
  depthLedger.referenceGpuRenderTarget("shadow", withDepthTexture);
  assert.deepEqual(depthLedger.snapshot().gpuTextures, {
    estimatedLogicalTextureBytes: 32 + 24,
    knownByteResources: 2,
    unknownByteResources: 0,
    uniqueResources: 2,
    owners: 1,
    references: 2,
    sharedResources: 0,
  });
  assert.deepEqual(depthLedger.snapshot().gpuRenderbuffers,
    emptyIdentitySection("estimatedLogicalRenderbufferBytes"));

  const variants = new ResourceAccountingLedger();
  variants.referenceGpuRenderTarget("no-depth", noDepth);
  variants.referenceGpuRenderTarget("stencil", stencil);
  const snapshot = variants.snapshot();
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 64);
  assert.equal(snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 32,
    "the stencil target uses one D24S8 renderbuffer");
  assert.equal(snapshot.gpuRenderbuffers.uniqueResources, 1);
});

test("cube and array target subclasses derive layout from the explicit target", () => {
  const cube = new THREE.WebGLCubeRenderTarget(2);
  const array = new THREE.WebGLArrayRenderTarget(2, 2, 3, { depthBuffer: false });
  assert.equal(cube.texture.renderTarget, null,
    "the subclass replacement intentionally demonstrates why the target is passed explicitly");
  assert.equal(array.texture.renderTarget, null);
  const ledger = new ResourceAccountingLedger();

  ledger.referenceGpuRenderTarget("cube", cube);
  ledger.referenceGpuRenderTarget("array", array);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, (2 * 2 * 4 * 6) + (2 * 2 * 3 * 4));
  assert.equal(snapshot.gpuTextures.knownByteResources, 2);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
  assert.equal(snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 2 * 2 * 3 * 6);
  assert.equal(snapshot.gpuRenderbuffers.uniqueResources, 6,
    "Three allocates a separate stable depth renderbuffer for each cube face");
});

test("WebGL3D and array targets keep generated/manual color depth formulas honest", () => {
  const generated3d = new THREE.WebGL3DRenderTarget(4, 2, 3, {
    depthBuffer: false,
    generateMipmaps: true,
  });
  const manual3d = new THREE.WebGL3DRenderTarget(4, 2, 3, { depthBuffer: false });
  manual3d.texture.mipmaps = [{}, {}];
  const generatedArray = new THREE.WebGLArrayRenderTarget(4, 2, 3, {
    depthBuffer: false,
    generateMipmaps: true,
  });
  const manualArray = new THREE.WebGLArrayRenderTarget(4, 2, 3, { depthBuffer: false });
  manualArray.texture.mipmaps = [{}, {}];
  const ledger = new ResourceAccountingLedger();

  ledger.referenceGpuRenderTarget("generated-3d", generated3d);
  ledger.referenceGpuRenderTarget("manual-3d", manual3d);
  ledger.referenceGpuRenderTarget("generated-array", generatedArray);
  ledger.referenceGpuRenderTarget("manual-array", manualArray);
  const snapshot = ledger.snapshot();

  // 3D generated mips halve depth; array mips retain all layers. Manual target levels use the
  // target's declared depth for each framebuffer attachment in r185.
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 108 + 120 + 132 + 120);
  assert.equal(snapshot.gpuTextures.knownByteResources, 4);
  assert.deepEqual(snapshot.gpuRenderbuffers, emptyIdentitySection("estimatedLogicalRenderbufferBytes"));

  const depthLedger = new ResourceAccountingLedger();
  const manualArrayDepth = new THREE.WebGLArrayRenderTarget(4, 2, 3);
  manualArrayDepth.texture.mipmaps = [{}, {}];
  depthLedger.referenceGpuRenderTarget("generated-array-depth", new THREE.WebGLArrayRenderTarget(4, 2, 3));
  depthLedger.referenceGpuRenderTarget("manual-array-depth", manualArrayDepth);
  assert.equal(depthLedger.snapshot().gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 2 * 4 * 2 * 3);
});

test("MSAA keeps safe base attachments known and marks only auxiliary topology unknown", () => {
  const target = new THREE.WebGLRenderTarget(4, 2, {
    samples: 4,
    depthTexture: new THREE.DepthTexture(4, 2),
  });
  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuRenderTarget("msaa", target);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 32 + 24,
    "non-MSAA base formulas still describe color and explicit depth texture allocations");
  assert.equal(snapshot.gpuTextures.knownByteResources, 2);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 0);
  assert.equal(snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 0,
    "requested samples are not multiplied into invented allocation bytes");
  assert.equal(snapshot.gpuRenderbuffers.unknownByteResources, 0,
    "capability-unknown MSAA does not invent a renderbuffer resource");
  assert.equal(snapshot.gpuRenderTargetTopology.unknownTopologyResources, 1);
  assert.ok(snapshot.coverage.gaps.some((gap) => /multisampl|MSAA/i.test(gap)));
  assert.equal(snapshot.coverage.gaps.some((gap) => /^render targets/i.test(gap)), false);
});

test("MSAA topology uncertainty has its own immutable section, not a synthetic renderbuffer", () => {
  const target = new THREE.WebGLRenderTarget(4, 2, { samples: 4, depthBuffer: false });
  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuRenderTarget("msaa", target);
  ledger.referenceGpuRenderTarget("msaa", target);
  const snapshot = ledger.snapshot();

  assert.deepEqual(snapshot.gpuRenderbuffers, emptyIdentitySection("estimatedLogicalRenderbufferBytes"));
  assert.deepEqual(snapshot.gpuRenderTargetTopology, {
    unknownTopologyResources: 1,
    uniqueResources: 1,
    owners: 1,
    references: 1,
    sharedResources: 0,
  });
  assert.ok(Object.isFrozen(snapshot.gpuRenderTargetTopology));
  assert.equal(JSON.parse(JSON.stringify(snapshot.gpuRenderTargetTopology)).unknownTopologyResources, 1);
});

test("unsafe cube/manual and MRT/manual combinations are explicit unknowns", () => {
  const cube = new THREE.WebGLCubeRenderTarget(2);
  cube.texture.mipmaps = [{}];
  const mrt = new THREE.WebGLRenderTarget(2, 2, { count: 2, depthBuffer: false });
  mrt.texture.mipmaps = [{}];
  const ledger = new ResourceAccountingLedger();

  ledger.referenceGpuRenderTarget("cube-manual", cube);
  ledger.referenceGpuRenderTarget("mrt-manual", mrt);
  const snapshot = ledger.snapshot();

  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 0);
  assert.equal(snapshot.gpuTextures.knownByteResources, 0);
  assert.equal(snapshot.gpuTextures.unknownByteResources, 3);
  assert.equal(snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 0);
  assert.equal(snapshot.gpuRenderbuffers.unknownByteResources, 6);
  assert.ok(snapshot.coverage.gaps.some((gap) => /mixed render-target/i.test(gap)));
});

test("renderbuffer snapshots are immutable and benchmark flattening remains conditional", () => {
  const ledger = new ResourceAccountingLedger();
  ledger.referenceGpuRenderTarget("target", new THREE.WebGLRenderTarget(4, 2));
  const accounting = ledger.snapshot();

  assert.ok(Object.isFrozen(accounting.gpuRenderbuffers));
  assert.throws(() => { accounting.gpuRenderbuffers.estimatedLogicalRenderbufferBytes = 0; }, TypeError);
  const checkpoint = benchmarkResourceCheckpoint({ resources: { accounting } });
  assert.equal(checkpoint.bytes["accounting.gpuRenderbuffers.estimatedLogicalRenderbufferBytes"], 24);
  assert.equal(checkpoint.counters["accounting.gpuRenderbuffers.knownByteResources"], 1);
  assert.equal(checkpoint.counters["accounting.gpuRenderbuffers.unknownByteResources"], 0);
  assert.equal(checkpoint.counters["accounting.gpuRenderbuffers.uniqueResources"], 1);

  const msaaLedger = new ResourceAccountingLedger();
  msaaLedger.referenceGpuRenderTarget("msaa", new THREE.WebGLRenderTarget(4, 2, { samples: 4 }));
  const msaaAccounting = msaaLedger.snapshot();
  assert.ok(Object.isFrozen(msaaAccounting.gpuRenderTargetTopology));
  assert.throws(() => {
    msaaAccounting.gpuRenderTargetTopology.unknownTopologyResources = 0;
  }, TypeError);
  const msaaCheckpoint = benchmarkResourceCheckpoint({ resources: { accounting: msaaAccounting } });
  assert.equal(msaaCheckpoint.bytes["accounting.gpuRenderTargetTopology.unknownTopologyResources"], undefined,
    "topology uncertainty is a counter, never a byte estimate");
  assert.equal(msaaCheckpoint.counters["accounting.gpuRenderTargetTopology.unknownTopologyResources"], 1);
  assert.equal(msaaCheckpoint.counters["accounting.gpuRenderTargetTopology.uniqueResources"], 1);
  assert.equal(msaaCheckpoint.counters["accounting.gpuRenderTargetTopology.owners"], 1);
  assert.equal(msaaCheckpoint.counters["accounting.gpuRenderTargetTopology.references"], 1);
  assert.equal(msaaCheckpoint.counters["accounting.gpuRenderTargetTopology.sharedResources"], 0);
});

function portraitCanvas(width, height) {
  const value = { width, height, dataset: {} };
  const context = {
    createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    clearRect() {},
  };
  value.getContext = () => context;
  return value;
}

function portraitRenderer() {
  const state = {
    target: null,
    viewport: new THREE.Vector4(),
    scissor: new THREE.Vector4(),
    scissorTest: false,
    clear: new THREE.Color(),
    alpha: 1,
    autoClear: true,
  };
  return {
    getRenderTarget: () => state.target,
    setRenderTarget(value) { state.target = value; },
    getViewport: (value) => value.copy(state.viewport),
    setViewport(value, y, width, height) {
      if (value?.isVector4) state.viewport.copy(value);
      else state.viewport.set(value, y, width, height);
    },
    getScissor: (value) => value.copy(state.scissor),
    setScissor(value, y, width, height) {
      if (value?.isVector4) state.scissor.copy(value);
      else state.scissor.set(value, y, width, height);
    },
    getScissorTest: () => state.scissorTest,
    setScissorTest(value) { state.scissorTest = value; },
    getClearColor: (value) => value.copy(state.clear),
    setClearColor(value, alpha) { state.clear.copy(value); state.alpha = alpha; },
    getClearAlpha: () => state.alpha,
    clear() {},
    render() {},
    readRenderTargetPixels(_target, _x, _y, _width, _height, pixels) { pixels.fill(0); },
    get autoClear() { return state.autoClear; },
    set autoClear(value) { state.autoClear = value; },
  };
}

function portraitSource() {
  return {
    key: "empty",
    model: {
      bounds: { min: [-1, -1, -1], max: [1, 1, 1], radius: 1 },
      attachments: [],
      portraitCamera: {
        fov: Math.PI / 4,
        near: 0.1,
        far: 10,
        position: [2, 0, 0],
        target: [0, 0, 0],
      },
    },
    built: {
      geometry: new THREE.BufferGeometry(),
      materials: [new THREE.MeshBasicMaterial()],
      height: 2,
      texturePaths: [],
      ownedTextures: [],
    },
    scale: 1,
  };
}

test("portrait accounting follows public render, resize, and clear behavior", () => {
  const output = portraitCanvas(4, 2);
  const portraits = new PortraitRenderer(portraitRenderer(), () => portraitSource());
  portraits.setTargets(new Map([["player", { guid: 1n, canvas: output }]]));
  assert.equal(portraits.render(0), 1);

  let ledger = new ResourceAccountingLedger();
  portraits.visitRetainedResources(ledger);
  let snapshot = ledger.snapshot();
  assert.equal(snapshot.cpu.uniqueRetainedBytes, 8 * 4 * 2,
    "pixels and flipped arrays are separate exact CPU allocations");
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes, 4 * 4 * 2);
  assert.equal(snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 3 * 4 * 2);
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes
    + snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 7 * 4 * 2);
  assert.equal(snapshot.unsupported.uniqueResources, 1, "the canvas storage remains browser-owned");

  output.width = 8;
  output.height = 3;
  assert.equal(portraits.render(1), 1);
  ledger = new ResourceAccountingLedger();
  portraits.visitRetainedResources(ledger);
  snapshot = ledger.snapshot();
  assert.equal(snapshot.cpu.uniqueRetainedBytes, 8 * 8 * 3);
  assert.equal(snapshot.gpuTextures.estimatedLogicalTextureBytes
    + snapshot.gpuRenderbuffers.estimatedLogicalRenderbufferBytes, 7 * 8 * 3);

  portraits.clear();
  ledger = new ResourceAccountingLedger();
  portraits.visitRetainedResources(ledger);
  snapshot = ledger.snapshot();
  assert.equal(snapshot.cpu.uniqueRetainedBytes, 0);
  assert.equal(snapshot.gpuTextures.uniqueResources, 0);
  assert.equal(snapshot.gpuRenderbuffers.uniqueResources, 0);
  assert.equal(snapshot.unsupported.uniqueResources, 0);
});
