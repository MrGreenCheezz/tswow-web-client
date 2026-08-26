import assert from "node:assert/strict";
import test from "node:test";
import { animationFileSuffix, m2Animations, parseM2Skeleton } from "../tools/m2.mjs";
import { encodeWvaAnimations } from "../tools/wvm.mjs";
import { BASE_ANIMATION_NAMES, baseAnimationIds, loadAnimationCatalog } from "../tools/animations.mjs";
import { decodeWvaAnimations } from "../dist/code/browser/Wvm.js";
import {
  actionAnimation, addSkinnedClips, animationTransition, chooseAnimation, poseAnimation,
  isTerminalUnitPose, needsSidecarAnimations, poseTransition, readyAnimation, resolveAnimation,
  shouldCrossFadeAnimation, shouldStopPreviousAnimation, weaponPose,
} from "../dist/code/browser/AnimatedModel.js";
import {
  UNIT_STAND_STATE_DEAD, UNIT_STAND_STATE_SIT, UNIT_STAND_STATE_SIT_LOW_CHAIR,
} from "../dist/code/world/CharacterProgressProtocol.js";
import {
  ANIMATION_DATA_AVAILABLE, ANIMATION_FALLBACK, ANIMATION_IDS, BASE_ANIMATIONS, EMOTE_ANIMATIONS,
} from "../dist/code/generated/animations.js";
import { MOVEMENT_FLAGS } from "../dist/code/world/MovementProtocol.js";

let archives;
let catalog;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
  catalog = await loadAnimationCatalog();
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withAnimationData = {
  skip: ANIMATION_DATA_AVAILABLE ? false : "no locally generated animation data",
};

const HUMAN_MALE = "Character/Human/Male/HumanMale";

/** The model, and the contents of every `.anim` beside it. */
async function loadAnimations(base) {
  const m2 = await archives.read(`${base}.m2`);
  if (!m2) return undefined;
  const animations = m2Animations(m2);
  const files = new Map();
  for (const animation of animations) {
    if (!animation.external || files.has(animation.external)) continue;
    files.set(animation.external, await archives.read(`${base}${animation.external}.anim`));
  }
  return { m2, animations, files };
}

/** A unit doing nothing, which every case varies one thing from. */
function standing(overrides = {}) {
  return { dead: false, movementFlags: 0, spline: false, standState: 0, ...overrides };
}

test.after(() => archives?.close());

test("the names the client plays are the ones AnimationData.dbc assigns", withClient, () => {
  // The point of the generated table: before it, seven of the eighteen constants in the browser
  // named a different pose than the constant did, and nothing could tell.
  assert.equal(ANIMATION_IDS.Walkbackwards, catalog.idByName.get("Walkbackwards"));
  assert.equal(ANIMATION_IDS.Fall, catalog.idByName.get("Fall"));
  assert.equal(ANIMATION_IDS.SwimIdle, catalog.idByName.get("SwimIdle"));
  assert.equal(ANIMATION_IDS.Loot, catalog.idByName.get("Loot"));
  assert.equal(ANIMATION_IDS.EmoteTalk, catalog.idByName.get("EmoteTalk"));
  assert.equal(ANIMATION_IDS.SitGround, catalog.idByName.get("SitGround"));
  assert.equal(ANIMATION_IDS.ReadyUnarmed, catalog.idByName.get("ReadyUnarmed"));

  // Every name the exporter ships by has to exist in the table it is read from.
  for (const name of BASE_ANIMATION_NAMES) {
    assert.ok(catalog.idByName.has(name), `${name} is not in AnimationData.dbc`);
  }
  assert.deepEqual([...baseAnimationIds(catalog)].sort((a, b) => a - b), [...BASE_ANIMATIONS]);
});

