/**
 * Combat command language: `/cast`/`/use` with an ID or a name, behind macro options — conditions
 * and a target, `/cast [mod:shift] Огненный шар; [@focus,help] Лечение; Ледяная стрела` — evaluated
 * by the evaluator the stock `SecureCmdOptionParse` uses (macro/MacroOptions.ts) against this
 * client's own world ({@link nativeMacroContext}).
 */
import { game } from "../game/Context.js";
import { playerInventory } from "../Inventory.js";
import { unit as unitField, worldObject } from "../../world/Fields.js";
import { castSpell } from "./Spellbook.js";
import { requestInventoryItemUse } from "../game/GroundTarget.js";
import { createMacroContext, evaluateMacroOptions, macroOptions } from "./MacroModel.js";
import type { MacroContext, MacroOptionResult } from "../macro/MacroOptions.js";
import { systemLine } from "./Chat.js";
import { hoveredUnitGuid } from "../game/HoverTarget.js";
import { reactionBetween } from "../game/Targeting.js";
import { currentBonusBarOffset } from "../game/BonusBar.js";

/** `GROUPTYPE_RAID` (Group.h). */
const GROUPTYPE_RAID = 0x02;

export function combatCommandId(argument: string): number | undefined {
  if (!/^[1-9]\d*$/.test(argument)) return undefined;
  const id = Number(argument);
  return Number.isSafeInteger(id) && id <= 0xffff_ffff ? id : undefined;
}

/** Resolves a spell name against the loaded spellbook metadata (case-insensitive). */
export function spellIdByName(name: string): number | undefined {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  const spells = (game as { spells?: Map<number, { name?: string }> }).spells;
  if (!spells) return undefined;
  for (const [id, metadata] of spells) {
    if (metadata.name?.toLowerCase() === wanted) return id;
  }
  return undefined;
}

/**
 * A macro unit token to a guid, or undefined when it names nobody: target, focus, self/player, pet,
 * mouseover, party1–4 (the listed members; the server never lists the player), raid1–40 (the
 * listed members, then the player, as the stock raid order has it), and any of them followed by
 * `target`s — that unit's own UNIT_FIELD_TARGET (`targettarget`, `focustarget`, `party1target`).
 */
export function macroUnitGuid(unit: string): bigint | undefined {
  const world = game.world;
  if (!world) return undefined;
  const token = unit.trim().toLowerCase();
  if (token.length > "target".length && token.endsWith("target")) {
    const owner = macroUnitGuid(token.slice(0, -"target".length));
    const object = owner === undefined ? undefined : world.state.objects.get(owner);
    const target = object ? unitField.target(object) : undefined;
    return target === undefined || target === 0n ? undefined : target;
  }
  switch (token) {
    case "target": return world.targetGuid;
    case "focus": return game.focusGuid;
    case "self":
    case "player": return world.state.selfGuid;
    case "pet": return world.petSpells?.guid;
    case "mouseover": return hoveredUnitGuid(world);
    default: break;
  }
  const group = world.group;
  const party = /^party([1-4])$/.exec(token);
  if (party) {
    if (!group || (group.groupType & GROUPTYPE_RAID) !== 0) return undefined;
    const self = world.state.selfGuid;
    return group.members.filter((member) => member.guid !== self)[Number(party[1]) - 1]?.guid;
  }
  // `partypetN`: the pet SMSG_PARTY_MEMBER_STATS names for that member (GROUP_UPDATE_PET_GUID).
  const partyPet = /^partypet([1-4])$/.exec(token);
  if (partyPet) {
    const member = macroUnitGuid(`party${partyPet[1]}`);
    const pet = member === undefined ? undefined : world.partyStats.get(member)?.petGuid;
    return pet === undefined || pet === 0n ? undefined : pet;
  }
  const raid = /^raid([1-9]\d?)$/.exec(token);
  if (raid && group && (group.groupType & GROUPTYPE_RAID) !== 0) {
    const index = Number(raid[1]) - 1;
    const listed = group.members[index];
    if (listed) return listed.guid;
    const self = world.state.selfGuid;
    return index === group.members.length && !group.members.some((member) => member.guid === self) ? self : undefined;
  }
  return undefined;
}

let nativeContext: MacroContext | undefined;

/**
 * Macro conditions over this client's own world (macro/MacroContext.ts): the units above, the
 * faction reaction, the page's held keys, the bonus bar the native bar shows. The action bar page is
 * the native bar's own state, which this module cannot read without importing the bar: `[actionbar]`
 * answers from the stock seam only.
 */
export function nativeMacroContext(): MacroContext {
  nativeContext ??= createMacroContext({
    world: () => game.world,
    unitGuid: macroUnitGuid,
    reaction: (self, other) => reactionBetween(self, other, game.factions),
    spell: (id) => game.spells.get(id),
    spellAbilities: (id) => game.talentData?.spellAbilitiesOf(id),
    // The rows resolved so far, as the stock seam's talentMetadataRevision counts them.
    spellRevision: () => (game.talentData?.revision ?? 0) * 1_000_000 + game.spells.size,
    familyName: (family) => game.talentData?.petFamilyName(family),
    bonusBar: () => currentBonusBarOffset(),
  });
  return nativeContext;
}

