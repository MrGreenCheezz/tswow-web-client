import assert from "node:assert/strict";
import test from "node:test";
import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import * as THREE from "three";
import {TERRAIN_GRID_SIZE} from "../dist/code/browser/Terrain.js";
import {rendererMethods, streamingHarness, waterFixture} from "./terrain-streaming-harness.mjs";

const source=await readFile(new URL("../src/browser/WorldRenderer3D.ts",import.meta.url),"utf8");
const position=(gx,fraction=0.5)=>({x:(32-gx-fraction)*TERRAIN_GRID_SIZE,y:-0.5*TERRAIN_GRID_SIZE,z:0,orientation:0});
function cpuClient() {
  return {stats:{active:0}, pins:[], version:1,
    setActiveTiles(map,grids){this.pins=[...grids];},
    tileRevision(){return this.version*9;},ownRevision(){return this.version;},
    heightAt(){return 1;},isHole(){return false;},isReady(){return true;},
  };
}
function run(renderer,cpu,player,frames=1,splat) {
  for(let frame=0;frame<frames;frame++)renderer.updateTerrain(player,0,()=>1,cpu,splat);
}

test("prepared row becomes visible without foreground builds and returning reuses allocations", () => {
  const renderer=streamingHarness(source), cpu=cpuClient();
  run(renderer,cpu,position(32,0.9),25);
  assert.equal(renderer.builds,9);
  assert.equal(renderer.terrains.size,12);
  const prepared=renderer.terrains.get("0/34/32");
  const previous=renderer.terrains.get("0/31/32");
  assert.ok(prepared);
  assert.equal(prepared.mesh.visible,false);
  assert.equal(prepared.water[0].visible,false);
  run(renderer,cpu,position(33,0.02),1);
  assert.equal(renderer.builds,9,"crossing no longer constructs a fresh foreground row");
  assert.equal(prepared.mesh.visible,true);
  assert.equal(prepared.water[0].visible,true);
  assert.equal(previous.mesh.visible,false);
  run(renderer,cpu,position(32,0.9),1);
  assert.equal(renderer.builds,9);
  assert.equal(renderer.terrains.get("0/31/32"),previous);
  assert.equal(previous.mesh.visible,true);
  assert.equal(prepared.mesh.visible,false);
  renderer.clearTerrain();
  assert.equal(renderer.terrains.size,0);
  assert.equal(renderer.scene.children.length,0);
});

test("revision changes cancel partial geometry before it can install stale samples", () => {
  const renderer=streamingHarness(source,{steps:200}),cpu=cpuClient();
  run(renderer,cpu,position(32,0.9),10);
  const pending=renderer.terrainPreparation;
  assert.ok(pending);
  cpu.version++;
  // Each visible repair now completes independently before speculative work resumes.
  run(renderer,cpu,position(32,0.9),12);
  assert.equal(renderer.cancelled,1);
  assert.notEqual(renderer.terrainPreparation,pending);
  assert.equal(renderer.terrainPreparation.revision,18);
  run(renderer,cpu,position(32),1);
  assert.equal(renderer.terrainPreparation,undefined);
  assert.equal(renderer.cancelled,2);
  renderer.clearTerrain();
});

test("visible repairs suppress speculative steps; formal capture cancels and removes hidden terrain", () => {
  // Test cancellation of started work, independent of OS scheduling exhausting the 1.5 ms budget.
  const renderer=streamingHarness(source,{steps:200,clock:{now:()=>0}}),cpu=cpuClient();
  run(renderer,cpu,position(32,0.9),9);
  assert.equal(renderer.terrainPreparation,undefined,"every foreground build owns its frame");
  run(renderer,cpu,position(32,0.9),1);
  assert.ok(renderer.terrainPreparation);
  renderer.formalBenchmarkIsolation=true;
  run(renderer,cpu,position(32,0.9),1);
  assert.equal(renderer.terrainPreparation,undefined);
  assert.equal(renderer.cancelled,1);
  assert.equal(renderer.terrainPlan.retained.length,9);
  renderer.clearTerrain();
});