test("the shipped set is locomotion, and combat is what is held back", () => {
  const base = new Set(BASE_ANIMATIONS);
  for (const name of ["Stand", "Run", "Walkbackwards", "Swim", "SwimIdle", "Fall", "Jump", "Death"]) {
    assert.ok(base.has(ANIMATION_IDS[name]), `${name} should travel with the model`);
  }
  for (const name of ["AttackUnarmed", "Attack2H", "SpellCastOmni", "Loot", "EmoteDance", "SitGround"]) {
    assert.ok(!base.has(ANIMATION_IDS[name]), `${name} should be fetched only when something plays it`);
  }
});

test("an external animation is read from its own file, not from the model", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded, "HumanMale should be in the client");
  const bow = loaded.animations.find((animation) => animation.animationId === ANIMATION_IDS.EmoteBow);
  assert.ok(bow, "HumanMale should have EmoteBow");
  assert.equal(bow.external, animationFileSuffix(ANIMATION_IDS.EmoteBow, 0),
    "EmoteBow keeps its keyframes in a .anim");
  assert.ok(loaded.files.get(bow.external), "and that file should be in the archives");

  const wanted = new Set([ANIMATION_IDS.EmoteBow]);
  const withFile = parseM2Skeleton(loaded.m2, { wanted, animations: loaded.files });
  assert.equal(withFile.clips.length, 1);
  assert.ok(withFile.clips[0].channels.length > 20, "the clip should carry most of the rig");

  // The trap this replaces. The offsets an external sequence holds are addresses in its .anim,
  // and every one of them also lands inside the 1.5 MiB .m2 — so a bounds check alone accepts
  // them and publishes noise. Reading the same tracks out of the model shows what that is worth.
  const wrong = parseM2Skeleton(loaded.m2, { wanted, animations: new Map([[bow.external, loaded.m2]]) });
  const unit = (clip) => {
    let good = 0;
    let total = 0;
    for (const channel of clip.channels) {
      if (channel.kind !== 1) continue;
      for (let key = 0; key < channel.times.length; key++) {
        total++;
        let sum = 0;
        for (let part = 0; part < 4; part++) {
          const raw = channel.values[key * 4 + part];
          const value = (raw < 0 ? raw + 32768 : raw - 32767) / 32767;
          sum += value * value;
        }
        if (Math.abs(Math.sqrt(sum) - 1) < 0.02) good++;
      }
    }
    return { good, total };
  };
  const right = unit(withFile.clips[0]);
  assert.equal(right.good, right.total, "read from the .anim, every rotation key is a unit quaternion");
  const noise = unit(wrong.clips[0]);
  assert.ok(noise.good < noise.total * 0.1,
    `read from the .m2, ${noise.good} of ${noise.total} keys look like rotations — expected almost none`);

  // And with no file at all the clip is skipped rather than invented.
  const without = parseM2Skeleton(loaded.m2, { wanted, animations: new Map() });
  assert.equal(without, undefined);
});

test("an alias animation borrows the sequence that owns the keyframes", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  // EmoteUseStanding has no data of its own: it points at EmoteUseStandingNoSheathe, which points
  // at UseStandingLoop. Two hops, and the file for the last one is the file to open.
  const alias = loaded.animations.find((animation) => animation.animationId === ANIMATION_IDS.EmoteUseStanding);
  assert.ok(alias, "EmoteUseStanding should still be listed");
  assert.equal(alias.external, animationFileSuffix(ANIMATION_IDS.UseStandingLoop, 0),
    "and it should read the file of the sequence it aliases");
  const skeleton = parseM2Skeleton(loaded.m2, { wanted: new Set([alias.animationId]), animations: loaded.files });
  assert.equal(skeleton.clips.length, 1);
  assert.equal(skeleton.clips[0].animationId, ANIMATION_IDS.EmoteUseStanding);
});

