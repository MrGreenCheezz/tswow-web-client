import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { interfaceDirectory } from "./paths.mjs";
import { clientDataImplementationPath, ensureClientDataDirectory } from "./client-data.mjs";

/**
 * Emits the ignored local `src/generated/client-data/globalStrings.ts` implementation from the
 * user's configured `GlobalStrings.lua`. The tracked module is a data-free facade.
 *
 * Slice I10 needs the error text the server refers to by number and never sends: a cast refusal is
 * a `SpellCastResult` byte, an inventory refusal is an `InventoryResult` byte, and the words for
 * both live in the client's FrameXML. Writing those words by hand would be inventing a translation
 * for a game that already has one — nine hundred of them, in the very dataset this server runs.
 *
 * Every family taken here is keyed by an enum member's own name, so a lookup is
 * `SPELL_FAILED_${SpellCastResult[value]}` or `ITEM_MOD_${ItemModType[value]}` and nothing here has
 * to know what any particular number means. Anything else in that file is interface furniture —
 * button captions, tooltips for frames this client does not have — and is left where it is.
 *
 * Slice Л2 added the item families. An item tooltip contains many words the server never sends:
 * labels, slots, stats and resistances already written in the realm's own locale in this file.
 *
 * The Lua is read as text rather than executed: every line of interest is
 * `NAME = "text";`, with `\n` and `%s`-style placeholders left exactly as the client wrote them.
 *
 * The `SpellCastResult` and `ItemModType` member names come out of the core in the same pass,
 * because the lookups are `SPELL_FAILED_${name}` and `ITEM_MOD_${name}` and without them a client
 * holds a byte and a table it cannot join. They are read rather than transcribed for the usual
 * reason: the two enums have 188 and 43 members — the pair this run prints, and the 43 are the
 * rows of `ITEM_MOD_NAMES` — and a core upgrade that renumbers one would be invisible in a
 * hand-written list.
 */

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const outputPath = clientDataImplementationPath("globalStrings");
const checkOnly = process.argv.includes("--check");

/** The families a client needs to explain a refusal. Order decides the order in the output. */
const FAMILIES = [
  { prefix: "SPELL_FAILED_", what: "`SpellCastResult` in SharedDefines.h" },
  { prefix: "ERR_", what: "`InventoryResult` and the other `ERR_*` codes" },
  { prefix: "INT_SPELL_DURATION_", what: "the words a spell description's `$d` turns into" },
  { prefix: "ITEM_", what: "an item tooltip's own lines, the 99 `ITEM_MOD_*` among them" },
  { prefix: "INVTYPE_", what: "what an item is worn as, keyed by `InventoryType`'s member name" },
  { prefix: "RESISTANCE", what: "the six schools — and armour, which rides school zero" },
  { prefix: "EMPTY_SOCKET_", what: "a gem socket's colour" },
  // 4.10: the native key bindings window names a stock command as KeyBindingFrame does.
  { prefix: "BINDING_NAME_", what: "a key binding's name, keyed by its Bindings.xml command" },
];

/**
 * Strings a family cannot reach, taken by name.
 *
 * The four unit words a duration falls back to share no prefix with anything — they are simply
 * `DAYS`, `HOURS`, `MINUTES`, `SECONDS` — and a prefix wide enough to catch them would catch most
 * of the file. `SPELL_DURATION_SEC` and its neighbours are the sentence forms the tooltip uses
 * when the number is not on its own.
 *
 * The seven after them are the item tooltip's own templates, and they are equally prefixless:
 * `ARMOR_TEMPLATE` is «Броня: %d», `SPEED` is the one word beside a weapon's delay, and
 * `CONTAINER_SLOTS` is «%2$s (%1$d |4ячейка:ячейки:ячеек;)».
 */
