import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { UnitSceneGroup } from '../dist/code/browser/UnitSceneGroup.js';
import { buildSkinnedTemplateFrom, instantiateSkinned } from '../dist/code/browser/AnimatedModel.js';

function setup(Group = THREE.Group) {
  const skeleton={parents:Int16Array.from([-1,0,1,2]),flags:new Uint16Array(4),
    pivots:Float32Array.from([0,0,0,0,0,1,0,0,2,1,0,2]),globalChannels:[],animations:[0],
    clips:[{animationId:0,duration:1,channels:[{bone:2,kind:0,times:Float32Array.from([0,1]),
      values:Float32Array.from([0,0,0,1,0,0])}]}]};
  const template=buildSkinnedTemplateFrom(new THREE.BufferGeometry(),skeleton,2);
  const rig=instantiateSkinned(template,new THREE.MeshBasicMaterial());
  rig.mixer.clipAction(template.clips.get(0)).play();
  const scene=new THREE.Scene(),outer=new THREE.Group(),unit=new Group();
  scene.add(outer);outer.add(unit);unit.add(rig.root);
  return {scene,outer,unit,rig};
}

function samePose(a,b) {
  a.rig.skeleton.update();b.rig.skeleton.update();
  assert.deepEqual(a.rig.skeleton.boneMatrices,b.rig.skeleton.boneMatrices);
  for (let index=0;index<a.rig.skeleton.bones.length;index++) {
    assert.deepEqual(a.rig.skeleton.bones[index].matrixWorld.elements,b.rig.skeleton.bones[index].matrixWorld.elements);
  }
}

test('renderer traversal skips hidden retained bones and resumes the full current pose on visibility',()=>{
  const current=setup(UnitSceneGroup),reference=setup();
  let boneVisits=0;
  for(const bone of current.rig.skeleton.bones){
    const update=bone.updateMatrixWorld;
    bone.updateMatrixWorld=function(force){boneVisits++;update.call(this,force);};
  }
  for(let frame=0;frame<12;frame++){
    for(const state of [current,reference]){
      state.unit.visible=frame<2||frame>=9;
      state.outer.position.set(frame,2,-frame);
      state.outer.rotation.y=frame/5;
      state.outer.scale.set(1,1+frame/10,2);
      state.unit.position.set(frame/10,0,0);
      state.rig.mixer.update(1/60);
      if(frame===5)state.scene.add(state.unit);
      if(frame===7)state.outer.add(state.unit);
    }
    const previous=boneVisits;
    current.scene.updateMatrixWorld(true);reference.scene.updateMatrixWorld(true);
    if(current.unit.visible){assert.equal(boneVisits-previous,4);samePose(current,reference);}
    else assert.equal(boneVisits,previous,'hidden rig is retained without walking bones');
  }
});

test('explicit world-matrix queries still refresh hidden attachments and complete portrait poses',()=>{
  const current=setup(UnitSceneGroup),reference=setup();
  for(const state of [current,reference]){
    state.scene.updateMatrixWorld(true);state.unit.visible=false;
    state.outer.position.set(5,2,3);state.outer.rotation.y=0.8;
    state.unit.position.set(2,0,0);state.rig.mixer.update(0.5);
  }
  const point=state=>state.rig.skeleton.bones[3].getWorldPosition(new THREE.Vector3());
  assert.deepEqual(point(current),point(reference));
  current.unit.updateWorldMatrix(true,true);reference.unit.updateWorldMatrix(true,true);
  samePose(current,reference);
  current.unit.visible=true;reference.unit.visible=true;
  current.scene.updateMatrixWorld();reference.scene.updateMatrixWorld();
  samePose(current,reference);
});