test("every animation a character carries reaches the browser, in one file or the other", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  const skeleton = parseM2Skeleton(loaded.m2, { animations: loaded.files });
  assert.equal(skeleton.missingAnimations, 0, "no animation should be left without data");
  const shipped = new Set(BASE_ANIMATIONS);
  const base = skeleton.clips.filter((clip) => shipped.has(clip.animationId));
  const rest = skeleton.clips.filter((clip) => !shipped.has(clip.animationId));
  assert.ok(base.length >= 15, `HumanMale should ship its locomotion, got ${base.length} clips`);
  assert.ok(rest.length >= 100, `and hold back the rest, got ${rest.length} clips`);
  // The swim set is the criterion of this slice, and all five of its poses are in the base file.
  for (const name of ["Swim", "SwimIdle", "SwimLeft", "SwimRight", "SwimBackwards"]) {
    assert.ok(base.some((clip) => clip.animationId === ANIMATION_IDS[name]), `${name} should ship with the model`);
  }
});

test("held-back animations survive the round trip and become playable clips", withClient, async () => {
  const loaded = await loadAnimations(HUMAN_MALE);
  assert.ok(loaded);
  const skeleton = parseM2Skeleton(loaded.m2, {
    wanted: new Set([ANIMATION_IDS.AttackUnarmed, ANIMATION_IDS.Loot]),
    animations: loaded.files,
  });
  const encoded = encodeWvaAnimations(skeleton.bones.length, skeleton.clips);
  const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  const decoded = decodeWvaAnimations(buffer, skeleton.bones.length);
  assert.deepEqual(decoded.map((clip) => clip.animationId).sort((a, b) => a - b),
    [ANIMATION_IDS.AttackUnarmed, ANIMATION_IDS.Loot].sort((a, b) => a - b));
  assert.ok(decoded[0].duration > 0);

  // Pairing a block with the wrong rig would pose bones that mean something else there.
  assert.throws(() => decodeWvaAnimations(buffer, skeleton.bones.length + 1), /rigged for/);

  // Built into a template, they are simply more poses the model can strike.
  const template = {
    clips: new Map(),
    animations: new Set(),
    parents: Int16Array.from(skeleton.bones.map((bone) => bone.parent)),
    pivots: Float32Array.from(skeleton.bones.flatMap((bone) => bone.pivot)),
  };
  assert.equal(addSkinnedClips(template, decoded), decoded.length);
  assert.ok(template.clips.has(ANIMATION_IDS.Loot));
  assert.equal(addSkinnedClips(template, decoded), 0, "and they are not built twice");
});

test("a swimming character swims", () => {
  const { Swim, SwimIdle, SwimLeft, SwimBackwards, Run, Stand } = ANIMATION_IDS;
  const swimming = MOVEMENT_FLAGS.swimming;
  const swimmer = new Map([[Stand, {}], [Run, {}], [Swim, {}], [SwimIdle, {}], [SwimLeft, {}], [SwimBackwards, {}]]);

  // The criterion of this slice: pressing forward in water is not a run.
  const forward = chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward }));
  assert.equal(forward.animation, Swim);
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming })).animation, SwimIdle,
    "treading water is its own pose, not standing");
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.backward })).animation, SwimBackwards);
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.strafeLeft })).animation, SwimLeft);
  // Diving is going somewhere, even with no key held: without this the idle plays all the way down.
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.descending })).animation, Swim);
  // Entering the water sets falling and swimming in the same word; the water wins.
  assert.equal(chooseAnimation(swimmer, standing({ movementFlags: swimming | MOVEMENT_FLAGS.falling })).animation, SwimIdle);

  // A model that cannot swim keeps moving the way it can, rather than gliding across the lake in
  // its standing pose. The table itself says Swim gives way to Walk; a model with neither ends on
  // the ground pose the preference list carries as its last entry.
  const walker = new Map([[Stand, {}], [Run, {}]]);
  assert.equal(chooseAnimation(walker, standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward })).animation, Run);
  assert.equal(chooseAnimation(new Map([[Stand, {}], [ANIMATION_IDS.Walk, {}]]),
    standing({ movementFlags: swimming | MOVEMENT_FLAGS.forward })).animation, ANIMATION_IDS.Walk,
    "and the table's own chain answers before the last resort does");
});

