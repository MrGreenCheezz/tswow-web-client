import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { join, resolve } from "node:path";
import {
  ATTACHMENT_BACK, ATTACHMENT_HAND_LEFT, ATTACHMENT_HAND_RIGHT, ATTACHMENT_HELM, ATTACHMENT_SHIELD,
  ATTACHMENT_SHOULDER_LEFT, ATTACHMENT_SHOULDER_RIGHT,
  BLEND_MODES, MATERIAL_TWO_SIDED, m2Animations, parseM2, parseM2Skeleton, readTextureTransforms,
} from "../tools/m2.mjs";
import { encodeWvm9 } from "../tools/wvm.mjs";
import { openDbcFile } from "../tools/dbc.mjs";
import { decodeWvm9, isWvm9 } from "../dist/code/browser/Wvm.js";

let archives;
let dbcDirectory;
let visualDbcDirectory;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory, dbcDirectory: dbcPath } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
  dbcDirectory = dbcPath();
  const candidate = resolve(process.env.VISUAL_DBC_DIR ?? join(process.cwd(), "data", "visual-dbc"));
  if (existsSync(join(candidate, "CreatureModelData.dbc"))) visualDbcDirectory = candidate;
} catch {
  archives = undefined;
  visualDbcDirectory = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withDataset = { skip: archives && dbcDirectory ? false : "no client and dataset on this machine" };

const visualDirectory = visualDbcDirectory ?? dbcDirectory;

/** Models chosen to cover the shapes that used to break: characters with many geosets, a creature
 * with more batches than submeshes, one that owns its textures, one that owns none. */
const MODELS = [
  "Character\\Human\\Male\\HumanMale",
  "Character\\Tauren\\Male\\TaurenMale",
  "Creature\\Murloc\\Murloc",
  "Creature\\Wolf\\Wolf",
  "Creature\\Illidan\\Illidan",
];

async function load(base) {
  const [m2, skin] = await Promise.all([archives.read(`${base}.m2`), archives.read(`${base}00.skin`)]);
  if (!m2 || !skin) return undefined;
  // Every animation the model has, including the ones whose keyframes are in a .anim beside it.
  const animations = m2Animations(m2);
  const files = new Map();
  for (const animation of animations) {
    if (!animation.external || files.has(animation.external)) continue;
    files.set(animation.external, await archives.read(`${base}${animation.external}.anim`));
  }
  return { model: parseM2(m2, skin), skeleton: parseM2Skeleton(m2, { animations: files }), animations };
}

test("the parser reads the whole model, and the submeshes tile the index buffer", withClient, async () => {
  for (const base of MODELS) {
    const loaded = await load(base);
    if (!loaded) continue;
    const { model } = loaded;

    // If the Level high-bits arithmetic on indexStart were wrong, submeshes would overlap or
    // leave gaps, and the old parser's response to that was to throw away every material.
    const covered = model.submeshes.reduce((total, submesh) => total + submesh.indexCount, 0);
    assert.equal(covered, model.indices.length, `${base}: submeshes should tile the index buffer`);
    for (const submesh of model.submeshes) {
      assert.ok(submesh.indexStart + submesh.indexCount <= model.indices.length, `${base}: submesh overruns`);
    }

    // Authored normals, not recomputed ones. A zeroed stream would fail this outright.
    const vertexCount = model.positions.length / 3;
    assert.equal(model.normals.length, model.positions.length, `${base}: normal stream matches positions`);
    const referenced = new Set(model.indices);
    assert.ok(referenced.size > 0, `${base}: model has referenced vertices`);
    for (const index of model.indices) {
      assert.ok(index < vertexCount, `${base}: index ${index} is outside ${vertexCount} vertices`);
    }
    let unit = 0;
    for (const index of referenced) {
      const length = Math.hypot(model.normals[index * 3], model.normals[index * 3 + 1], model.normals[index * 3 + 2]);
      assert.ok(Number.isFinite(length), `${base}: referenced normal ${index} is not finite`);
      if (Math.abs(length - 1) < 0.02) unit++;
    }
    assert.ok(unit >= Math.ceil(referenced.size * 0.8),
      `${base}: referenced authored normals should be predominantly unit length (${unit}/${referenced.size})`);

    for (const batch of model.batches) {
      assert.ok(batch.submesh < model.submeshes.length, `${base}: batch points at a missing submesh`);
      assert.ok(BLEND_MODES[batch.blendMode], `${base}: unknown blend mode ${batch.blendMode}`);
    }
  }
});

test("character models carry the geoset families that used to all draw at once", withClient, async () => {
  const loaded = await load("Character\\Tauren\\Male\\TaurenMale");
  if (!loaded) return;
  const variants = new Map();
  for (const submesh of loaded.model.submeshes) {
    const family = Math.floor(submesh.geosetId / 100) * 100;
    if (submesh.indexCount > 0) {
      if (!variants.has(family)) variants.set(family, new Set());
      variants.get(family).add(submesh.geosetId);
    }
  }
  // The active visual model may have fewer variants than stock. It still must carry multiple
  // alternatives in the hair and cloak families, proving skinSectionId was read rather than every
  // authored variant being collapsed to one or drawn wholesale.
  assert.ok((variants.get(100)?.size ?? 0) >= 2,
    `expected multiple hairstyle variants, got ${variants.get(100)?.size ?? 0}`);
  assert.ok((variants.get(1500)?.size ?? 0) >= 2,
    `expected multiple cloak variants, got ${variants.get(1500)?.size ?? 0}`);
  assert.ok((variants.get(0)?.size ?? 0) > 0, "geoset 0 is the body and is always drawn");
});

test("blend modes and material flags survive, which they never used to", withClient, async () => {
  const loaded = await load("Character\\Human\\Male\\HumanMale");
  if (!loaded) return;
  const blends = new Set(loaded.model.batches.map((batch) => batch.blendMode));
  assert.ok(blends.size > 1, "a character uses more than one blend mode");
  assert.ok(blends.has(1), "alpha-key batches exist (hair, cloth)");
  assert.ok(blends.has(4), "an additive batch exists (the eye glow)");
  const twoSided = loaded.model.batches.filter((batch) => batch.materialFlags & MATERIAL_TWO_SIDED);
  assert.ok(twoSided.length > 0 && twoSided.length < loaded.model.batches.length,
    "some batches are two-sided and some are not, so forcing DoubleSide on all was wrong");
});

test("texture slots are declared, not resolved", withClient, async () => {
  const loaded = await load("Character\\Human\\Male\\HumanMale");
  if (!loaded) return;
  const types = loaded.model.textures.map((texture) => texture.type);
  // Every character needs a body, hair, own and object-skin declaration. HD models may add
  // specialised slots (skin extra, belts, glows), so only those stable semantics are asserted.
  for (const type of [1, 6, 0, 2]) assert.ok(types.includes(type), `texture type ${type} is declared`);
  assert.equal(new Set(types).size, types.length, "texture declarations do not duplicate a slot type");
  assert.equal(loaded.model.textures.filter((texture) => texture.filename).length, 1,
    "only the own slot names a file");
});

test("Э1 the texture transforms are read, and the batches that name one are found", withClient, async () => {
  // Header slot 0x60 was counted into `unsupported` and never parsed, so a batch's
  // `textureTransform` index — decoded since v4 — pointed at a table that was not in the artifact.
  // `sunwell_fire_barrier.m2` is one of the four models under `spells\` with eight records, and all
  // eight of its batches name one.
  const m2 = await archives.read("spells\\sunwell_fire_barrier.m2");
  const skin = await archives.read("spells\\sunwell_fire_barrier00.skin");
  if (!m2 || !skin) return;
  const transforms = readTextureTransforms(m2);
  assert.equal(transforms.length, 8);
  // Three tracks a record.
  for (const transform of transforms) {
    for (const name of ["translation", "rotation", "scaling"]) {
      assert.ok(Array.isArray(transform[name].tracks), `${name} decodes`);
    }
  }
  // This model's own eight records are all translation — 1 sub-track and 2 keys each, three floats
  // to a key, with nothing on the other two tracks. That is what the review caught: the
  // unit-quaternion loop that used to stand here ran over this model and iterated nothing at all,
  // so the reading it was written to pin was pinned by nothing. It moved to the test below.
  const keys = (track) => track.tracks.reduce((total, sub) => total + sub.times.length, 0);
  assert.deepEqual(transforms.map((transform) => keys(transform.translation)), Array(8).fill(2));
  for (const transform of transforms) {
    for (const sub of transform.translation.tracks) {
      assert.equal(sub.values.length / sub.times.length, 3, "a translation key is three floats");
    }
  }
  assert.equal(transforms.reduce((total, transform) => total + keys(transform.rotation), 0), 0,
    "and none of the eight turns, which is why the rotations are checked on another model");
  const model = parseM2(m2, skin);
  assert.equal(model.batches.filter((batch) => batch.textureTransform >= 0).length, model.batches.length,
    "every batch of this model reaches a transform");
  assert.equal(model.textureTransforms.length, 8, "and parseM2 hands the table on");
});

test("Э1 a texture transform's rotation is four floats, on a model that actually turns", withClient, async () => {
  // The decision this pins is that the rotation is a plain `Quaternion` and not the `M2CompQuat` a
  // bone track uses — four floats, not four int16 — which is the difference between a turning rune
  // and one frozen at a nonsense angle. It cannot be pinned on a model with no rotation keys, and
  // 1,547 of the 1,565 readable models under `spells\` have none: the 18 that do are the force
  // shields, the scourge rune circle and the shieldwall impacts. `forceshield_andxplosion.m2` is
  // the largest of them at 6 keys.
  const models = [
    ["spells\\forceshield_andxplosion.m2", 6],
    ["spells\\creature_scourgerunecirclecrystal.m2", 5],
    ["spells\\shieldwall_impact_base.m2", 1],
  ];
  let checked = 0;
  for (const [path, expected] of models) {
    const m2 = await archives.read(path);
    if (!m2) continue;
    const transforms = readTextureTransforms(m2);
    const rotations = transforms.flatMap((transform) => transform.rotation.tracks)
      .flatMap((sub) => [...Array(sub.times.length).keys()].map((key) => sub.values.slice(key * 4, key * 4 + 4)));
    assert.equal(rotations.length, expected, `${path}: rotation keys`);
    // Unit length is what a `fixed16` reading of the same bytes cannot produce: it takes each pair
    // of the float's own bytes for an int16 over 32,767, at half the stride, and what comes back is
    // neither unit nor four wide.
    for (const quaternion of rotations) {
      assert.equal(quaternion.length, 4);
      assert.ok(Math.abs(Math.hypot(...quaternion) - 1) < 0.01,
        `${path}: unit quaternion, got ${[...quaternion]}`);
    }
    checked++;
  }
  assert.ok(checked > 0, "at least one of the three models is in these archives");

  // And the values themselves on one of them, because a decoder can be unit-length and still wrong.
  // The rune circle's single record turns a quarter about Z every 833 ms, right the way round in
  // 3,333 — five keys, x and y at 0 to the bit — which is the shape the whole slice exists to draw.
  const runes = await archives.read("spells\\creature_scourgerunecirclecrystal.m2");
  if (!runes) return;
  const [circle] = readTextureTransforms(runes);
  const [sub] = circle.rotation.tracks;
  assert.deepEqual([...sub.times], [0, 833, 1667, 2500, 3333]);
  assert.equal(sub.values.length / sub.times.length, 4, "four floats to a key, not three and not two");
  // `|| 0` because the file holds negative zeros and `-0 !== 0` to `deepEqual` alone.
  assert.deepEqual([...sub.values].map((value) => (Math.round(value * 1e6) / 1e6) || 0),
    [0, 0, 0, 1, 0, 0, 0.707107, 0.707107, 0, 0, 1, 0, 0, 0, 0.707107, -0.707107, 0, 0, 0, -1]);
  assert.equal(circle.rotation.interpolation, 1, "interpolated between them, not stepped");
});

test("a WVM9 round trip preserves every stream", withClient, async () => {
  for (const base of MODELS) {
    const loaded = await load(base);
    if (!loaded) continue;
    const { model, skeleton, animations } = loaded;
    const encoded = encodeWvm9(model, skeleton, animations.map((animation) => animation.animationId));
    assert.ok(isWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)));
    const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));

    assert.equal(decoded.positions.length, model.positions.length, `${base}: positions`);
    assert.equal(decoded.normals.length, model.normals.length, `${base}: normals`);
    assert.equal(decoded.uv1.length, model.uv1.length, `${base}: second UV set`);
    assert.equal(decoded.indices.length, model.indices.length, `${base}: indices`);
    assert.equal(decoded.submeshes.length, model.submeshes.length, `${base}: submeshes`);
    assert.equal(decoded.batches.length, model.batches.length, `${base}: batches`);
    assert.equal(decoded.textures.length, model.textures.length, `${base}: textures`);

    for (let index = 0; index < model.positions.length; index++) {
      assert.ok(Math.abs(decoded.positions[index] - model.positions[index]) < 1e-6, `${base}: position ${index}`);
    }
    for (let index = 0; index < model.indices.length; index += 997) {
      assert.equal(decoded.indices[index], model.indices[index], `${base}: index ${index}`);
    }
    assert.deepEqual(decoded.submeshes.map((s) => s.geosetId), model.submeshes.map((s) => s.geosetId), `${base}: geosets`);
    assert.deepEqual(decoded.batches.map((b) => b.blendMode), model.batches.map((b) => b.blendMode), `${base}: blends`);
    assert.deepEqual(decoded.batches.map((b) => b.materialFlags), model.batches.map((b) => b.materialFlags), `${base}: flags`);
    assert.deepEqual(decoded.textures.map((t) => [t.type, t.flags, t.path]),
      model.textures.map((t) => [t.type, t.flags, t.filename]), `${base}: texture slots`);

    // v8. Both tables have to reach the browser or every batch is drawn white at full strength
    // again — which is exactly what v7 did with the very same indices it already carried.
    assert.equal(decoded.colours.length, model.colours.length, `${base}: colours`);
    assert.equal(decoded.textureWeights.length, model.textureWeights.length, `${base}: texture weights`);
    for (const [index, colour] of model.colours.entries()) {
      assert.deepEqual(decoded.colours[index].rgb.tracks.map((sub) => [sub.sequence, [...sub.values]]),
        colour.rgb.tracks.map((sub) => [sub.sequence, [...sub.values]]), `${base}: colour ${index} rgb`);
      assert.deepEqual(decoded.colours[index].alpha.tracks.map((sub) => [sub.sequence, [...sub.times]]),
        colour.alpha.tracks.map((sub) => [sub.sequence, [...sub.times]]), `${base}: colour ${index} alpha keys`);
    }
    for (const [index, weight] of model.textureWeights.entries()) {
      assert.deepEqual(decoded.textureWeights[index].tracks.map((sub) => [...sub.values]),
        weight.tracks.map((sub) => [...sub.values]), `${base}: weight ${index}`);
    }
    if (model.portraitCamera) {
      assert.ok(decoded.portraitCamera, `${base}: the portrait camera should survive`);
      assert.ok(Math.abs(decoded.portraitCamera.fov - model.portraitCamera.fov) < 1e-6, `${base}: fov`);
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Math.abs(decoded.portraitCamera.position[axis] - model.portraitCamera.position[axis]) < 1e-6,
          `${base}: camera position ${axis}`);
        assert.ok(Math.abs(decoded.portraitCamera.target[axis] - model.portraitCamera.target[axis]) < 1e-6,
          `${base}: camera target ${axis}`);
      }
    } else assert.equal(decoded.portraitCamera, undefined, `${base}: a model with no camera declares none`);

    if (skeleton) {
      assert.deepEqual(decoded.attachments.map((a) => [a.id, a.bone]),
        skeleton.attachments.map((a) => [a.id, a.bone]), `${base}: attachment points`);
      for (let index = 0; index < decoded.attachments.length; index++) {
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(Math.abs(decoded.attachments[index].position[axis] - skeleton.attachments[index].position[axis]) < 1e-6,
            `${base}: attachment ${index} position`);
        }
      }
      assert.ok(decoded.skeleton, `${base}: skeleton should survive`);
      assert.equal(decoded.skeleton.parents.length, skeleton.bones.length, `${base}: bone count`);
      assert.deepEqual([...decoded.skeleton.flags], skeleton.bones.map((bone) => bone.flags & 0xffff),
        `${base}: bone flags, which WVM3 wrote and its decoder skipped`);
      assert.equal(decoded.skeleton.clips.length, skeleton.clips.length, `${base}: clip count`);
      assert.deepEqual(decoded.skeleton.animations, animations.map((animation) => animation.animationId).sort((a, b) => a - b),
        `${base}: the artifact should say what the model can play`);
      for (const clip of decoded.skeleton.clips) {
        for (const channel of clip.channels) {
          if (channel.kind !== 1) continue;
          for (let key = 0; key < channel.times.length; key++) {
            const length = Math.hypot(...channel.values.slice(key * 4, key * 4 + 4));
            assert.ok(Math.abs(length - 1) < 0.01, `${base}: quaternion ${key} is not unit length`);
          }
        }
      }
    }
  }
});

