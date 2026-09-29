// Small authored test emitters run through the real ParticleRender/Particles implementation.
const track = (value, components = 1) => ({ interpolation: 0, globalSequence: -1, components,
  tracks: [{ sequence: 0, times: Uint32Array.from([0]), values: Float32Array.from(value) }] });
const ramp = (value, components = 1) => ({ components, times: Float32Array.from([0]), values: Float32Array.from(value) });
export function effectFixture(bone) {
  const particle = {
    id: 1, flags: 0, position: [.05, .03, .04], bone, texture: 0, blendType: 4, emitterType: 1,
    particleType: 0, headTail: 0, particleColorIndex: 0, textureTileRotation: 0,
    textureRows: 1, textureColumns: 1, lifespanVary: 0, emissionRateVary: 0, scaleVary: [0, 0],
    tailLength: 0, twinkleSpeed: 0, twinklePercent: 0, twinkleScaleMin: 0, twinkleScaleMax: 0,
    burstMultiplier: 0, drag: 0, baseSpin: 0, baseSpinVary: 0, spin: 0, spinVary: 0,
    windVector: [0, 0, 0], windTime: 0, followSpeed1: 0, followScale1: 0, followSpeed2: 0,
    followScale2: 0, splinePoints: new Float32Array(0),
    emissionSpeed: track([.3]), speedVariation: track([0]), verticalRange: track([.1]), horizontalRange: track([.1]),
    gravity: track([.01]), lifespan: track([.5]), emissionRate: track([30]), emissionAreaLength: track([.02]),
    emissionAreaWidth: track([.02]), zSource: track([0]), enabledIn: track([1]),
    color: ramp([1, .6, .2], 3), opacity: ramp([.8]), scale: ramp([.04, .04], 2),
    headCell: ramp([0]), tailCell: ramp([0]),
  };
  const ribbon = {
    id: 2, bone, position: [.1, .02, .03], textures: Uint16Array.from([0]),
    materials: [{ blendMode: 4, flags: 0 }], edgesPerSecond: 30, edgeLifetime: .35,
    gravity: 0, textureRows: 1, textureColumns: 1, priorityPlane: 0, ribbonColorIndex: 0,
    textureTransformLookupIndex: 0, color: track([.2, .6, 1], 3), alpha: track([.8]),
    heightAbove: track([.03]), heightBelow: track([.03]), textureSlot: track([0]), visibility: track([1]),
  };
  return { globalSequences: new Uint32Array(0), particleEmitters: [particle], ribbonEmitters: [ribbon],
    textures: [{ type: 0, flags: 0, path: 'fixture\\white.blp' }] };
}

export function compareArrays(a, b) {
  if (a.length !== b.length) throw new Error(`different array lengths ${a.length} / ${b.length}`);
  let maxDelta = 0;
  for (let i = 0; i < a.length; i++) maxDelta = Math.max(maxDelta, Math.abs(a[i] - b[i]));
  return maxDelta;
}
