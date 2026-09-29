/** Combat command language: `/cast`/`/use` with an ID or a name, plus an optional `[@unit]`. */
import { game } from "../game/Context.js";
import { playerInventory } from "../Inventory.js";
import { worldObject } from "../../world/Fields.js";
import { castSpell } from "./Spellbook.js";
import { requestInventoryItemUse } from "../game/GroundTarget.js";
import { macroTargetUnit, stripShowtooltip } from "./MacroModel.js";
import { systemLine } from "./Chat.js";
import { hoveredUnitGuid } from "../game/HoverTarget.js";

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

/** Resolves `[@unit]` to a guid, or undefined for the current selection. */
export function macroUnitGuid(unit: string): bigint | undefined {
  const world = game.world;
  if (!world) return undefined;
  switch (unit) {
    case "target": return world.targetGuid;
    case "focus": return game.focusGuid;
    case "self":
    case "player": return world.state.selfGuid;
    case "pet": return world.petSpells?.guid;
    case "mouseover": return hoveredUnitGuid(world);
    default: return undefined;
  }
}

function splitCommand(line: string): { command: string; argument: string; unit?: string | undefined } | undefined {
  const clean = stripShowtooltip(line.trim());
  if (clean === undefined) return undefined;
  const target = macroTargetUnit(clean);
  const rest = (target?.rest ?? clean).trim();
  const match = rest.match(/^\/(cast|use)\s+(.+)$/i);
  if (!match) return undefined;
  return { command: match[1]!.toLowerCase(), argument: match[2]!.trim(), ...(target ? { unit: target.unit } : {}) };
}

export function runCastCommand(argument: string): void {
  const parsed = splitCommand(argument.startsWith("/") ? argument : `/cast ${argument}`);
  if (!parsed || parsed.command !== "cast" || !parsed.argument) {
    return systemLine("Использование: /cast [@цель] ID|Имя.");
  }
  const id = combatCommandId(parsed.argument) ?? spellIdByName(parsed.argument);
  if (id === undefined) return systemLine("Использование: /cast [@цель] ID|Имя — заклинание не найдено.");
  // A named target never changes the player's selection. Trinity reads the unit GUID from the
  // spell target block; changing selection here would also stop a running melee or ranged attack.
  let explicitUnitTarget: bigint | undefined;
  if (parsed.unit) {
    const guid = macroUnitGuid(parsed.unit);
    if (guid === undefined) return systemLine(`Нет цели для [@${parsed.unit}].`);
    const world = game.world;
    if (!world) return;
    const object = world.state.objects.get(guid);
    if (object?.typeId !== 3 && object?.typeId !== 4) {
      return systemLine(`Нет видимой цели для [@${parsed.unit}].`);
    }
    // [@target] can use the ordinary server-selection path, including spells that do not accept
    // an explicit unit. All other units require the DBC-derived contract for this exact spell.
    if (parsed.unit !== "target") {
      const metadata = game.spells.get(id);
      if (metadata?.unitTargetContractVersion !== 1 || metadata.supportsExplicitUnitTarget !== true) {
        return systemLine(`Заклинание ${id} не поддерживает [@${parsed.unit}].`);
      }
      explicitUnitTarget = guid;
    }
  }
  if (!castSpell(id, explicitUnitTarget)) systemLine("Заклинание сейчас недоступно: проверьте изучение, ресурс и восстановление.");
}

export function runUseCommand(argument: string): void {
  const parsed = splitCommand(argument.startsWith("/") ? argument : `/use ${argument}`);
  if (!parsed || parsed.command !== "use" || !parsed.argument) {
    return systemLine("Использование: /use ID|Имя.");
  }
  if (parsed.unit) return systemLine("Адресная цель [@...] для /use пока не поддерживается.");
  const world = game.world;
  if (!world) return;
  const inventory = playerInventory(world.state);
  const slots = [...(inventory?.equipment ?? []), ...(inventory?.backpack ?? []),
    ...(inventory?.bags ?? []).flatMap((bag) => bag.slots)];
  const id = combatCommandId(parsed.argument);
  const held = id !== undefined
    ? slots.find((slot) => slot.item !== undefined && worldObject.entry(slot.item) === id)
    : slots.find((slot) => {
      const entry = slot.item === undefined ? 0 : worldObject.entry(slot.item) ?? 0;
      const template = entry ? world.itemTemplate(entry) : undefined;
      return template?.name?.toLowerCase() === parsed.argument.toLowerCase();
    });
  if (!held) return systemLine("Такого предмета нет в экипировке или сумках.");
  requestInventoryItemUse(held, () => world.useItem(held.bag, held.slot, held.guid));
}