test("a flying spline selects flight poses even when MovementInfo has no flying bit", () => {
  const { Fly, Hover, Run, Stand } = ANIMATION_IDS;
  const clips = new Map([[Fly, {}], [Hover, {}], [Run, {}], [Stand, {}]]);
  const flight = standing({ spline: true, flight: true, movementFlags: MOVEMENT_FLAGS.forward });
  assert.equal(poseAnimation(flight).wanted[0], Fly);
  assert.equal(chooseAnimation(clips, flight).animation, Fly);
  assert.equal(chooseAnimation(clips, standing({ spline: true, flight: true })).animation, Fly,
    "an active flight spline is moving even when its movement flags are empty");
  // Permission to fly is not the same as actively flying; ordinary spline movement keeps its
  // ground pose until the spline itself carries FLAG_FLYING.
  assert.equal(chooseAnimation(clips, standing({ spline: true, movementFlags: MOVEMENT_FLAGS.canFly })).animation, Run);
});

test("death and corpse poses are terminal, while respawn can choose a live pose", () => {
  const { Death, Dead, Stand } = ANIMATION_IDS;
  const corpse = standing({ dead: true });
  assert.equal(isTerminalUnitPose(corpse), true);
  assert.equal(isTerminalUnitPose(standing({ standState: UNIT_STAND_STATE_DEAD })), true);
  assert.equal(isTerminalUnitPose(standing()), false);
  assert.equal(poseAnimation(corpse).loop, true, "the authored Dead pose is already terminal");
  assert.equal(chooseAnimation(new Map([[Death, {}], [Stand, {}]]), corpse).loop, false);
  assert.equal(chooseAnimation(new Map([[Dead, {}], [Stand, {}]]), corpse).loop, true);
  assert.equal(chooseAnimation(new Map([[Dead, {}], [Stand, {}]]), standing()).animation, Stand);
  assert.equal(chooseAnimation(new Map([[Death, {}], [Stand, {}]]),
    standing({ standState: UNIT_STAND_STATE_DEAD })).loop, false,
    "the replicated dead stand state also clamps fallback Death");
  assert.equal(poseAnimation(standing({ standState: UNIT_STAND_STATE_DEAD })).loop, true,
    "the replicated dead stand state also holds its terminal pose");
});

test("the ground poses follow the direction the unit is going", () => {
  const { Stand, Walk, Run, Walkbackwards, ShuffleLeft, RunRight, Jump, Fall, SitGround } = ANIMATION_IDS;
  const clips = new Map([[Stand, {}], [Walk, {}], [Run, {}], [Walkbackwards, {}], [ShuffleLeft, {}],
    [RunRight, {}], [Jump, {}], [Fall, {}], [SitGround, {}]]);
  const at = (flags, extra = {}) => chooseAnimation(clips, standing({ movementFlags: flags, ...extra })).animation;

  assert.equal(at(0), Stand);
  assert.equal(at(MOVEMENT_FLAGS.forward), Run);
  assert.equal(at(MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking), Walk);
  assert.equal(at(MOVEMENT_FLAGS.backward), Walkbackwards, "there is no run-backwards in this build");
  assert.equal(at(MOVEMENT_FLAGS.strafeRight), RunRight);
  assert.equal(at(MOVEMENT_FLAGS.strafeLeft | MOVEMENT_FLAGS.walking), ShuffleLeft);
  // A diagonal is a run forward, as it is in the original client.
  assert.equal(at(MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.strafeLeft), Run);
  // Turning on the spot is not going anywhere.
  assert.equal(at(MOVEMENT_FLAGS.turnLeft), Stand);
  assert.equal(at(MOVEMENT_FLAGS.falling), Jump);
  assert.equal(at(0, { standState: UNIT_STAND_STATE_SIT }), SitGround);
  // The chair heights sit one place later in the enum than they look like they should, and a list
  // written from memory drew a character on a low chair standing up.
  assert.equal(chooseAnimation(new Map([[Stand, {}], [ANIMATION_IDS.SitChairLow, {}]]),
    standing({ standState: UNIT_STAND_STATE_SIT_LOW_CHAIR })).animation, ANIMATION_IDS.SitChairLow);
  // A creature walking a server-side spline carries no flags at all and still has to move.
  assert.equal(chooseAnimation(clips, standing({ spline: true })).animation, Run);
});