/** What follows `/cast` or `/use`, or the whole argument when it has no command in front. */
function commandOptions(argument: string, command: "cast" | "use"): string | undefined {
  const clean = argument.trim();
  if (!clean.startsWith("/")) return clean;
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(clean);
  return match && match[1]!.toLowerCase() === command ? (match[2] ?? "").trim() : undefined;
}

/** The native window's old form, a `[@unit]` after the name (`/cast Огненный шар [@focus]`), still names the target. */
function withTrailingTarget(chosen: MacroOptionResult): MacroOptionResult {
  if (chosen.target !== undefined) return chosen;
  const match = /^(.*?)\s*\[@([A-Za-z0-9]+)\]\s*(.*)$/.exec(chosen.text);
  return match ? { text: `${match[1] ?? ""} ${match[3] ?? ""}`.trim(), target: match[2]! } : chosen;
}

/**
 * The action and target the options choose now; undefined when no clause holds or it chose nothing —
 * no action this press, as in the client — or when the options cannot be read or are missing, which
 * says `usage`.
 */
function chooseAction(argument: string, command: "cast" | "use", usage: string): MacroOptionResult | undefined {
  const options = commandOptions(argument, command);
  const parsed = options === undefined ? undefined : macroOptions(options);
  if (!parsed || parsed.error !== undefined || options === "") {
    systemLine(parsed?.error ? `${usage} (${parsed.error})` : usage);
    return undefined;
  }
  const chosen = evaluateMacroOptions(parsed, nativeMacroContext());
  return chosen && chosen.text ? withTrailingTarget(chosen) : undefined;
}

export function runCastCommand(argument: string): void {
  const chosen = chooseAction(argument, "cast", "Использование: /cast [условия] ID|Имя; …");
  if (!chosen) return;
  // L18-review: `/cast !Auto Shot` — a leading "!" (passed on by the stock SLASH_CAST to CastSpellByName) means
  // "do not toggle it off": the name is looked up without it, and a spell already repeating is left to run.
  const bang = chosen.text.startsWith("!"); // L18-review
  const name = bang ? chosen.text.slice(1).trim() : chosen.text; // L18-review
  const id = combatCommandId(name) ?? spellIdByName(name); // L18-review: was chosen.text
  if (id === undefined) return systemLine("Использование: /cast [@цель] ID|Имя — заклинание не найдено.");
  if (bang && game.world?.autoRepeatSpellId === id) return; // L18-review
  // A named target never changes the player's selection. Trinity reads the unit GUID from the
  // spell target block; changing selection here would also stop a running melee or ranged attack.
  const unit = chosen.target?.toLowerCase();
  let explicitUnitTarget: bigint | undefined;
  if (unit !== undefined) {
    const guid = macroUnitGuid(unit);
    if (guid === undefined) return systemLine(`Нет цели для [@${unit}].`);
    const world = game.world;
    if (!world) return;
    const object = world.state.objects.get(guid);
    if (object?.typeId !== 3 && object?.typeId !== 4) {
      return systemLine(`Нет видимой цели для [@${unit}].`);
    }
    // [@target] can use the ordinary server-selection path, including spells that do not accept
    // an explicit unit. All other units require the DBC-derived contract for this exact spell.
    if (unit !== "target") {
      const metadata = game.spells.get(id);
      if (metadata?.unitTargetContractVersion !== 1 || metadata.supportsExplicitUnitTarget !== true) {
        return systemLine(`Заклинание ${id} не поддерживает [@${unit}].`);
      }
      explicitUnitTarget = guid;
    }
  }
  if (!castSpell(id, explicitUnitTarget)) systemLine("Заклинание сейчас недоступно: проверьте изучение, ресурс и восстановление.");
}

export function runUseCommand(argument: string): void {
  const chosen = chooseAction(argument, "use", "Использование: /use [условия] ID|Имя.");
  if (!chosen) return;
  if (chosen.target !== undefined) return systemLine("Адресная цель [@...] для /use пока не поддерживается.");
  const world = game.world;
  if (!world) return;
  const inventory = playerInventory(world.state);
  const slots = [...(inventory?.equipment ?? []), ...(inventory?.backpack ?? []),
    ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)];
  const id = combatCommandId(chosen.text);
  const held = id !== undefined
    ? slots.find((slot) => slot.item !== undefined && worldObject.entry(slot.item) === id)
    : slots.find((slot) => {
      const entry = slot.item === undefined ? 0 : worldObject.entry(slot.item) ?? 0;
      const template = entry ? world.itemTemplate(entry) : undefined;
      return template?.name?.toLowerCase() === chosen.text.toLowerCase();
    });
  if (!held) return systemLine("Такого предмета нет в экипировке или сумках.");
  requestInventoryItemUse(held, () => world.useItem(held.bag, held.slot, held.guid));
}
