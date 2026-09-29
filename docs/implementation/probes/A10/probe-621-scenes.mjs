// A10 / 6.21 (read-only): for a hand-picked list of spells, which poses the kits name and which
// layer/hold our planner gives them — the "expected" column of the A/B scene cards.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { openDbcFile } = await load("tools/dbc.mjs");
const { dbcDirectory } = await load("tools/paths.mjs");
const directory = dbcDirectory();
const anim = await openDbcFile(directory, "AnimationData");
const names = new Map();
const bodyFlags = new Map();
for (const row of anim.rows()) { names.set(anim.id(row), anim.string(row, "Name")); bodyFlags.set(anim.id(row), anim.int(row, "Bodyflags") >>> 0); }
const kits = await openDbcFile(directory, "SpellVisualKit");
const kitById = new Map();
for (const row of kits.rows()) kitById.set(kits.id(row), { start: kits.int(row, "StartAnimID"), main: kits.int(row, "AnimID") });
const visual = await openDbcFile(directory, "SpellVisual");
const visualById = new Map();
for (const row of visual.rows()) visualById.set(visual.id(row), row);
const spell = await openDbcFile(directory, "Spell");
const spellRow = new Map();
for (const row of spell.rows()) spellRow.set(spell.id(row), row);
const casting = await openDbcFile(directory, "SpellCastTimes");
const castTimes = new Map();
for (const row of casting.rows()) castTimes.set(casting.id(row), casting.int(row, "Base"));

const label = (id) => (id <= 0 ? (id === 0 ? "0" : "-") : `${names.get(id) ?? "?"}(${id},${(bodyFlags.get(id) & 8) ? "0x8" : "full"})`);
const describeKit = (id) => {
  const kit = kitById.get(id);
  return kit === undefined ? "." : `${label(kit.start)}>${label(kit.main)}`;
};
const wanted = [
  [116, "Frostbolt r1 (cast, hold)"], [133, "Fireball r1"], [2136, "Fire Blast r1 (instant)"], [5143, "Arcane Missiles r1 (channel)"],
  [10, "Blizzard r1 (channel, area)"], [689, "Drain Life r1 (channel)"], [15407, "Mind Flay r1 (channel)"], [17, "Power Word: Shield r1 (instant)"],
  [139, "Renew r1 (instant)"], [172, "Corruption r1 (instant)"], [1680, "Whirlwind (warrior)"], [46924, "Bladestorm"],
  [45477, "Icy Touch (DK, kit 0)"], [47541, "Death Coil (DK)"], [49158, "Corpse Explosion (DK)"], [6197, "Eagle Eye (channel without a ChannelKit pose)"],
  [8690, "Hearthstone (10 s cast)"], [7620, "Fishing (channel)"], [2098, "Eviscerate r1"], [1329, "Mutilate r1"], [5185, "Healing Touch r1"],
  [635, "Holy Light r1"], [585, "Smite r1"], [348, "Immolate r1"], [1120, "Drain Soul r1"], [19434, "Aimed Shot r1"], [75, "Auto Shot"],
  [49576, "Death Grip"], [48263, "Frost Presence"], [48266, "Blood Presence"], [48265, "Unholy Presence"], [33891, "Tree of Life"],
];
const flagsChannel = (row) => {
  const ex = spell.int(row, "AttributesEx") >>> 0;
  return ((ex & 0x4) !== 0 || (ex & 0x40) !== 0 || (spell.int(row, "ChannelInterruptFlags") >>> 0) !== 0) ? "channel" : "cast";
};
for (const [id, note] of wanted) {
  const row = spellRow.get(id);
  if (row === undefined) { console.log(`${id} ${note}: not in this dataset`); continue; }
  const time = castTimes.get(spell.int(row, "CastingTimeIndex"));
  for (const element of [0, 1]) {
    const visualId = spell.int(row, "SpellVisualID", element);
    const v = visualById.get(visualId);
    if (visualId <= 0 || v === undefined) continue;
    const kit = (column) => describeKit(visual.int(v, column));
    console.log(`${id} ${spell.locstring(row, "Name_lang")} [${note}] ${flagsChannel(row)} cast ${time ?? "?"} ms, SpellVisual ${visualId}: precast ${kit("PrecastKit")} | cast ${kit("CastKit")} | channel ${kit("ChannelKit")} | impact ${kit("ImpactKit")} | state ${kit("StateKit")} | casterImpact ${kit("CasterImpactKit")} | targetImpact ${kit("TargetImpactKit")}`);
  }
}