test("a jump is three animations and one flag, so the takeoff and the landing are transitions", () => {
  const ground = standing();
  const air = standing({ movementFlags: MOVEMENT_FLAGS.falling });
  assert.equal(poseTransition(ground, air), ANIMATION_IDS.JumpStart);
  assert.equal(poseTransition(air, ground), ANIMATION_IDS.JumpEnd);
  assert.equal(poseTransition(air, air), undefined);
  assert.equal(poseTransition(undefined, air), undefined, "a unit that appears mid-air has not jumped");
  // Falling into water and swimming out of it are not jumps.
  const water = standing({ movementFlags: MOVEMENT_FLAGS.swimming });
  assert.equal(poseTransition(air, water), undefined);
  assert.equal(poseTransition(water, ground), undefined);
  // Sitting down and standing up have their own one-shots.
  assert.equal(poseTransition(ground, standing({ standState: UNIT_STAND_STATE_SIT })), ANIMATION_IDS.SitGroundDown);
  assert.equal(poseTransition(standing({ standState: UNIT_STAND_STATE_SIT }), ground), ANIMATION_IDS.SitGroundUp);
  // The airborne pose itself loops: an arc lasts as long as the fall does.
  assert.equal(poseAnimation(air).loop, true);
});

test("П2 a rider holds the mount pose whatever the mount is doing, and holds it before the fall", () => {
  const { Mount, Stand, Jump, Run, Swim, Fly } = ANIMATION_IDS;

  // Every flag the mount can be carrying, and the answer is the same one each time: the horse
  // swims and flies and jumps, the character sits. Measured over this build's twenty playable
  // models — all twenty carry 91, none carries 94 MountSpecial or 320 FlyMount — so 91 and then
  // Stand is the whole of the list a player has.
  const flags = [
    0,
    MOVEMENT_FLAGS.forward,
    MOVEMENT_FLAGS.forward | MOVEMENT_FLAGS.walking,
    MOVEMENT_FLAGS.backward,
    MOVEMENT_FLAGS.strafeLeft,
    MOVEMENT_FLAGS.swimming,
    MOVEMENT_FLAGS.swimming | MOVEMENT_FLAGS.descending,
    MOVEMENT_FLAGS.flying,
    MOVEMENT_FLAGS.falling,
    MOVEMENT_FLAGS.fallingFar,
    MOVEMENT_FLAGS.hover,
  ];
  for (const movementFlags of flags) {
    const pose = standing({ mounted: true, movementFlags });
    assert.deepEqual(poseAnimation(pose).wanted, [Mount], `flags 0x${movementFlags.toString(16)}`);
    assert.equal(poseAnimation(pose).loop, true, "a seat is a stance, and a stance repeats");
  }
  // A spline is the taxi case, and it carries the flags of neither.
  assert.deepEqual(poseAnimation(standing({ mounted: true, spline: true, flight: true })).wanted, [Mount]);

  // The branch stands *before* the falling one, and this is the assertion that says so: moved
  // after it, a rider going over a rise reads Jump and the character leaps out of the saddle.
  const clips = new Map([[Mount, {}], [Stand, {}], [Jump, {}], [Run, {}], [Swim, {}], [Fly, {}]]);
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.falling })).animation,
    Mount, "a falling rider is a rider");
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.swimming })).animation, Mount);
  assert.equal(chooseAnimation(clips, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.flying })).animation, Mount);
  // And it stands after `dead`, which outranks it. A corpse in a saddle should not arrive at all —
  // the mount is an aura, and `AuraEffect::HandleAuraMounted` (`SpellAuraEffects.cpp:2624`) calls
  // `Dismount()` on removal, which zeroes the field — but the order says which wins if one does.
  assert.equal(poseAnimation(standing({ mounted: true, dead: true })).wanted[0], ANIMATION_IDS.Dead);

  // Getting on and off has no clip in this build — none of the eight "mount" names in
  // `AnimationData.dbc` is a one-shot mounting — and neither does anything that happens up there.
  const ground = standing();
  const seated = standing({ mounted: true });
  assert.equal(poseTransition(ground, seated), undefined);
  assert.equal(poseTransition(seated, ground), undefined);
  assert.equal(poseTransition(seated, standing({ mounted: true, movementFlags: MOVEMENT_FLAGS.falling })), undefined,
    "and a horse going over a rise does not throw its rider into a JumpStart");
  // The unmounted cases are untouched by that guard.
  assert.equal(poseTransition(ground, standing({ movementFlags: MOVEMENT_FLAGS.falling })), ANIMATION_IDS.JumpStart);
});

