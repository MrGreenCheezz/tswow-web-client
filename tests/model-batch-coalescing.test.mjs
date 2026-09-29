import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { buildModel, cloneMaterialFaded, geosetList, updateBatchAppearance } from '../dist/code/browser/ModelBuild.js';
import { clonePortraitMaterials } from '../dist/code/browser/PortraitRenderer.js';
import { BLEND_ALPHA, MATERIAL_TWO_SIDED, MATERIAL_NO_DEPTH_WRITE, MATERIAL_NO_DEPTH_TEST } from '../dist/code/browser/Wvm.js';

const batch = (submesh, changes = {}) => ({ submesh, blendMode: 0, materialFlags: 0,
  priorityPlane: 0, materialLayer: 0, textures: [0], uvSets: [0], shaderId: 0,
  colorIndex: 65535, textureWeight: -1, textureTransform: -1, ...changes });

function model(IndexArray = Uint16Array) {
  return {
    positions: Float32Array.from({length:54}, (_, index) => index / 10),
    normals: new Float32Array(54), uv0: new Float32Array(36), uv1: new Float32Array(36),
    boneIndices: new Uint8Array(72), boneWeights: Float32Array.from({length:72}, (_, index) => index % 4 === 0 ? 1 : 0),
    indices: IndexArray.from({length:18}, (_, index) => index),
    submeshes: Array.from({length:6}, (_, index) => ({geosetId: index === 3 ? 100 : 0, indexStart:index*3,indexCount:3})),
    // Includes a repeated draw of submesh 0 and selected ranges separated by a hidden geoset.
    batches: [batch(0),batch(1),batch(2,{textures:[1]}),batch(0),batch(4),batch(5),batch(3)],
    textures: [{type:0,flags:0,path:'Body.blp'},{type:0,flags:0,path:'Hair.blp'}],
    attachments: [], bounds:{min:[0,0,0],max:[1,1,2],radius:2},
    colours:[],textureWeights:[],textureTransforms:[],globalSequences:new Uint32Array(),
  };
}

function build(source, coalesceAdjacentBatches) {
  let textureLoads = 0;
  const built = buildModel(source, {modelPath:'Character/Test.m2',baseUrl:'http://test',skinned:true,
    geosets:geosetList([0]),coalesceAdjacentBatches,
    loadTexture(url) { textureLoads++; const texture=new THREE.Texture(); texture.name=url; return texture; }});
  return {built, textureLoads};
}

function materialState(material) {
  return { map:material.map?.name, channel:material.map?.channel, matrix:material.map?.matrix.elements,
    alphaMap:material.alphaMap?.name, color:material.color.toArray(), opacity:material.opacity,
    visible:material.visible,transparent:material.transparent,blending:material.blending,
    side:material.side,depthTest:material.depthTest,depthWrite:material.depthWrite,fog:material.fog,
    alphaTest:material.alphaTest,program:material.customProgramCacheKey() };
}

/** Each material state's triangle stream in draw order, states ordered by their first index. */
function submittedByState(built) {
  const states = new Map();
  for (const entry of submitted(built)) {
    const key = JSON.stringify(entry.material);
    if (!states.has(key)) states.set(key, []);
    states.get(key).push(entry.index);
  }
  return [...states.entries()].sort((a, b) => a[1][0] - b[1][0]);
}

function submitted(built) {
  return built.geometry.groups.flatMap(group => Array.from(
    built.geometry.index.array.subarray(group.start,group.start+group.count),
    index => ({ index,material:materialState(built.materials[group.materialIndex]) })));
}

for (const IndexArray of [Uint16Array,Uint32Array]) {
  test(`coalescing ${IndexArray.name} passes preserves every ordered triangle, repeated draw and vertex attribute`, () => {
    const source=model(IndexArray), original=source.indices.slice();
    const before=build(source,false),after=build(source,true);
    assert.equal(before.built.geometry.groups.length,6);
    // Two states: every body-atlas pass joins the first one, wherever it was authored.
    assert.equal(after.built.geometry.groups.length,2);
    assert.equal(after.textureLoads,2);
    assert.equal(before.textureLoads,6);
    assert.deepEqual(submittedByState(after.built),submittedByState(before.built),
      'every state keeps its own triangles in authored order');
    assert.deepEqual(after.built.geometry.groups.map(group => after.built.materials[group.materialIndex].map.name),
      ['http://test/texture?path=Body.blp', 'http://test/texture?path=Hair.blp'], 'a joined state sits where its first pass was');
    assert.deepEqual(source.indices,original,'shared decoded indices remain immutable');
    assert.ok(after.built.geometry.index.array instanceof IndexArray);
    for (const name of ['position','normal','uv','uv1','skinIndex','skinWeight']) {
      assert.strictEqual(after.built.geometry.getAttribute(name).array,before.built.geometry.getAttribute(name).array);
    }
    assert.deepEqual(after.built.materialSlots,[0,0]);
    assert.deepEqual(after.built.texturePaths,before.built.texturePaths);
    assert.equal(after.built.geometry.index.count,18,'hidden geometry excluded; repeated visible draw retained');
  });
}

