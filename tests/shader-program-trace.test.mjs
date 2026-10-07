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

// The trace before P1-02c (fingerprints computed inside mark), kept verbatim as the reference model.
const REF_SAFE_TYPES = new Set(['MeshBasicMaterial', 'MeshLambertMaterial', 'MeshPhongMaterial',
  'MeshStandardMaterial', 'MeshPhysicalMaterial', 'MeshDepthMaterial', 'MeshDistanceMaterial',
  'MeshNormalMaterial', 'MeshMatcapMaterial', 'ShaderMaterial', 'RawShaderMaterial',
  'PointsMaterial', 'LineBasicMaterial', 'LineDashedMaterial', 'SpriteMaterial', 'ShadowMaterial']);
const REF_SAFE_FIELDS = new Set(['basic', 'lambert', 'phong', 'standard', 'physical', 'matcap',
  'points', 'linedashed', 'depth', 'normal', 'sprite', 'background', 'cube', 'equirect',
  'distanceRGBA', 'shadow', 'highp', 'mediump', 'lowp', 'srgb', 'srgb-linear',
  'true', 'false', 'undefined', 'null']);
function refFingerprint(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
class ReferenceTrace {
  lastId = -1; pending = []; overflow = 0; overflowAt = 0;
  constructor(programs, at) { this.mark('existing', programs, at); }
  mark(phase, programs, at) {
    if (!programs) return;
    const previousId = this.lastId;
    const described = [];
    let added = 0;
    for (const identity of programs) {
      if (identity.id <= previousId) continue;
      this.lastId = Math.max(this.lastId, identity.id);
      added++;
      if (described.length >= 32 || this.pending.length >= 8) continue;
      const key = identity.cacheKey ?? '';
      described.push({ id: identity.id, type: REF_SAFE_TYPES.has(identity.type ?? '') ? identity.type : 'other',
        keyHash: refFingerprint(key),
        keyFields: key.split(',', 64).map(field => REF_SAFE_FIELDS.has(field) || /^-?\d{1,10}(?:\.\d{1,6})?$/.test(field)
          ? field : '#' + refFingerprint(field)) });
    }
    if (added > 0 && this.pending.length < 8) this.pending.push({ at, phase, added, omitted: added - described.length, programs: described, diagnosticMs: 0 });
    else if (added > 0) { this.overflow += added; this.overflowAt = at; }
  }
  drain() {
    const events = this.pending;
    this.pending = [];
    if (events.length && this.overflow > 0) {
      events.push({ at: this.overflowAt, phase: 'overflow', added: this.overflow, omitted: this.overflow, diagnosticMs: 0, programs: [] });
      this.overflow = 0;
    }
    return events;
  }
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0; return state / 2 ** 32; };
}
const FIELD_POOL = ['standard', 'highp', 'srgb', 'true', 'false', 'null', '42', '-3', '0.5', '1.1234567', '12345678901',
  'custom tail', ' highp', 'USE_FOG', '#define X 1', 'https://x.invalid/a.png', 'phong', 'depth', '', 'шейдер'];
const TYPES = ['MeshStandardMaterial', 'ShaderMaterial', 'RawShaderMaterial', 'WowM2Material', undefined, 'LineBasicMaterial'];
const PHASES = ['prepare', 'warm', 'sky', 'world', 'overlay', 'postprocess', 'portraits'];
const withoutTiming = events => events.map(({ diagnosticMs, ...rest }) => rest);

test('drain() reports exactly what the former in-mark fingerprints reported (200 random key sets)', () => {
  const random = seeded(0x5eed);
  const pick = list => list[Math.floor(random() * list.length)];
  let nextId = 0;
  const makeProgram = () => {
    const fields = Array.from({ length: Math.floor(random() * 90) }, () => pick(FIELD_POOL));
    const program = { id: nextId++, type: pick(TYPES) };
    if (random() > 0.05) program.cacheKey = fields.join(',');
    return program;
  };
  for (let round = 0; round < 200; round++) {
    const existing = Array.from({ length: Math.floor(random() * 4) }, makeProgram);
    const trace = new ShaderProgramTrace(existing, 0);
    const reference = new ReferenceTrace(existing, 0);
    const live = [...existing];
    const marks = 1 + Math.floor(random() * 12);
    for (let m = 0; m < marks; m++) {
      const fresh = Array.from({ length: Math.floor(random() * (random() > 0.9 ? 50 : 4)) }, makeProgram);
      live.push(...fresh);
      if (random() > 0.7) live.reverse();
      const phase = pick(PHASES);
      trace.mark(phase, live, m + 1);
      reference.mark(phase, live, m + 1);
      if (random() > 0.8) assert.deepEqual(withoutTiming(trace.drain()), withoutTiming(reference.drain()), `round ${round}, mark ${m}`);
    }
    assert.deepEqual(withoutTiming(trace.drain()), withoutTiming(reference.drain()), `round ${round}`);
  }
});

test('mark() keeps fingerprints out of the measured phase; drain() computes them (P1-02c)', () => {
  const trace = new ShaderProgramTrace([], 0);
  const split = String.prototype.split;
  let calls = 0;
  String.prototype.split = function (...args) { calls++; return split.apply(this, args); };
  try {
    trace.mark('world', [program(1), program(2, 'phong,lowp,custom')], 1);
    assert.equal(calls, 0, 'no key is split inside mark()');
    const events = trace.drain();
    assert.ok(calls >= 1, 'drain() splits the keys');
    assert.deepEqual(events[0].programs[1].keyFields.slice(0, 2), ['phong', 'lowp']);
  } finally {
    String.prototype.split = split;
  }
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
