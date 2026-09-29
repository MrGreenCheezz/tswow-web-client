import assert from 'node:assert/strict';
import test from 'node:test';
import { FrameXmlModeController } from '../dist/code/browser/framexml/FrameXmlModeController.js';
import { frameXmlFlagEnabled, frameXmlViewport } from '../dist/code/browser/framexml/FrameXmlWorldPolicy.js';
import { defaultSettings, parseSettings, serialiseSettings } from '../dist/code/browser/ui/SettingsModel.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('original Lua and CSS share the scaled viewport at every interface size', () => {
  for (const percent of [75, 100, 125]) {
    const logical = frameXmlViewport(1366, 768, percent);
    assert.ok(Math.abs(logical.width * logical.scale - 1366) <= logical.scale / 2);
    assert.ok(Math.abs(logical.height * logical.scale - 768) <= logical.scale / 2);
  }
});
test('a failed obsolete import cannot poison the next original UI selection', async () => {
  let reject, imports = 0, mounts = 0;
  const failure = new Promise((_resolve, fail) => { reject = fail; });
  const mode = new FrameXmlModeController(false, () => ++imports === 1 ? failure : Promise.resolve({
    mount: async () => { mounts++; return { ok: true, message: '' }; }, unmount() {},
  }), () => {});
  const first = mode.select(true);
  await mode.select(false);
  reject(new Error('network unavailable')); await first;
  await mode.select(true);
  assert.equal(imports, 2); assert.equal(mounts, 1);
});
test('original UI preference persists, with explicit URL override', () => {
  const value = parseSettings(serialiseSettings({ ...defaultSettings(), originalFrameXml: true }));
  assert.equal(frameXmlFlagEnabled('', value.originalFrameXml), true);
  assert.equal(frameXmlFlagEnabled('?framexml=0', true), false);
  assert.equal(frameXmlFlagEnabled('?framexml=1', false), true);
  assert.equal(frameXmlFlagEnabled('', defaultSettings().originalFrameXml), false);
});
test('custom mode remains lazy; switching to original and back retires its VM', async () => {
  const calls = [];
  const mode = new FrameXmlModeController(false, async () => {
    calls.push('load');
    return { mount: async original => { calls.push(original); return { ok: true, message: 'ready' }; }, unmount: () => calls.push('close') };
  }, () => {});
  await mode.select(false);
  assert.deepEqual(calls, []);
  await mode.select(true);
  await mode.select(true);
  await mode.select(false);
  assert.deepEqual(calls, ['load', true, 'close']);
});
test('switching back during import prevents an obsolete original mount', async () => {
  const loading = deferred(); const calls = [];
  const mode = new FrameXmlModeController(false, () => loading.promise, () => {});
  const pending = mode.select(true);
  await mode.select(false);
  loading.resolve({ mount: async () => { calls.push('mount'); return { ok: true, message: '' }; }, unmount() {} });
  await pending;
  assert.deepEqual(calls, []);
});
test('switch during corpus loading cancels old mount; stale completion never removes latest owner', async () => {
  const first = deferred(); const calls = []; const reports = [];
  const mode = new FrameXmlModeController(true, async () => ({
    mount: async original => { calls.push(original); return original ? first.promise : { ok: true, message: 'addons' }; },
    unmount: () => calls.push('close'),
  }), message => reports.push(message));
  const pending = mode.select(true);
  await Promise.resolve();
  await mode.select(false);
  first.resolve({ ok: false, message: 'old failure' });
  await pending;
  assert.deepEqual(calls, [true, 'close', false]);
  assert.equal(reports.at(-1), 'addons');
  mode.dispose();
  assert.equal(calls.at(-1), 'close');
});
test('world exit during import prevents late publication', async () => {
  const loading = deferred(); const calls = [];
  const mode = new FrameXmlModeController(false, () => loading.promise, () => {});
  const pending = mode.select(true); mode.dispose();
  loading.resolve({ mount: async () => { calls.push('mount'); return { ok: true, message: '' }; }, unmount() {} });
  await pending;
  assert.deepEqual(calls, []);
});
test('failed mount restores custom UI; unrelated settings do not retry until mode changes', async () => {
  let attempts = 0, closed = 0;
  const mode = new FrameXmlModeController(false, async () => ({
    mount: async () => ({ ok: ++attempts > 1, message: 'result' }),
    unmount: () => { closed++; },
  }), () => {});
  await mode.select(true); await mode.select(true);
  assert.equal(attempts, 1);
  await mode.select(false); await mode.select(true);
  assert.equal(attempts, 2); assert.equal(closed, 3);
});