test('different authored states and order-dependent passes remain separate', () => {
  const changes=[{blendMode:1},{materialFlags:1},{priorityPlane:1},{materialLayer:1},
    {textures:[1]},{textures:[0,1]},{uvSets:[1]},{shaderId:1},{colorIndex:0},
    {textureWeight:0},{textureTransform:0}];
  for (const difference of changes) {
    const source=model(); source.batches=[batch(0),batch(1,difference)];
    const {built}=build(source,true);
    assert.equal(built.geometry.groups.length,2,JSON.stringify(difference));
    assert.strictEqual(built.geometry.index.array,source.indices,'no merge needs no new index buffer');
  }
  for (const changes of [{blendMode:BLEND_ALPHA},{materialFlags:MATERIAL_TWO_SIDED},
    {materialFlags:MATERIAL_NO_DEPTH_WRITE},{materialFlags:MATERIAL_NO_DEPTH_TEST},{uvSets:[1]}]) {
    const source=model(); source.batches=[batch(0,changes),batch(1,changes)];
    assert.equal(build(source,true).built.geometry.groups.length,2,JSON.stringify(changes));
  }
});

function track(components, from, to) {
  return {interpolation:1,globalSequence:0,components,
    tracks:[{sequence:0,times:new Uint32Array([0,1000]),values:Float32Array.from([...from,...to])}]};
}

test('joined passes retain their shared animated tint, alpha and texture transform clocks', () => {
  const source=model();source.globalSequences=new Uint32Array([1000]);
  source.colours=[{rgb:track(3,[1,0,0],[0,1,0]),alpha:track(1,[1],[0.5])}];
  source.textureWeights=[track(1,[1],[0.5])];
  source.textureTransforms=[{translation:track(3,[0,0,0],[1,0,0]),
    rotation:track(4,[0,0,0,1],[0,0,0,1]),scaling:track(3,[1,1,1],[2,1,1])}];
  source.batches=[batch(0,{colorIndex:0,textureWeight:0,textureTransform:0}),
    batch(1,{colorIndex:0,textureWeight:0,textureTransform:0})];
  const before=build(source,false).built,after=build(source,true).built;
  assert.equal(after.animatedBatches.length,1);
  assert.equal(after.materials.length,1);
  assert.strictEqual(after.animatedBatches[0].material,after.materials[0]);
  for (const worldMs of [0,250,750,1100]) {
    updateBatchAppearance(before.animatedBatches,0,worldMs);
    updateBatchAppearance(after.animatedBatches,0,worldMs);
    assert.deepEqual(submitted(after),submitted(before));
  }
});

test('spawn fades and portrait material copies preserve coalesced geometry group assignments', () => {
  const source=model(),before=build(source,false).built,after=build(source,true).built;
  for (const factor of [0,0.25,1]) {
    const faded = built => ({...built,materials:built.materials.map(material => cloneMaterialFaded(material,factor))});
    assert.deepEqual(submittedByState(faded(after)),submittedByState(faded(before)));
  }
  const portrait = built => ({...built,materials:clonePortraitMaterials(built.materials)});
  assert.deepEqual(submittedByState(portrait(after)),submittedByState(portrait(before)));
});

test('passes of one state join their first pass; blended, two-sided and depth-independent passes keep their place', () => {
  const source=model();
  // A, blended, A, B, A: the two later A passes join the first, the blended pass keeps its
  // position between the A group and B, and the triangles inside A stay in authored order.
  source.batches=[batch(0),batch(1,{blendMode:BLEND_ALPHA}),batch(2),batch(4,{textures:[1]}),batch(5)];
  const {built}=build(source,true);
  const groups=built.geometry.groups.map(group => ({
    map:built.materials[group.materialIndex].map.name, transparent:built.materials[group.materialIndex].transparent,
    indices:Array.from(built.geometry.index.array.subarray(group.start,group.start+group.count)),
  }));
  assert.deepEqual(groups,[
    {map:'http://test/texture?path=Body.blp',transparent:false,indices:[0,1,2,6,7,8,15,16,17]},
    {map:'http://test/texture?path=Body.blp',transparent:true,indices:[3,4,5]},
    {map:'http://test/texture?path=Hair.blp',transparent:false,indices:[12,13,14]},
  ]);
  // Two-sided and depth-independent passes are never gathered, even when equal to each other.
  for (const flags of [MATERIAL_TWO_SIDED, MATERIAL_NO_DEPTH_WRITE, MATERIAL_NO_DEPTH_TEST]) {
    const pinned=model(); pinned.batches=[batch(0,{materialFlags:flags}),batch(1),batch(2,{materialFlags:flags})];
    assert.equal(build(pinned,true).built.geometry.groups.length,3,String(flags));
  }
  // The unit path opts in; a plain scenery build keeps the authored draw stream.
  const plain=model(); plain.batches=[batch(0),batch(1,{textures:[1]}),batch(2)];
  assert.equal(build(plain,false).built.geometry.groups.length,3);
});