test("П2 the seated pose is fetched, not resolved away by a Stand written behind it", () => {
  const { Mount, Stand, Run } = ANIMATION_IDS;
  // What a unit holds the frame it is bound: the 21 base ids that travel inside the artifact, the
  // model's own list of everything it can play, and `merged` still false. That is not a rare state
  // — `#unitKey` appends an appearance digest, so entering the world and every change of armour
  // builds a fresh template — and 91 is in the second list and not the first, because
  // `tools/generate-visual-model.mjs` puts everything outside `BASE_ANIMATION_NAMES` in the sidecar.
  const fresh = () => ({
    clips: new Map(BASE_ANIMATIONS.map((id) => [id, {}])),
    animations: new Set([...BASE_ANIMATIONS, Mount, ANIMATION_IDS.SitGround]),
    merged: false,
  });
  assert.ok(!BASE_ANIMATIONS.includes(Mount), "91 does not travel with the model");
  assert.equal(ANIMATION_FALLBACK[Mount], undefined, "and AnimationData.dbc gives it no substitute");

  // The defect, at the only level that can see it. With Stand written behind it the list resolves
  // against clips that are already built, `#requestAnimations` returns on its first guard, and the
  // rider holds Stand in the saddle until some unrelated emote happens to pull the sidecar in.
  // `chooseAnimation` cannot show this: it is handed a clip map with 91 already in it.
  assert.equal(resolveAnimation(fresh().clips, [Mount, Stand]), Stand);
  assert.equal(needsSidecarAnimations(fresh(), [Mount, Stand]), false,
    "a list whose tail every model carries can never reach the sidecar");

  const wanted = poseAnimation(standing({ mounted: true })).wanted;
  assert.deepEqual(wanted, [Mount]);
  assert.equal(needsSidecarAnimations(fresh(), wanted), true, "so the mounted pose has to ask for 91 itself");
  // Which is exactly how the sitting poses have always behaved — `[SitGround, SitGroundDown]`
  // resolves to neither on a fresh template, and that is why they were never seen to fail.
  assert.equal(needsSidecarAnimations(fresh(),
    poseAnimation(standing({ standState: UNIT_STAND_STATE_SIT })).wanted), true);

  // And what is drawn while the fetch is in flight is unchanged: the rider stands, by
  // `chooseAnimation`'s own last resort rather than by the list.
  assert.equal(chooseAnimation(fresh().clips, standing({ mounted: true })).animation, Stand);
  const seated = fresh();
  seated.clips.set(Mount, {});
  assert.equal(chooseAnimation(seated.clips, standing({ mounted: true })).animation, Mount,
    "and once the sidecar is in, 91");
  assert.equal(needsSidecarAnimations(seated, wanted), false, "with nothing left to ask for");

  // The two guards the first one must not swallow: a model that does not claim the pose never asks
  // — a stand-in creature would otherwise fetch a set it has not got — and one fetch per model.
  assert.equal(needsSidecarAnimations({ clips: new Map([[Stand, {}]]), animations: new Set([Stand, Run]), merged: false },
    wanted), false);
  assert.equal(needsSidecarAnimations({ ...fresh(), merged: true }, wanted), false);
});

