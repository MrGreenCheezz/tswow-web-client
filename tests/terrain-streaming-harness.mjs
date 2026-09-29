import ts from "typescript";
import * as THREE from "three";
import { terrainGrid, TERRAIN_GRID_SIZE } from "../dist/code/browser/Terrain.js";
import { TerrainStreamingWindow, terrainTileKey } from "../dist/code/browser/TerrainStreaming.js";
import { terrainGeometrySteps } from "../dist/code/browser/TerrainGeometry.js";
import { waterCornerHeight, shouldRefreshWaterForNeighbour } from "../dist/code/browser/WorldRenderer3D.js";
import { LIQUID_CELL_YARDS, liquidCalmOf, liquidClassOf } from "../dist/code/browser/Water.js";

/** Execute the actual private methods without constructing a browser/WebGL renderer. */
export function rendererMethods(source, names, clock = performance) {
  const parsed = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.ES2022, true);
  const renderer = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "WorldRenderer3D");
  if (!renderer) throw new Error("renderer class missing");
  const members = names.map(name => {
    const node = renderer.members.find(member => member.name?.getText(parsed) === name);
    if (!node) throw new Error("method missing: " + name);
    return node.getText(parsed).replaceAll("#", "");
  });
  const js = ts.transpileModule("class Harness { " + members.join("\n") + " }", {
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None},
  }).outputText;
  return Function("THREE", "TERRAIN_GRID_SIZE", "terrainGrid", "terrainTileKey", "TERRAIN_SUBDIVISIONS",
    "LIQUID_CELL_YARDS", "DEEP_WATER_YARDS", "liquidClassOf", "waterCornerHeight",
    "TERRAIN_BUILD_BUDGET", "TERRAIN_REBUILD_BUDGET", "TERRAIN_PREPARE_MS", "TERRAIN_PREPARE_STEPS",
    "buildTerrainMaterial", "shouldRefreshWaterForNeighbour", "performance", "TERRAIN_REPAIR_STEPS", "terrainGeometrySteps", "liquidCalmOf", js + "; return Harness;")(
      THREE, TERRAIN_GRID_SIZE, terrainGrid, terrainTileKey, 128, LIQUID_CELL_YARDS, 10,
      liquidClassOf, waterCornerHeight, 1, 2, 1.5, 12, () => new THREE.MeshLambertMaterial(), shouldRefreshWaterForNeighbour, clock, 128, terrainGeometrySteps, liquidCalmOf);
}

export function streamingHarness(source, options = {}) {
  const Harness = rendererMethods(source, ["#updateTerrain", "#prepareTerrain", "#cancelTerrainPreparation", "#removeTerrain", "clearTerrain",
    "#advanceTerrainRepair", "#cancelTerrainRepair", "#commitTerrainRepair"], options.clock);
  const instance = new Harness();
  Object.assign(instance, {
    terrainWindow:new TerrainStreamingWindow(), terrains:new Map(), formalBenchmarkIsolation:false,
    scene:new THREE.Scene(), lightingProfile:{shadowMapSize:0},
    programWarmup:{registerObject(){},unregisterObject(){}}, renderer:{initTexture(){}},
    builds:0, rebuilt:0, cancelled:0, repairCancelled:0, repairAdvances:0,
    buildTerrain(key, _map, _grid, revision, ownRevision) {
      this.builds++;
      const material = new THREE.MeshLambertMaterial();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
      this.terrains.set(key, {mesh,material,revision,ownRevision,liquidGeneration:0,splatted:false});
      this.scene.add(mesh);
    },
    updateTerrainSplat(){},
    rebuildTerrainGeometry(){this.rebuilt++;}, replaceWater(){},
    installWater(rendered) {
      rendered.water = [new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial())];
      rendered.water[0].visible = rendered.mesh.visible;
      this.scene.add(rendered.water[0]);
    },
    terrainGeometryFromData(){return new THREE.BufferGeometry();},
    *repairTerrainSteps(_map, _grid, _player, _heightAt, _client, geometry, water) {
      let completed=false;
      try {
        for(let step=0;step<(options.repairSteps ?? 2);step++){this.repairAdvances++;yield;}
        completed=true;
        return {...geometry?{data:{}}:{},...water?{water:new Map()}:{}};
      } finally { if(!completed)this.repairCancelled++; }
    },
    *prepareTerrainSteps() {
      let completed=false;
      try {
        for(let step=0;step<(options.steps ?? 2);step++)yield;
        completed=true;
        return {data:{},water:new Map()};
      } finally { if(!completed)this.cancelled++; }
    },
  });
  return instance;
}

export const waterFixture = {
  grid:{x:32,y:32},
  ground:(x,y)=>-4 + 0.003*x - 0.005*y,
  client:{ liquidAt(_map,x,y) {
    const row=Math.floor(-x/LIQUID_CELL_YARDS), column=Math.floor(-y/LIQUID_CELL_YARDS);
    if((row+column)%7===0)return undefined;
    return {height:8+0.002*x+0.001*y,type:row<40?1:row<80?4:8,entry:0,cells:true};
  }},
};