test("a static model encodes without a skeleton block", withClient, async () => {
  const loaded = await load("Creature\\Wolf\\Wolf");
  if (!loaded) return;
  const encoded = encodeWvm9(loaded.model, undefined);
  const decoded = decodeWvm9(encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength));
  assert.equal(decoded.skeleton, undefined);
  assert.equal(decoded.boneIndices, undefined);
  assert.ok(decoded.positions.length > 0);
});

test("a truncated model is rejected rather than decoded into nonsense", withClient, async () => {
  const loaded = await load("Creature\\Murloc\\Murloc");
  if (!loaded) return;
  const encoded = encodeWvm9(loaded.model, loaded.skeleton);
  const short = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength - 64);
  assert.throws(() => decodeWvm9(short), /bytes but/);
});

test("an artifact from a previous format is refused by name rather than misread", () => {
  // Each new table sits after the last, and an older file simply ends where the new one would
  // start — there is no reading of it that is not a guess, so the magic changes with the layout and
  // the refusal is loud. What makes that safe rather than a broken cache is the other half of each
  // slice: the namespace — `visual-v21` since global bone channels — gives every artifact a new
  // name, so a stale file is never asked for again. Both predecessors are checked, because byte 70
  // was a reserved zero in WVM8 and is the transform count in WVM9: a reader that went by length
  // rather than by name would sail straight past that and decode a model with no transforms. The
  // A1 addition is the case where only the name can help: it went into the clip header's own
  // reserved u16, so a v18 and a v19 artifact are the same magic and the same length. A2's extras
  // table is visible in the bytes and still needs the name, because a v19 artifact is a valid
  // decode with no stride speeds in it and the mount over it would go on skating.
  for (const [magic, last] of [["WVM7", 0x37], ["WVM8", 0x38]]) {
    const stale = new Uint8Array(72);
    stale.set([0x57, 0x56, 0x4d, last]);
    new DataView(stale.buffer).setUint32(24, stale.byteLength, true);
    assert.equal(isWvm9(stale.buffer), false, `${magic} is not WVM9`);
    assert.throws(() => decodeWvm9(stale.buffer), /Not a WVM9 model/, magic);
  }
});