test("a completed one-shot is not used as a stale blend source", () => {
  assert.equal(animationTransition(true, true), "crossfade");
  assert.equal(animationTransition(false, true), "stop");
  assert.equal(animationTransition(true, false), "none");
  assert.equal(shouldCrossFadeAnimation(true, true), true, "a live previous pose still blends");
  assert.equal(shouldCrossFadeAnimation(false, true), false, "a clamped reaction must not snap back");
  assert.equal(shouldCrossFadeAnimation(true, false), false, "the same clip never needs a blend");
  assert.equal(shouldStopPreviousAnimation(true, true), false, "a live pose remains the blend source");
  assert.equal(shouldStopPreviousAnimation(false, true), true, "a clamped pose is removed from the mixer");
  assert.equal(shouldStopPreviousAnimation(true, false), false, "the same clip is not stopped");
});

test("a missing pose walks the table's own chain of visual equivalents", () => {
  const { AttackUnarmed, Attack1H, Attack2H, Attack2HL, Stand } = ANIMATION_IDS;
  // Attack2HL gives way to Attack2H, then Attack1H, then AttackUnarmed — three hops of data.
  assert.equal(ANIMATION_FALLBACK[Attack2HL], Attack2H);
  assert.equal(ANIMATION_FALLBACK[Attack2H], Attack1H);
  assert.equal(ANIMATION_FALLBACK[Attack1H], AttackUnarmed);
  assert.equal(resolveAnimation(new Set([AttackUnarmed, Stand]), [Attack2HL]), AttackUnarmed);
  assert.equal(resolveAnimation(new Set([Stand]), [Attack2HL]), undefined, "and it stops when nothing matches");
  // The preference list is tried in order before any chain is walked: a strafe is answered by the
  // sideways pose the model has, not by whatever its first choice happens to fall back to.
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.ShuffleLeft, ANIMATION_IDS.Run]),
    [ANIMATION_IDS.RunLeft, ANIMATION_IDS.ShuffleLeft]), ANIMATION_IDS.ShuffleLeft);
});

test("the swing a unit makes is the weapon it is visibly holding", () => {
  const mainHand = (inventoryType) => [{ slot: 15, inventoryType }];
  assert.equal(weaponPose(undefined), "unarmed");
  assert.equal(weaponPose([]), "unarmed");
  assert.equal(weaponPose(mainHand(13)), "oneHand", "INVTYPE_WEAPON");
  assert.equal(weaponPose(mainHand(21)), "oneHand", "INVTYPE_WEAPONMAINHAND");
  assert.equal(weaponPose(mainHand(17)), "twoHand", "INVTYPE_2HWEAPON");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 15 }]), "bow");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 26 }]), "gun", "INVTYPE_RANGEDRIGHT");
  assert.equal(weaponPose([{ slot: 17, inventoryType: 25 }]), "thrown");
  // A hunter carries both. What is in the hands decides the melee swing.
  assert.equal(weaponPose([{ slot: 17, inventoryType: 15 }, { slot: 15, inventoryType: 13 }]), "oneHand");
  // A shield is not a weapon and does not change the swing.
  assert.equal(weaponPose([{ slot: 16, inventoryType: 14 }]), "unarmed");

  assert.deepEqual(actionAnimation("attack", "twoHand"),
    [ANIMATION_IDS.Attack2H, ANIMATION_IDS.Attack1H, ANIMATION_IDS.AttackUnarmed]);
  assert.deepEqual(actionAnimation("attack", "unarmed"), [ANIMATION_IDS.AttackUnarmed]);
  assert.deepEqual(readyAnimation("bow"), [ANIMATION_IDS.ReadyBow, ANIMATION_IDS.ReadyUnarmed]);
  // A model with only the unarmed swing still swings: every list ends where the chain does.
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.AttackUnarmed]), actionAnimation("attack", "gun")),
    ANIMATION_IDS.AttackUnarmed);
  assert.equal(resolveAnimation(new Set([ANIMATION_IDS.SpellCastOmni]), actionAnimation("cast", "unarmed")),
    ANIMATION_IDS.SpellCastOmni);
});

