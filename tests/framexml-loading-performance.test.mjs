import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameXmlBoot } from '../dist/code/browser/framexml/FrameXmlBoot.js';
import { createFixtureProvider } from '../dist/code/browser/glue/GlueLoader.js';
import { GlueLoadScheduler } from '../dist/code/browser/glue/GlueLoadScheduler.js';
import { frameXmlStubPlan, frameXmlStubPlanAsync, stripLuaText } from '../dist/code/browser/framexml/FrameXmlStubPlan.js';

const prefix='interface/framexml/';

test('first-touch diagnostics retain the caller line without constructing a Lua traceback', async () => {
  const boot=new FrameXmlBoot({exercise:false,provider:createFixtureProvider({
    [prefix+'framexml.toc']:'Probe.lua\nProbe.xml',
    [prefix+'probe.lua']:[
      'debug.traceback = function() error("expensive traceback was invoked") end',
      'FirstTouchProbe()',
      'FirstTouchProbe()',
    ].join('\n'),
    [prefix+'probe.xml']:'<Ui><Frame name="Probe"><Scripts><OnLoad>self:UnknownWidgetProbe()</OnLoad></Scripts></Frame></Ui>',
  })});
  try {
    const inventory=await boot.load();
    assert.equal(boot.errorCount,0);
    const api=inventory.api;
    const entry=api.find(entry=>entry.name==='FirstTouchProbe');
    assert.equal(entry.calls,2);
    assert.equal(entry.firstTouch,prefix+'probe.lua:2');
    assert.ok(inventory.methods.find(entry=>entry.name==='Frame:UnknownWidgetProbe')?.firstTouch.includes('Probe:OnLoad'));
  } finally { boot.close(); }
});

test('span-based Lua scan ignores strings, comments, escapes and long brackets', () => {
  const source='Keep() -- Hidden()\nlocal a = "escaped \\\" Hidden()"\n--[==[ Hidden() ]==]\nlocal b = [=[ Hidden() ]=]\nLast()';
  const stripped=stripLuaText(source);
  assert.ok(stripped.includes('Keep()'));
  assert.ok(stripped.includes('Last()'));
  assert.ok(!stripped.includes('Hidden'));
  assert.equal(stripLuaText('x=[[]] Next()'), 'x="" Next()');
});

test('large catalogues keep indexed exports and per-file locals in both scan modes', async () => {
  const chunks=[{file:'catalog.lua',source:[
    ...Array.from({length:4000},(_,index)=>`local Item${index} = "Recipe${index}"`),
    'local LIBRARY_MAJOR = "LibraryApi"',
    '_G[LIBRARY_MAJOR] = {}',
    'local SETTER_NAME = "SetterApi"',
    'setglobal(SETTER_NAME, {})',
    '_G["LiteralApi"] = {}',
    'local function PrivateOnly() end',
    'PrivateOnly(); HostApi()',
  ].join('\n')},{file:'consumer.lua',source:'LibraryApi(); SetterApi(); LiteralApi(); PrivateOnly(); HostApi()'}];
  const sync=frameXmlStubPlan(chunks);
  let boundaries=0;
  const asyncPlan=await frameXmlStubPlanAsync(chunks,()=>{boundaries++;});
  assert.deepEqual(asyncPlan,sync);
  assert.ok(boundaries>=chunks.length);
  for (const own of ['LibraryApi','SetterApi','LiteralApi']) assert.equal(sync.apiNames.has(own),false,own);
  assert.equal(sync.apiCallSites.get('PrivateOnly'),1);
  assert.equal(sync.apiCallSites.get('HostApi'),2);
});

test('scheduler shares a pending yield and starts the next budget after resumption', async () => {
  let now=0, yields=0, resume;
  const scheduler=new GlueLoadScheduler({now:()=>now,milliseconds:8,yieldTask:()=>{
    yields++; return new Promise(resolve=>{resume=resolve;});
  }});
  now=7; assert.equal(scheduler.checkpoint(),undefined);
  now=8; const pending=scheduler.checkpoint();
  assert.equal(scheduler.checkpoint(),pending);
  assert.equal(yields,1);
  now=100; resume(); await pending;
  now=107; assert.equal(scheduler.checkpoint(),undefined);
});

test('cached Lua/XML loading yields to real tasks while retaining include and OnLoad order', async () => {
  let clock=0, tasks=0;
  const loadScheduler=new GlueLoadScheduler({now:()=>clock++,milliseconds:1,yieldTask:()=>new Promise(resolve=>{
    setTimeout(()=>{tasks++;resolve();},0);
  })});
  const boot=new FrameXmlBoot({loadScheduler,exercise:false,provider:createFixtureProvider({
    [prefix+'framexml.toc']:'First.lua\nRoot.xml\nLast.lua',
    [prefix+'first.lua']:'Order = "first"',
    [prefix+'root.xml']:'<Ui><Include file="Nested.xml"/><Frame name="Later"><Scripts><OnLoad>Order = Order .. ":later"</OnLoad></Scripts></Frame></Ui>',
    [prefix+'nested.xml']:'<Ui><Script file="Nested.lua"/><Frame name="Earlier"><Scripts><OnLoad>Order = Order .. ":earlier"</OnLoad></Scripts></Frame></Ui>',
    [prefix+'nested.lua']:'Order = Order .. ":nested"',
    [prefix+'last.lua']:'Order = Order .. ":last"',
  })});
  try {
    await boot.load();
    assert.ok(tasks>0,'timer tasks must execute before the load resolves');
    assert.equal(boot.vm.getGlobal('Order'),'first:nested:earlier:later:last');
    assert.equal(boot.errorCount,0);
  } finally { boot.close(); }
});

test('closing a boot at a load boundary prevents the following Lua chunk from executing', async () => {
  let boot,clock=0,executed=0;
  const loadScheduler=new GlueLoadScheduler({now:()=>clock++,milliseconds:1,yieldTask:async()=>{
    if (boot.bridge.getFrame('StopHere')) boot.close();
  }});
  boot=new FrameXmlBoot({loadScheduler,exercise:false,provider:createFixtureProvider({
    [prefix+'framexml.toc']:'Stop.xml\nAfter.lua',
    [prefix+'stop.xml']:'<Ui><Frame name="StopHere"/></Ui>',
    [prefix+'after.lua']:'ReachedAfterClose()',
  })});
  boot.vm.registerGlobal('ReachedAfterClose',()=>{executed++;return [];});
  try {
    await assert.rejects(boot.load(),/cancelled/);
    assert.equal(executed,0);
  } finally { boot.close(); }
});