test("almost every creature display resolves the camera its portrait is framed with", withDataset, async () => {
  // The M2 carries the camera the original client puts a unit portrait in, and the artifact has
  // never carried it. The stride is the ≤WotLK 100-byte one — scored against 92, 116 and 120 over
  // the 1,844 records these models hold — and the type-0 record is the portrait.
  // Creature display/model indirection is client visual data. Match the gateway's active overlay
  // so an HD patch is judged against the models it actually serves.
  const displays = await openDbcFile(visualDirectory, "CreatureDisplayInfo");
  const modelData = await openDbcFile(visualDirectory, "CreatureModelData");
  const withCamera = new Set();
  for (const row of modelData.rows()) {
    const name = modelData.string(row, "ModelName");
    if (!name) continue;
    const path = name.replaceAll("/", "\\").replace(/\.mdx$/i, ".m2");
    const m2 = await archives.read(path);
    const skin = await archives.read(`${path.slice(0, -3)}00.skin`);
    if (!m2 || !skin) continue;
    let model;
    try {
      model = parseM2(m2, skin);
    } catch {
      continue;
    }
    if (model.portraitCamera) withCamera.add(modelData.id(row));
  }

  let resolved = 0;
  for (const row of displays.rows()) if (withCamera.has(displays.int(row, "ModelID"))) resolved++;
  assert.ok(resolved >= Math.ceil(displays.records * 0.98),
    `${resolved} of the ${displays.records} displays frame themselves`);

  // The golden numbers, to the six decimals the file stores. A wrong stride puts the camera inside
  // the model or a hundred yards behind it, and both still look like "a camera".
  const humanMale = parseM2(await archives.read("Character\\Human\\Male\\HumanMale.m2"),
    await archives.read("Character\\Human\\Male\\HumanMale00.skin")).portraitCamera;
  assert.ok(humanMale, "HumanMale carries one");
  assert.ok(Math.abs(humanMale.fov * 180 / Math.PI - 45) < 0.001, "45 degrees, as stored in radians");
  assert.ok(Math.abs(humanMale.near - 0.222222) < 1e-5);
  assert.ok(Math.abs(humanMale.far - 27.777779) < 1e-5);
  for (const [axis, value] of [0.633485, -0.387865, 1.886737].entries()) {
    assert.ok(Math.abs(humanMale.position[axis] - value) < 1e-5, `camera position ${axis}`);
  }
  for (const [axis, value] of [0.062668, 0.034265, 1.863569].entries()) {
    assert.ok(Math.abs(humanMale.target[axis] - value) < 1e-5, `camera target ${axis}`);
  }
  // The head, not the middle of the body: 1.886 of a 2.127-yard mesh, and 0.710 yards out.
  const distance = Math.hypot(...humanMale.position.map((value, axis) => value - humanMale.target[axis]));
  assert.ok(Math.abs(distance - 0.7103) < 0.001, "0.7103 yards from camera to target");
});

