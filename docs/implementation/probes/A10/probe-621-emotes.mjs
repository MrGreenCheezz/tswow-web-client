// A10 / 6.21 (read-only): a cross-check of Bodyflags bit 0x8 that does not depend on the M2 keys.
// Emotes.dbc says, per slash command, which AnimationData row it plays and carries EmoteFlags /
// EmoteSpecProc. If the client's own emote table separates "usable while moving" gestures from
// whole-body ones the way bit 0x8 does, that is independent support for the bit's meaning.
// Also: SpellVisualKit.Flags for the kits that name 0 against the rest.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const repo = process.cwd();
const load = (path) => import(pathToFileURL(resolve(repo, path)).href);
const { openDbcFile } = await load("tools/dbc.mjs");
const { dbcDirectory } = await load("tools/paths.mjs");
const directory = dbcDirectory();
const hex = (v) => `0x${(v >>> 0).toString(16)}`;

const anim = await openDbcFile(directory, "AnimationData");
const animRow = new Map();
for (const row of anim.rows()) animRow.set(anim.id(row), { name: anim.string(row, "Name"), body: anim.int(row, "Bodyflags") >>> 0, flags: anim.int(row, "Flags") >>> 0 });

const emotes = await openDbcFile(directory, "Emotes");
const byFlags = new Map();
for (const row of emotes.rows()) {
  const id = emotes.id(row);
  const command = emotes.string(row, "EmoteSlashCommand");
  const animId = emotes.int(row, "AnimID");
  const emoteFlags = emotes.int(row, "EmoteFlags") >>> 0;
  const proc = emotes.int(row, "EmoteSpecProc");
  const a = animRow.get(animId);
  const key = `EmoteFlags ${hex(emoteFlags)} proc ${proc} | anim body 0x8: ${a === undefined ? "n/a" : (a.body & 0x8) !== 0}`;
  const list = byFlags.get(key) ?? [];
  list.push(`${command || id}:${a?.name ?? animId}(${a === undefined ? "?" : hex(a.body)})`);
  byFlags.set(key, list);
}
console.log(`== Emotes.dbc: ${emotes.records} rows, cross-tab of EmoteFlags/EmoteSpecProc against AnimationData bit 0x8`);
for (const [key, list] of [...byFlags.entries()].sort()) console.log(`${key}  (${list.length}): ${list.join(" ").slice(0, 900)}`);

const kits = await openDbcFile(directory, "SpellVisualKit");
const kitFlags = new Map();
for (const row of kits.rows()) {
  const start = kits.int(row, "StartAnimID");
  const main = kits.int(row, "AnimID");
  const bucket = start === 0 || main === 0 ? "names 0" : start > 0 || main > 0 ? "names a pose" : "no pose";
  const key = `${bucket} | Flags ${hex(kits.int(row, "Flags"))}`;
  kitFlags.set(key, (kitFlags.get(key) ?? 0) + 1);
}
console.log("\n== SpellVisualKit.Flags by pose class");
for (const [key, n] of [...kitFlags.entries()].sort()) console.log(`${key}: ${n}`);

// The 0-kits that are the DK impact kits the handoff talks about: which spells hold them.
const spell = await openDbcFile(directory, "Spell");
const visual = await openDbcFile(directory, "SpellVisual");
const kitById = new Map();
for (const row of kits.rows()) kitById.set(kits.id(row), { start: kits.int(row, "StartAnimID"), main: kits.int(row, "AnimID") });
const visualById = new Map();
for (const row of visual.rows()) visualById.set(visual.id(row), row);
const stateKitZeroSpells = [];
for (const row of spell.rows()) {
  for (const element of [0, 1]) {
    const id = spell.int(row, "SpellVisualID", element);
    const vrow = visualById.get(id);
    if (vrow === undefined) continue;
    const kit = kitById.get(visual.int(vrow, "StateKit"));
    if (kit && (kit.start === 0 || kit.main === 0) && kit.start <= 0 && kit.main <= 0) {
      stateKitZeroSpells.push(`${spell.id(row)}:${spell.locstring(row, "Name_lang")}`);
    }
  }
}
console.log(`\nspells whose StateKit names 0 and nothing else as a pose: ${stateKitZeroSpells.length}; first 40: ${stateKitZeroSpells.slice(0, 40).join(" | ")}`);