test("background CPU requests stay bounded and absent tiles never build speculative flat ground", () => {
  const renderer=streamingHarness(source),cpu=cpuClient();
  run(renderer,cpu,position(32),10);
  let requests=0;
  cpu.ownRevision=(_map,grid)=>grid.x>33?0:1;
  cpu.isReady=(_map,x,y)=>{requests++;cpu.stats.active++;return false;};
  run(renderer,cpu,position(32,0.9),6);
  assert.equal(requests,2);
  assert.equal(renderer.terrainPreparation,undefined);
  cpu.ownRevision=()=>1;
  cpu.stats.active=0;
  cpu.heightAt=()=>undefined;
  let splatRequests=0;
  const splat={stats:{active:0},setActiveTiles(){},get(){splatRequests++;}};
  run(renderer,cpu,position(32,0.9),6,splat);
  assert.equal(splatRequests,0,"absent ground never requests speculative splat metadata");
  assert.equal(renderer.terrainPreparation,undefined);
  assert.equal(renderer.terrains.size,9);
  renderer.clearTerrain();
});

const WaterHarness=rendererMethods(source,["#waterGeometry","#waterGeometrySteps"]);
function waterHash(surfaces) {
  const hash=createHash("sha256");
  for(const [kind,geometry] of surfaces) {
    hash.update(kind);
    for(const name of ["position","normal","uv","liquidDepth"])hash.update(Buffer.from(geometry.getAttribute(name).array.buffer));
    hash.update(Buffer.from(geometry.index.array.buffer));
  }
  return hash.digest("hex");
}

test("stepped shorelines, UVs, depths and normals match the pre-refactor water buffers", () => {
  const renderer=new WaterHarness();
  let groundCalls=0,liquidCalls=0,maxGround=0,maxLiquid=0,steps=0;
  const work=renderer.waterGeometrySteps(0,waterFixture.grid,(x,y)=>{groundCalls++;return waterFixture.ground(x,y);},
    {liquidAt(...args){liquidCalls++;return waterFixture.client.liquidAt(...args);}});
  let result;
  do {
    groundCalls=0;liquidCalls=0;
    result=work.next();steps++;
    maxGround=Math.max(maxGround,groundCalls);maxLiquid=Math.max(maxLiquid,liquidCalls);
  } while(!result.done);
  assert.ok(steps>=35,"water cells yield in bounded row groups");
  assert.ok(maxGround<=1500);assert.ok(maxLiquid<=800);
  assert.equal(waterHash(result.value),"9b6687fd4823488a54f0216259d53e460f897ebe9ea60ae6691ab7e325ed73c0");
  for(const geometry of result.value.values())geometry.dispose();
});

test("cancelling water preparation disposes completed intermediate surfaces once", () => {
  const renderer=new WaterHarness();
  const work=renderer.waterGeometrySteps(0,waterFixture.grid,waterFixture.ground,waterFixture.client);
  const original=THREE.BufferGeometry.prototype.dispose;
  const disposed=[];
  THREE.BufferGeometry.prototype.dispose=function(){disposed.push(this);original.call(this);};
  try {
    // 32 row groups, yield before the first class, then first allocation and next class yield.
    for(let step=0;step<34;step++)assert.equal(work.next().done,false);
    assert.equal(disposed.length,0);
    work.return();
    assert.equal(disposed.length,1);
    work.return();
    assert.equal(disposed.length,1);
  } finally {THREE.BufferGeometry.prototype.dispose=original;}
});


test("finishing geometry cannot start a second speculative splat request in the same frame", () => {
  const renderer=streamingHarness(source,{steps:12}),cpu=cpuClient();
  const player=position(32,0.9);
  run(renderer,cpu,player,25);
  const key="0/34/31";
  assert.ok(renderer.terrains.has(key));
  renderer.removeTerrain(key,renderer.terrains.get(key));
  run(renderer,cpu,player,1);
  assert.equal(renderer.terrainPreparation.key,key);
  for(const rendered of renderer.terrains.values()) rendered.splatted=rendered.mesh.visible;
  const requested=[];
  const splat={stats:{active:0},setActiveTiles(){},get(_map,grid){this.stats.active++;requested.push(grid);}};
  renderer.updateTerrainSplat=(_map,grid,rendered,client)=>{
    if(!rendered.splatted&&client)client.get(0,grid);
  };
  run(renderer,cpu,player,1,splat);
  assert.equal(renderer.terrainPreparation,undefined);
  assert.ok(renderer.terrains.has(key));
  assert.equal(requested.length,1,"job completion shares the same per-frame request allowance");
  renderer.clearTerrain();
});
