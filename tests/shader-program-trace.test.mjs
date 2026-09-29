import assert from 'node:assert/strict';
import test from 'node:test';
import { ShaderProgramTrace } from '../dist/code/browser/ShaderProgramTrace.js';

const program = (id, key = 'standard,highp,srgb,42') => ({ id, cacheKey: key, type: 'MeshStandardMaterial' });

test('program attribution follows creation ids across disposal and array reordering', () => {
  const a = program(3), b = program(8), c = program(9);
  const trace = new ShaderProgramTrace([b, a], 10);
  assert.equal(trace.drain()[0].phase, 'existing');
  trace.mark('warm', [a, b, c], 20);
  trace.mark('world', [c, program(10)], 21);
  const events = trace.drain();
  assert.deepEqual(events.map(e => [e.phase, e.at, e.programs.map(p => p.id)]), [
    ['warm', 20, [9]], ['world', 21, [10]],
  ]);
  trace.mark('postprocess', [c, program(10)], 22);
  assert.equal(trace.drain().length, 0, 'existing programs are not repeatedly reported');
});

test('trace never queries GL or exports shader text, material names or custom paths', () => {
  const secret = 'https://private.invalid/model?token=private-token';
  const p = { ...program(1, 'standard,highp,srgb,42,' + secret), name: secret,
    getUniforms() { throw new Error('must not fetch uniforms'); },
    isReady() { throw new Error('must not poll the driver'); },
    get vertexShader() { throw new Error('must not read shaders'); },
  };
  const trace = new ShaderProgramTrace([], 0);
  trace.mark('world', [p], 10);
  const event = trace.drain()[0], encoded = JSON.stringify(event);
  assert.equal(encoded.includes('private'), false);
  assert.deepEqual(event.programs[0].keyFields.slice(0, 4), ['standard', 'highp', 'srgb', '42']);
  assert.match(event.programs[0].keyFields[4], /^#[a-f0-9]{8}$/);
  assert.equal(event.programs[0].type, 'MeshStandardMaterial');
  assert.ok(Number.isFinite(event.diagnosticMs));
  p.id = 2;
  trace.mark('world', [p], 20);
  assert.equal(trace.drain()[0].programs[0].keyHash, event.programs[0].keyHash,
    'a disposed/recreated shader keeps its identity for diagnosis');
});

test('program descriptions and fields remain bounded and report omissions', () => {
  const many = Array.from({length: 100}, (_, i) => program(i, Array(100).fill('42').join(',')));
  const trace = new ShaderProgramTrace(many, 0);
  const event = trace.drain()[0];
  assert.equal(event.added, 100);
  assert.equal(event.programs.length, 32);
  assert.equal(event.omitted, 68);
  assert.equal(event.programs[0].keyFields.length, 64);
  trace.mark('world', [...many].reverse(), 1);
  assert.equal(trace.drain().length, 0);
});

test('a stalled consumer receives an explicit count of omitted program events', () => {
  const trace = new ShaderProgramTrace([], 0);
  for (let i = 0; i < 12; i++) trace.mark('world', [program(i)], i);
  const events = trace.drain();
  assert.equal(events.length, 9);
  assert.equal(events.at(-1).phase, 'overflow');
  assert.equal(events.at(-1).omitted, 4);
  assert.equal(trace.drain().length, 0);
  trace.mark('world', [program(12)], 13);
  assert.equal(trace.drain()[0].added, 1);
});
