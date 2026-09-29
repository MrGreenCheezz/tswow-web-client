// A10 / 6.21 (read-only): what the data alone says about the four decisions of 29.09.
//   A. AnimationData.Bodyflags bit 0x8 against the names, and against what the M2 clips really key
//      (do the 0x8 clips leave the legs alone? do the others move them?).
//   B. SpellVisualKit StartAnimID / AnimID: how 0 is used next to -1 and positive ids.
//   C. Channel spells whose ChannelKit names no pose: the "212 rows, 85 loop" numbers of 6.21.
// Nothing is written; the client archives and the dataset DBCs are only read.
//   .runtime/node/node.exe --import ./tools/register-test-sources.mjs <this file>
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { openDbcFile } = await load("tools/dbc.mjs");
const { dbcDirectory, clientDirectory } = await load("tools/paths.mjs");
const { clientArchives } = await load("tools/mpq.mjs");
const { m2Animations, parseM2Skeleton } = await load("tools/m2.mjs");
const { locomotionBoneMask } = await load("dist/code/browser/AnimatedModel.js");
const directory = dbcDirectory();

/* ---------------------------------------------------------------- A. AnimationData ---------- */
const anim = await openDbcFile(directory, "AnimationData");
const rows = [];
for (const row of anim.rows()) {
  rows.push({
    id: anim.id(row), name: anim.string(row, "Name"), weapon: anim.int(row, "Weaponflags") >>> 0,
    body: anim.int(row, "Bodyflags") >>> 0, flags: anim.int(row, "Flags") >>> 0,
    fallback: anim.int(row, "Fallback"), behavior: anim.int(row, "BehaviorID"), tier: anim.int(row, "BehaviorTier"),
  });
}
const byId = new Map(rows.map((r) => [r.id, r]));
const hex = (v) => `0x${v.toString(16)}`;
const histogram = (values) => {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${hex(k)}×${n}`).join(" ");
};
console.log(`== A. AnimationData: ${rows.length} rows`);
console.log("Bodyflags values:", histogram(rows.map((r) => r.body)));
console.log("Weaponflags values:", histogram(rows.map((r) => r.weapon)));
console.log("Flags values:", histogram(rows.map((r) => r.flags)));
const with8 = rows.filter((r) => (r.body & 0x8) !== 0);
const without8 = rows.filter((r) => (r.body & 0x8) === 0);
console.log(`rows with 0x8: ${with8.length}; without: ${without8.length}`);
console.log("names WITH 0x8:", with8.map((r) => `${r.id}:${r.name}`).join(" "));
console.log("names WITHOUT 0x8 (named, Bodyflags!=0):", without8.filter((r) => r.body !== 0).map((r) => `${r.id}:${r.name}(${hex(r.body)})`).join(" "));
console.log("names with Bodyflags==0:", without8.filter((r) => r.body === 0).map((r) => `${r.id}:${r.name}`).join(" ").slice(0, 1500));

/* ---------------------------------------------------------------- B. kits: id 0 ------------- */
const kits = await openDbcFile(directory, "SpellVisualKit");
const kitRows = new Map();
const pairClass = new Map();
const cls = (v) => (v < 0 ? "-1" : v === 0 ? "0" : ">0");
for (const row of kits.rows()) {
  const start = kits.int(row, "StartAnimID");
  const main = kits.int(row, "AnimID");
  const effects = ["HeadEffect", "ChestEffect", "BaseEffect", "LeftHandEffect", "RightHandEffect", "BreathEffect",
    "LeftWeaponEffect", "RightWeaponEffect", "WorldEffect"].some((f) => kits.int(row, f) > 0)
    || [0, 1, 2].some((i) => kits.int(row, "SpecialEffect", i) > 0);
  const sound = kits.int(row, "SoundID") > 0;
  kitRows.set(kits.id(row), { start, main, effects, sound });
  const key = `start ${cls(start)} / anim ${cls(main)}`;
  pairClass.set(key, (pairClass.get(key) ?? 0) + 1);
}
console.log(`\n== B. SpellVisualKit: ${kitRows.size} kits`);
for (const [key, n] of [...pairClass.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${key}: ${n}`);
const zeroKits = [...kitRows.entries()].filter(([, k]) => k.start === 0 || k.main === 0);
console.log(`kits naming 0 in either column: ${zeroKits.length}; of them with an effect model: ${zeroKits.filter(([, k]) => k.effects).length}, sound only: ${zeroKits.filter(([, k]) => !k.effects && k.sound).length}, nothing else: ${zeroKits.filter(([, k]) => !k.effects && !k.sound).length}`);
// Where the 0 sits: which SpellVisual column points at those kits.
const visual = await openDbcFile(directory, "SpellVisual");
const kitColumns = ["PrecastKit", "CastKit", "ImpactKit", "StateKit", "StateDoneKit", "ChannelKit", "CasterImpactKit", "TargetImpactKit", "MissileTargetingKit"];
const zeroByColumn = new Map();
const namedByColumn = new Map();
const visualRows = new Map();
for (const row of visual.rows()) {
  const record = { id: visual.id(row) };
  for (const column of kitColumns) {
    const kitId = visual.int(row, column);
    record[column] = kitId;
    const kit = kitRows.get(kitId);
    if (!kit) continue;
    if (kit.start === 0 || kit.main === 0) zeroByColumn.set(column, (zeroByColumn.get(column) ?? 0) + 1);
    if (kit.start > 0 || kit.main > 0) namedByColumn.set(column, (namedByColumn.get(column) ?? 0) + 1);
  }
  visualRows.set(record.id, record);
}
console.log("SpellVisual rows using a kit that names 0, by column:", [...zeroByColumn.entries()].map(([c, n]) => `${c}=${n}`).join(" "));
console.log("SpellVisual rows using a kit that names a positive pose, by column:", [...namedByColumn.entries()].map(([c, n]) => `${c}=${n}`).join(" "));
// Spells that reach a kit naming 0 (any column), and how many of those have no other pose kit.
const spell = await openDbcFile(directory, "Spell");
const spellFields = spell.fieldNames;
const visualElements = spellFields.filter((name) => name === "SpellVisualID").length;
const visualIdOf = (row) => {
  const ids = [];
  for (const element of [0, 1]) {
    try { ids.push(spell.int(row, "SpellVisualID", element)); } catch { /* single-element layout */ }
  }
  return ids;
};
let spellsWithZero = 0;
let spellsTotalWithVisual = 0;
let channelSpells = 0;
let channelSpellsNoChannelPose = 0;
let channelSpellsNoChannelPoseCastPose = 0;
const channelRowsNoPose = new Set();
const channelRowsCastPose = new Set();
const channelRowsCastRelease = new Set();
let spellsWithZeroLearn = 0;
const releasePoses = new Set([...byId.values()].filter((r) => /^(Fly)?SpellCast(Directed|Omni)?$/.test(r.name)).map((r) => r.id));
const posesOf = (kit) => kit !== undefined && (kit.start > 0 || kit.main > 0);
for (const row of spell.rows()) {
  const visualIds = visualIdOf(row).filter((id) => id > 0);
  if (visualIds.length === 0) continue;
  spellsTotalWithVisual++;
  const attributesEx = spell.int(row, "AttributesEx") >>> 0;
  const channelFlag = (attributesEx & 0x4) !== 0 || (attributesEx & 0x40) !== 0;
  const channelInterrupt = (spell.int(row, "ChannelInterruptFlags") >>> 0) !== 0;
  let anyZero = false;
  for (const id of visualIds) {
    const record = visualRows.get(id);
    if (!record) continue;
    for (const column of kitColumns) {
      const kit = kitRows.get(record[column]);
      if (kit && (kit.start === 0 || kit.main === 0)) anyZero = true;
    }
    if (channelFlag || channelInterrupt) {
      const channelKit = kitRows.get(record.ChannelKit);
      const castKit = kitRows.get(record.CastKit);
      if (!posesOf(channelKit)) {
        channelRowsNoPose.add(id);
        if (posesOf(castKit)) {
          channelRowsCastPose.add(id);
          if (releasePoses.has(castKit.main) || releasePoses.has(castKit.start)) channelRowsCastRelease.add(id);
        }
      }
    }
  }
  if (anyZero) spellsWithZero++;
  if (channelFlag || channelInterrupt) {
    channelSpells++;
    const anyChannelPose = visualIds.some((id) => posesOf(kitRows.get(visualRows.get(id)?.ChannelKit)));
    if (!anyChannelPose) {
      channelSpellsNoChannelPose++;
      if (visualIds.some((id) => posesOf(kitRows.get(visualRows.get(id)?.CastKit)))) channelSpellsNoChannelPoseCastPose++;
    }
  }
}
console.log(`spells with a SpellVisualID: ${spellsTotalWithVisual}; reaching a kit that names 0: ${spellsWithZero}`);
// The other reading of "212 channel rows": SpellVisual rows that carry a ChannelKit at all.
{
  let withChannelKit = 0; let noPose = 0; let noPoseCastPose = 0; let release = 0; let zeroChannel = 0;
  for (const record of visualRows.values()) {
    if (record.ChannelKit <= 0) continue;
    withChannelKit++;
    const channelKit = kitRows.get(record.ChannelKit);
    if (channelKit && (channelKit.start === 0 || channelKit.main === 0)) zeroChannel++;
    if (posesOf(channelKit)) continue;
    noPose++;
    const castKit = kitRows.get(record.CastKit);
    if (!posesOf(castKit)) continue;
    noPoseCastPose++;
    if (releasePoses.has(castKit.main) || releasePoses.has(castKit.start)) release++;
  }
  console.log(`SpellVisual rows with a ChannelKit: ${withChannelKit}; its kit names no pose: ${noPose}; ... and CastKit names a pose: ${noPoseCastPose}; that pose is SpellCast/Directed/Omni: ${release}; ChannelKit naming 0: ${zeroChannel}`);
}
console.log("\n== C. channels");
console.log(`channel spells (AttributesEx CHANNELED_1|2 or ChannelInterruptFlags != 0, with a visual): ${channelSpells}`);
console.log(`  channel spells whose ChannelKit names no pose: ${channelSpellsNoChannelPose}; with a CastKit pose: ${channelSpellsNoChannelPoseCastPose}`);
console.log(`  distinct SpellVisual rows behind them: no channel pose ${channelRowsNoPose.size}; cast pose ${channelRowsCastPose.size}; cast pose is SpellCast/Directed/Omni ${channelRowsCastRelease.size}`);
const castKitAnimHistogram = new Map();
for (const id of channelRowsCastPose) {
  const kit = kitRows.get(visualRows.get(id).CastKit);
  const name = byId.get(kit.main > 0 ? kit.main : kit.start)?.name ?? "?";
  castKitAnimHistogram.set(name, (castKitAnimHistogram.get(name) ?? 0) + 1);
}
console.log("  CastKit poses of those rows:", [...castKitAnimHistogram.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(" "));

/* ---------------------------------------------------------------- A2. structural check ------ */
const archives = await clientArchives(clientDirectory());
const models = [...await archives.list("Character\\")].filter((path) => /^character\\[a-z]+\\(male|female)\\[a-z]+(male|female)\.m2$/i.test(path));
console.log(`\n== A2. structural check over ${models.length} player models`);
const quaternion = (values, key) => {
  const v = [0, 1, 2, 3].map((part) => {
    const s = values[key * 4 + part];
    return (s < 0 ? s + 32768 : s - 32767) / 32767;
  });
  return v;
};
const rotationAmplitude = (channel) => {
  const first = quaternion(channel.values, 0);
  let max = 0;
  for (let key = 1; key < channel.times.length; key++) {
    const q = quaternion(channel.values, key);
    const dot = Math.abs(first[0] * q[0] + first[1] * q[1] + first[2] * q[2] + first[3] * q[3])
      / (Math.hypot(...first) * Math.hypot(...q) || 1);
    max = Math.max(max, 2 * Math.acos(Math.min(1, dot)));
  }
  return max;
};
const translationAmplitude = (channel) => {
  let max = 0;
  for (let key = 1; key < channel.times.length; key++) {
    max = Math.max(max, Math.hypot(
      channel.values[key * 3] - channel.values[0], channel.values[key * 3 + 1] - channel.values[1],
      channel.values[key * 3 + 2] - channel.values[2]));
  }
  return max;
};
const perAnimation = new Map(); // id -> { models, lowerMoving, lowerKeyed, upperMoving, total }
let usable = 0;
for (const path of models) {
  const m2 = await archives.read(path);
  if (!m2) continue;
  const external = new Map();
  for (const animation of m2Animations(m2)) {
    if (!animation.external || external.has(animation.external)) continue;
    const file = await archives.read(`${path.slice(0, -3)}${animation.external}.anim`);
    external.set(animation.external, file);
  }
  let skeleton;
  try { skeleton = parseM2Skeleton(m2, { animations: external }); } catch { continue; }
  if (!skeleton) continue;
  const parents = Int16Array.from(skeleton.bones.map((b) => b.parent));
  const pivots = Float32Array.from(skeleton.bones.flatMap((b) => b.pivot));
  const lower = locomotionBoneMask(parents, pivots);
  if (!lower.some((v) => v === 1)) continue;
  usable++;
  for (const clip of skeleton.clips) {
    const stat = perAnimation.get(clip.animationId) ?? { models: 0, lowerMoving: 0, lowerKeyed: 0, upperMoving: 0, fullBodyClips: 0 };
    let lowerMoving = 0;
    let lowerKeyed = 0;
    let upperMoving = 0;
    const seenLower = new Set();
    for (const channel of clip.channels) {
      if (channel.kind === 2) continue; // scale
      const amplitude = channel.kind === 1 ? rotationAmplitude(channel) : translationAmplitude(channel);
      const moving = channel.kind === 1 ? amplitude > 0.03 : amplitude > 0.02;
      if (lower[channel.bone] === 1) {
        seenLower.add(channel.bone);
        if (moving) lowerMoving++;
      } else if (moving) upperMoving++;
    }
    lowerKeyed = seenLower.size;
    stat.models++;
    stat.lowerMoving += lowerMoving > 0 ? 1 : 0;
    stat.lowerKeyed += lowerKeyed > 0 ? 1 : 0;
    stat.upperMoving += upperMoving > 0 ? 1 : 0;
    perAnimation.set(clip.animationId, stat);
  }
}
console.log(`usable rigs (a leg pair found): ${usable}`);
const group = { with8: { clips: 0, legsMoving: 0, legsKeyed: 0 }, without8: { clips: 0, legsMoving: 0, legsKeyed: 0 } };
const lines = [];
for (const [id, stat] of [...perAnimation.entries()].sort((a, b) => a[0] - b[0])) {
  const row = byId.get(id);
  const eight = row !== undefined && (row.body & 0x8) !== 0;
  const g = eight ? group.with8 : group.without8;
  g.clips += stat.models;
  g.legsMoving += stat.lowerMoving;
  g.legsKeyed += stat.lowerKeyed;
  lines.push(`${String(id).padStart(3)} ${(row?.name ?? "?").padEnd(26)} body=${hex(row?.body ?? 0).padEnd(6)} rigs=${String(stat.models).padStart(2)} legs-keyed=${String(stat.lowerKeyed).padStart(2)} legs-MOVING=${String(stat.lowerMoving).padStart(2)} arms/torso-moving=${String(stat.upperMoving).padStart(2)}`);
}
console.log("per animation (over the rigs that carry it):");
console.log(lines.join("\n"));
const share = (a, b) => (b === 0 ? "n/a" : `${(100 * a / b).toFixed(1)} %`);
console.log(`\nclips with 0x8   : ${group.with8.clips} rig-clips, legs keyed in ${share(group.with8.legsKeyed, group.with8.clips)}, legs MOVING in ${share(group.with8.legsMoving, group.with8.clips)}`);
console.log(`clips without 0x8: ${group.without8.clips} rig-clips, legs keyed in ${share(group.without8.legsKeyed, group.without8.clips)}, legs MOVING in ${share(group.without8.legsMoving, group.without8.clips)}`);
archives.close?.();