const EXTRA_STRINGS = [
  "DAYS", "HOURS", "MINUTES", "SECONDS",
  "DAY_ONELETTER_ABBR", "HOUR_ONELETTER_ABBR", "MINUTE_ONELETTER_ABBR", "SECOND_ONELETTER_ABBR",
  "ARMOR_TEMPLATE", "CONTAINER_SLOTS", "DAMAGE_TEMPLATE", "DPS_TEMPLATE", "DURABILITY_TEMPLATE",
  "SELL_PRICE", "SPEED",
  // 1.32: the world layer's instance and zone messages (`src/world/WorldMessageTexts.ts`) — the
  // sentences UIParent.lua and ChatFrame.lua print for SMSG_RAID_INSTANCE_MESSAGE,
  // SMSG_INSTANCE_RESET(_FAILED) and SMSG_ZONE_UNDER_ATTACK — and the four unit words and the
  // delimiter `SecondsToTime(seconds, nil, 1)` builds a lock's remaining time from.
  "RAID_INSTANCE_WARNING_HOURS", "RAID_INSTANCE_WARNING_MIN", "RAID_INSTANCE_WARNING_MIN_SOON",
  "RAID_INSTANCE_WELCOME", "RAID_INSTANCE_EXPIRED",
  "INSTANCE_RESET_SUCCESS", "INSTANCE_RESET_FAILED", "INSTANCE_RESET_FAILED_OFFLINE", "INSTANCE_RESET_FAILED_ZONING",
  "ZONE_UNDER_ATTACK",
  "D_DAYS", "D_HOURS", "D_MINUTES", "D_SECONDS", "TIME_UNIT_DELIMITER",
  // 4.10: the micro buttons' names (the first argument of MicroButtonTooltipText in the stock
  // micro buttons' OnEnter), for ui/HudKeys.ts.
  "CHARACTER_BUTTON", "SPELLBOOK_ABILITIES_BUTTON", "TALENTS_BUTTON", "QUESTLOG_BUTTON", "SOCIAL_BUTTON",
  "WORLDMAP_BUTTON", "MAINMENU_BUTTON", "DUNGEONS_BUTTON",
  // 4.04: the native unit tooltip's level line, rank and PvP words, as Wow.exe's unit tooltip writer
  // (0x00621070) picks them, and the skinnable line's four words (ui/UnitTooltip.ts).
  "TOOLTIP_UNIT_LEVEL", "TOOLTIP_UNIT_LEVEL_CLASS", "TOOLTIP_UNIT_LEVEL_CLASS_TYPE",
  "TOOLTIP_UNIT_LEVEL_RACE_CLASS", "TOOLTIP_UNIT_LEVEL_RACE_CLASS_TYPE", "TOOLTIP_UNIT_LEVEL_TYPE",
  "ELITE", "BOSS", "PLAYER", "CORPSE", "PVP_ENABLED",
  "UNIT_SKINNABLE_LEATHER", "UNIT_SKINNABLE_HERB", "UNIT_SKINNABLE_ROCK", "UNIT_SKINNABLE_BOLTS",
  // 4.13: the stock CAMP and QUIT popups' countdown (ui/LogoutCountdown.ts).
  "CAMP_TIMER", "QUIT_TIMER",
  // 4.07: the auction house's bid and buyout questions (Blizzard_AuctionUI.lua:192-222).
  "BID_AUCTION_CONFIRMATION", "BUYOUT_AUCTION_CONFIRMATION",
  // 4.08: the nineteen equipment slots' names, for the equipment set's «ignore this slot» list.
  "HEADSLOT", "NECKSLOT", "SHOULDERSLOT", "SHIRTSLOT", "CHESTSLOT", "WAISTSLOT", "LEGSSLOT", "FEETSLOT",
  "WRISTSLOT", "HANDSSLOT", "FINGER0SLOT", "FINGER1SLOT", "TRINKET0SLOT", "TRINKET1SLOT", "BACKSLOT",
  "MAINHANDSLOT", "SECONDARYHANDSLOT", "RANGEDSLOT", "TABARDSLOT",
  // 4.14: the dungeon finder's waits as LFDFrame.lua writes them, with SecondsToTime's abbreviations.
  "DAYS_ABBR", "HOURS_ABBR", "MINUTES_ABBR", "SECONDS_ABBR", "LESS_THAN_ONE_MINUTE", "TIME_UNKNOWN",
  "TIME_IN_QUEUE", "LFG_STATISTIC_AVERAGE_WAIT",
  // 4.03: the native character sheet's rows and tooltips as PaperDollFrame.lua writes them
  // (ui/CharacterSheetModel.ts), the helm/cloak toggles, the title picker's «Нет» and the pet book tab.
  "PLAYERSTAT_BASE_STATS", "PLAYERSTAT_MELEE_COMBAT", "PLAYERSTAT_RANGED_COMBAT", "PLAYERSTAT_SPELL_COMBAT",
  "PLAYERSTAT_DEFENSES", "PAPERDOLLFRAME_TOOLTIP_FORMAT",
  "SPELL_STAT1_NAME", "SPELL_STAT2_NAME", "SPELL_STAT3_NAME", "SPELL_STAT4_NAME", "SPELL_STAT5_NAME",
  "COMBAT_RATING_NAME2", "COMBAT_RATING_NAME6", "COMBAT_RATING_NAME7", "COMBAT_RATING_NAME8",
  "COMBAT_RATING_NAME11", "COMBAT_RATING_NAME24",
  "DAMAGE", "WEAPON_SPEED", "ATTACK_SPEED", "ATTACK_POWER", "MELEE_ATTACK_POWER", "RANGED_ATTACK_POWER",
  "MELEE_ATTACK_POWER_TOOLTIP", "RANGED_ATTACK_POWER_TOOLTIP", "MELEE_CRIT_CHANCE", "RANGED_CRIT_CHANCE",
  "STAT_EXPERTISE", "CR_HASTE_RATING_TOOLTIP", "CR_HIT_MELEE_TOOLTIP", "CR_HIT_RANGED_TOOLTIP", "CR_HIT_SPELL_TOOLTIP",
  "CR_CRIT_MELEE_TOOLTIP", "CR_CRIT_RANGED_TOOLTIP", "CR_EXPERTISE_TOOLTIP", "CR_DODGE_TOOLTIP", "CR_PARRY_TOOLTIP",
  "CR_BLOCK_TOOLTIP", "BONUS_DAMAGE", "BONUS_HEALING", "BONUS_HEALING_TOOLTIP", "SPELL_CRIT_CHANCE", "SPELL_HASTE",
  "SPELL_HASTE_TOOLTIP", "MANA_REGEN", "MANA_REGEN_TOOLTIP", "NOT_APPLICABLE",
  "DAMAGE_SCHOOL2", "DAMAGE_SCHOOL3", "DAMAGE_SCHOOL4", "DAMAGE_SCHOOL5", "DAMAGE_SCHOOL6", "DAMAGE_SCHOOL7",
  "ARMOR", "DEFENSE", "DEFAULT_STATDEFENSE_TOOLTIP", "STAT_DODGE", "STAT_PARRY", "STAT_BLOCK", "STAT_RESILIENCE",
  "DODGE_CHANCE", "PARRY_CHANCE", "BLOCK_CHANCE", "SHOW_HELM", "SHOW_CLOAK", "NONE", "CURRENCY",
  "PET_TYPE_PET", "PET_TYPE_DEMON",
  // 4.03 review: the armour and resilience tooltips (PaperDollFrame_SetArmor / _SetResilience).
  "DEFAULT_STATARMOR_TOOLTIP", "PET_BONUS_TOOLTIP_ARMOR", "RESILIENCE_TOOLTIP",
  // 1.28 (L7): the native glyph socket's removal question, as StaticPopup's CONFIRM_REMOVE_GLYPH asks it.
  "CONFIRM_REMOVE_GLYPH",
  // 4.03 (L7): the pet's share in the stamina, intellect and ranged attack power rows (ComputePetBonus).
  "PET_BONUS_TOOLTIP_STAMINA", "PET_BONUS_TOOLTIP_INTELLECT", "PET_BONUS_TOOLTIP_RANGED_ATTACK_POWER",
  "PET_BONUS_TOOLTIP_SPELLDAMAGE",
];