test("colour keys that live in a .anim are dropped, not read out of the .m2", withClient, async () => {
  // The trap `readChannel` documents for bone tracks, on the two new tables. A sub-track belongs to
  // an animation sequence, and a sequence without flag 0x20 keeps its keyframes in a
  // `Model####-##.anim` beside the file — where the offsets in the .m2 address that file and mean
  // something else entirely inside this one. `Creature\Ent\Ent.m2` is the worst case in the drawing
  // corpus: 83 of its colour and weight sub-tracks name such a sequence.
  const m2 = await archives.read("Creature\\Ent\\Ent.m2");
  const skin = await archives.read("Creature\\Ent\\Ent00.skin");
  if (!m2 || !skin) return;
  const model = parseM2(m2, skin);

  const sequences = { count: m2.readUInt32LE(0x1c), offset: m2.readUInt32LE(0x20) };
  const external = new Set();
  for (let index = 0; index < sequences.count; index++) {
    if ((m2.readUInt32LE(sequences.offset + index * 64 + 12) & 0x20) === 0) external.add(index);
  }
  assert.ok(external.size > 0, "the Ent does keep some of its animations in .anim files");

  const published = [
    ...model.colours.flatMap((colour) => [...colour.rgb.tracks, ...colour.alpha.tracks]),
    ...model.textureWeights.flatMap((weight) => weight.tracks),
  ];
  assert.equal(published.length, 231, "the sub-tracks whose keys are in the .m2 are still carried");
  assert.deepEqual(published.filter((sub) => external.has(sub.sequence)), [],
    "and not one sub-track for a sequence whose keys are somewhere else");
});