test("an emote names its pose through Emotes.dbc, and states are the ones that hold", withAnimationData, () => {
  // ONESHOT_WAVE and STATE_DANCE, which is the difference between waving once and dancing until
  // you move. The ids are the server's; the poses come from the table, not from this test.
  const wave = EMOTE_ANIMATIONS[3];
  assert.equal(wave.animation, ANIMATION_IDS.EmoteWave);
  assert.equal(wave.state, false);
  const dance = EMOTE_ANIMATIONS[10];
  assert.equal(dance.animation, ANIMATION_IDS.EmoteDance);
  assert.equal(dance.state, true);
  // STATE_SIT names Stand, because sitting is the unit's stand state and not an animation; rows
  // like that are dropped rather than played, which would stand a sitting character up.
  assert.equal(EMOTE_ANIMATIONS[13], undefined);
  assert.equal(EMOTE_ANIMATIONS[0], undefined, "ONESHOT_NONE is nothing at all");
});

test("a unit ambling along a spline walks, and one covering ground runs", () => {
  // TrinityCore never sets the walking flag for a unit on a server-side spline — `MoveSplineFlag`
  // has no walk bit, so `SMSG_MONSTER_MOVE` cannot report one — while `RandomMovementGenerator`
  // defaults every wandering NPC to walking. Judging by the flag alone therefore ran every
  // creature in every town. The spline's own length over its own duration is the answer.
  const base = { dead: false, movementFlags: 0, spline: true, standState: 0 };
  const walk = poseAnimation({ ...base, speed: 2.5 });
  const run = poseAnimation({ ...base, speed: 7 });
  assert.equal(walk.wanted[0], ANIMATION_IDS.Walk, "2.5 yd/s is the default walk speed");
  assert.equal(run.wanted[0], ANIMATION_IDS.Run, "7 yd/s is the default run speed");
  // Either way the other clip stays as the fallback: not every model has both.
  assert.equal(walk.wanted[1], ANIMATION_IDS.Run);
  assert.equal(run.wanted[1], ANIMATION_IDS.Walk);
});

test("without a measured speed the walking flag still decides", () => {
  // A player's own movement carries the flag and no spline, and that path is unchanged.
  const forward = MOVEMENT_FLAGS.forward;
  const running = poseAnimation({ dead: false, movementFlags: forward, spline: false, standState: 0 });
  const walking = poseAnimation({ dead: false, movementFlags: forward | 0x100, spline: false, standState: 0 });
  assert.equal(running.wanted[0], ANIMATION_IDS.Run);
  assert.equal(walking.wanted[0], ANIMATION_IDS.Walk);
  // A speed of zero is "not known", not "standing still": standing is decided before this.
  const unknown = poseAnimation({ dead: false, movementFlags: forward | 0x100, spline: false, standState: 0, speed: 0 });
  assert.equal(unknown.wanted[0], ANIMATION_IDS.Walk);
});