// `NAME = "text";` with the text on one line. Escapes are kept verbatim: the client's own strings
// carry `\n` and `%s`, and both mean something to whoever prints them.
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/;

const coreDir = resolve(
  process.env.TRINITYCORE_DIR ?? join(projectRoot, "..", "tswow", "cores", "TrinityCore"),
);
const sharedDefinesPath = join(coreDir, "src", "server", "shared", "SharedDefines.h");
const itemTemplatePath = join(coreDir, "src", "server", "game", "Entities", "Item", "ItemTemplate.h");

const [source, sharedDefines, itemTemplate] = await Promise.all([
  readFile(join(interfaceDirectory(), "FrameXML", "GlobalStrings.lua"), "utf8"),
  readFile(sharedDefinesPath, "utf8"),
  readFile(itemTemplatePath, "utf8"),
]);

/** `SPELL_FAILED_NAME = 123,` inside `enum SpellCastResult`, in the core's own numbering. */
const castResults = new Map();
const enumStart = sharedDefines.indexOf("enum SpellCastResult");
if (enumStart < 0) throw new Error("SharedDefines.h has no SpellCastResult enum");
const enumBody = sharedDefines.slice(enumStart, sharedDefines.indexOf("};", enumStart));
for (const match of enumBody.matchAll(/^\s*SPELL_(?:FAILED|CAST_OK)_?([A-Z0-9_]*)\s*=\s*(-?\d+)/gm)) {
  const [, tail, value] = match;
  if (tail) castResults.set(Number(value), tail);
}
if (castResults.size === 0) throw new Error("SpellCastResult yielded no members");

/**
 * `ITEM_MOD_NAME = 12,` inside `enum ItemModType`, in the core's own numbering.
 *
 * The numbering is not dense — 2 and 8 to 11 do not exist, and 40 is commented out because it is
 * not in 3.3 — so a stat block's type has to be joined to a name rather than indexed by it. The
 * leading `\s*` is what drops the commented member: a `//` before the name means the line does not
 * match at all.
 */
const itemMods = new Map();
const modStart = itemTemplate.indexOf("enum ItemModType");
if (modStart < 0) throw new Error("ItemTemplate.h has no ItemModType enum");
const modBody = itemTemplate.slice(modStart, itemTemplate.indexOf("};", modStart));
for (const match of modBody.matchAll(/^\s*ITEM_MOD_([A-Z0-9_]+)\s*=\s*(\d+)/gm)) {
  const [, name, value] = match;
  itemMods.set(Number(value), name);
}
if (itemMods.size === 0) throw new Error("ItemModType yielded no members");