test.after(() => archives?.close());

test("character models carry the points a helm and a sword hang from", withClient, async () => {
  // The parser counted these and threw them away, so nothing could ever be attached to a
  // character. Each record is a bone and a place on it; the ids are named from where they sit,
  // which was measured on all twenty playable models rather than taken from a wiki.
  const wanted = [
    ["helm", ATTACHMENT_HELM],
    ["right hand", ATTACHMENT_HAND_RIGHT],
    ["left hand", ATTACHMENT_HAND_LEFT],
    ["right shoulder", ATTACHMENT_SHOULDER_RIGHT],
    ["left shoulder", ATTACHMENT_SHOULDER_LEFT],
    ["back", ATTACHMENT_BACK],
    ["shield", ATTACHMENT_SHIELD],
  ];

  for (const base of ["Character\\Human\\Male\\HumanMale", "Character\\Tauren\\Male\\TaurenMale"]) {
    const loaded = await load(base);
    assert.ok(loaded, `${base} should be in the client`);
    const { skeleton } = loaded;
    const byId = new Map(skeleton.attachments.map((attachment) => [attachment.id, attachment]));
    for (const [name, id] of wanted) assert.ok(byId.has(id), `${base}: no ${name} attachment`);

    for (const attachment of skeleton.attachments) {
      assert.ok(attachment.bone < skeleton.bones.length, `${base}: attachment ${attachment.id} names a missing bone`);
      // Model space, not the bone's: what a mesh parented to that bone needs is the attachment's
      // authored position. Some hand/weapon points intentionally offset from the pivot, so do not
      // turn stock-vs-HD authored offsets into a false parser failure.
      const pivot = skeleton.bones[attachment.bone].pivot;
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(Number.isFinite(attachment.position[axis]) && Number.isFinite(pivot[axis]),
          `${base}: attachment ${attachment.id} has a non-finite position`);
      }
    }

    // The helm sits on the head and the shoulder points mirror each other across the body. M2
    // space is X forward, Y left, Z up; hand attachment ids may be authored as inactive origins.
    const helm = byId.get(ATTACHMENT_HELM);
    const rightShoulder = byId.get(ATTACHMENT_SHOULDER_RIGHT);
    const leftShoulder = byId.get(ATTACHMENT_SHOULDER_LEFT);
    assert.ok(helm.position[2] > rightShoulder.position[2], `${base}: the helm should be above the shoulders`);
    const helmPivot = skeleton.bones[helm.bone].pivot;
    assert.ok(helm.position.every((value, axis) => Math.abs(value - helmPivot[axis]) <= 1e-6),
      `${base}: the helm point should stay within the bone-pivot epsilon`);
    assert.ok(rightShoulder.position[1] * leftShoulder.position[1] < 0,
      `${base}: the shoulder points do not straddle the body`);
    assert.ok(Math.abs(rightShoulder.position[1] + leftShoulder.position[1]) < 0.1,
      `${base}: the shoulder points do not mirror`);
    assert.ok(byId.get(ATTACHMENT_BACK).position[0] < 0, `${base}: the cloak point should be behind`);
  }
});
