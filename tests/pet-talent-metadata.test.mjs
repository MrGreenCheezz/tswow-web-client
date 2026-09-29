import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTalentData} from '../dist/code/gateway/TalentMetadata.js';
import {openDbcFile} from '../dist/code/gateway/Dbc.js';
import {DBC_LAYOUTS} from '../dist/code/generated/dbcLayouts.js';
import {TalentClient} from '../dist/code/browser/TalentClient.js';
import {dbcDirectory} from '../tools/paths.mjs';

test('signed pet types include zero and exclude negative or unrepresentable masks', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pet-talent-masks-'));
  try {
    for(const name of ['Talent','TalentTab','SkillLine','SkillLineCategory','SkillLineAbility','CreatureFamily','SpellIcon']) {
      const layout=DBC_LAYOUTS[name];
      const rows=name==='CreatureFamily'?[{ID:1,PetTalentType:0},{ID:2,PetTalentType:1},{ID:3,PetTalentType:2},
        {ID:4,PetTalentType:-1},{ID:5,PetTalentType:31},{ID:6,PetTalentType:32}]:name==='TalentTab'?
        [{ID:1,CategoryEnumID:1},{ID:2,CategoryEnumID:2},{ID:3,CategoryEnumID:4}]:[];
      const bytes=Buffer.alloc(20+rows.length*layout.recordSize+1);bytes.write('WDBC');
      bytes.writeUInt32LE(rows.length,4);bytes.writeUInt32LE(layout.fieldCount,8);bytes.writeUInt32LE(layout.recordSize,12);bytes.writeUInt32LE(1,16);
      rows.forEach((row,index)=>Object.entries(row).forEach(([key,value])=>bytes.writeInt32LE(value,20+index*layout.recordSize+layout.fields[key].byteOffset)));
      await writeFile(join(directory,name+'.dbc'),bytes);
    }
    const data=await loadTalentData(directory);
    assert.deepEqual(data.petFamilyMasks,{1:1,2:2,3:4,5:2147483648});
    assert.deepEqual(data.petFamilies,{2:1,3:2,5:31,6:32},'Legacy response remains unchanged');
    assert.deepEqual(data.tabs.map(tab=>tab.petTalentMask),[1,2,4]);
    const originalFetch=globalThis.fetch;
    try {
      globalThis.fetch=async()=>({ok:true,json:async()=>data});
      const client=new TalentClient('ws://127.0.0.1:8090');
      const ready=new Promise((resolve,reject)=>{
        client.onLoaded=resolve;
        client.onStatus=(message,error)=>error&&reject(new Error(message));
      });
      client.load();
      await ready;
      assert.equal(client.petTalentMask(1),1,'PetTalentType zero is a valid tree mask');
      assert.deepEqual(client.petTabs(client.petTalentMask(1)).map(tab=>tab.id),[1]);
      assert.deepEqual(client.petTabs(client.petTalentMask(2)).map(tab=>tab.id),[2]);
      assert.deepEqual(client.petTabs(client.petTalentMask(3)).map(tab=>tab.id),[3]);
      assert.equal(client.petTalentMask(4),0,'a family without a usable type has no tree');
      assert.deepEqual(client.petTabs(client.petTalentMask(4)),[]);
      assert.equal(client.petTalentMask(5),2**31,'the highest supported mask bit stays unsigned');
    } finally {globalThis.fetch=originalFetch;}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('every dataset family mask and tab follows the core DBC relation',async()=>{
  const directory=dbcDirectory();const data=await loadTalentData(directory);
  const families=await openDbcFile(directory,'CreatureFamily');let eligible=0;
  for(const row of families.rows()) {
    const type=families.int(row,'PetTalentType'),id=families.id(row);
    if(type>=0&&type<32){assert.equal(data.petFamilyMasks[id],2**type);eligible++;}
    else assert.equal(data.petFamilyMasks[id],undefined);
  }
  assert.equal(Object.keys(data.petFamilyMasks).length,eligible);
  assert.equal(data.petFamilyMasks[1],1,'Wolf is type zero');assert.equal(data.petFamilyMasks[2],1,'Cat is type zero');
  assert.ok(data.tabs.some(tab=>tab.classMask===0&&tab.petTalentMask===1));
  for(const tab of data.tabs)assert.equal(tab.petTalentMask,tab.petCategory>>>0);
});