const found = new Map();
for (const line of source.split("\n")) {
  const match = ASSIGNMENT.exec(line.trim());
  if (!match) continue;
  const [, name, text] = match;
  if (!FAMILIES.some((family) => name.startsWith(family.prefix)) && !EXTRA_STRINGS.includes(name)) continue;
  // The file assigns a few names twice; the first wins, as it does in Lua load order.
  if (!found.has(name)) found.set(name, text);
}

if (found.size === 0) {
  throw new Error("GlobalStrings.lua yielded no SPELL_FAILED_ or ERR_ strings — the format changed");
}

const lines = [];
lines.push("// Generated by tools/generate-global-strings.mjs from the dataset's own");
lines.push("// Interface/FrameXML/GlobalStrings.lua. Do not edit by hand; run");
lines.push("// `npm run strings:generate`. This local implementation is ignored by Git.");
lines.push("//");
lines.push("// The server refers to a refusal by number and never sends the words for it. These are the");
lines.push("// words, in the realm's own locale, as the original client would have shown them.");
lines.push("");
lines.push("export const GLOBAL_STRING_DATA_AVAILABLE = true as const;");
lines.push("");
for (const family of FAMILIES) {
  const count = [...found.keys()].filter((name) => name.startsWith(family.prefix)).length;
  lines.push(`// ${family.prefix}*: ${count} strings — ${family.what}.`);
}
{
  const taken = EXTRA_STRINGS.filter((name) => found.has(name));
  lines.push(`// Taken by name: ${taken.join(", ")} —`);
  lines.push("// unit words a duration falls back to, the item tooltip's prefixless templates, and the");
  lines.push("// world layer's instance and zone messages with SecondsToTime's unit words.");
}
lines.push("");
lines.push("export const GLOBAL_STRINGS: Readonly<Record<string, string>> = {");
for (const family of FAMILIES) {
  const names = [...found.keys()].filter((name) => name.startsWith(family.prefix)).sort();
  for (const name of names) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(found.get(name))},`);
}
// The prefixless ones, which until slice Л2 were matched, counted and then dropped: the emitter
// walked only `FAMILIES`, so `DAYS` and its three neighbours were named in the header comment and
// absent from the table under it. Nothing noticed, because the only reader asks for them as a
// fallback behind `INT_SPELL_DURATION_*`, and all four of those are present.
for (const name of EXTRA_STRINGS) {
  if (found.has(name)) lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(found.get(name))},`);
}
lines.push("};");
lines.push("");
lines.push("/**");
lines.push(" * `SpellCastResult` by number, as the core numbers it.");
lines.push(" *");
lines.push(" * The value on the wire is a byte and the words for it are in the table above, keyed by");
lines.push(" * `SPELL_FAILED_` plus the member name — which is why the names are here rather than in a");
lines.push(" * comment somewhere.");
lines.push(" */");
lines.push("export const SPELL_CAST_RESULT_NAMES: Readonly<Record<number, string>> = {");
for (const value of [...castResults.keys()].sort((left, right) => left - right)) {
  lines.push(`  ${value}: ${JSON.stringify(castResults.get(value))},`);
}
lines.push("};");
lines.push("");
lines.push("/**");
lines.push(" * `ItemModType` by number, as the core numbers it.");
lines.push(" *");
lines.push(" * An item's stat block is pairs of `{type, value}` and the type is one of these; the words");
lines.push(" * are `ITEM_MOD_` plus the member name in the table above, with `_SHORT` after it for the");
lines.push(" * form that goes on a shared line. The numbering has holes, so this is a join, not an index.");
lines.push(" */");
lines.push("export const ITEM_MOD_NAMES: Readonly<Record<number, string>> = {");
for (const value of [...itemMods.keys()].sort((left, right) => left - right)) {
  lines.push(`  ${value}: ${JSON.stringify(itemMods.get(value))},`);
}
lines.push("};");
lines.push("");

const text = lines.join("\n");
const existing = await readFile(outputPath, "utf8").catch(() => "");
if (checkOnly) {
  if (existing !== text) {
    console.error("The ignored global-strings implementation is out of date; run `npm run strings:generate`");
    process.exit(1);
  }
  console.log(`The ignored global-strings implementation is up to date: ${found.size} strings, ${castResults.size} cast results, ${itemMods.size} stat types`);
} else {
  ensureClientDataDirectory();
  await writeFile(outputPath, text, "utf8");
  console.log(`Generated ignored client-data/globalStrings.ts: ${found.size} strings, ${castResults.size} cast results, ${itemMods.size} stat types`);
}
