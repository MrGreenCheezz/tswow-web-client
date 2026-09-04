import { WorldClient } from "../../world/WorldClient.js";
import { AURA_FLAGS, type ActiveAura } from "../../world/AuraProtocol.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { game } from "../game/Context.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import { element, playerAuras, targetAuras } from "./Dom.js";
import { attachTooltip, type TooltipContent } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { spellTooltip } from "./Spellbook.js";
import { unitAuraAppearances } from "./WindowBindings.js";

export const auraTimers: Array<{ aura: HTMLElement; label: HTMLElement; expiresAt: number }> = [];

const AURA_METADATA_RETRY_DELAYS_MS = [250, 1_000] as const;
const auraMetadataRetries = new WeakMap<WorldClient, ReturnType<typeof setTimeout>>();

function clearAuraMetadataRetry(world: WorldClient): void {
  const timer = auraMetadataRetries.get(world);
  if (timer !== undefined) clearTimeout(timer);
  auraMetadataRetries.delete(world);
}

function scheduleAuraMetadataRetry(world: WorldClient, attempt: number): void {
  clearAuraMetadataRetry(world);
  const delay = AURA_METADATA_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) return;
  auraMetadataRetries.set(world, setTimeout(() => {
    auraMetadataRetries.delete(world);
    void loadAuraMetadata(world, attempt + 1);
  }, delay));
}

/** The class is published only after the FrameXML world mount has passed every ownership gate. */
const FRAMEXML_WORLD_REPLACEMENT_CLASS = "framexml-world-replaces-native";

function frameXmlOwnsPlayerAuras(): boolean {
  return document.body?.classList.contains(FRAMEXML_WORLD_REPLACEMENT_CLASS) === true;
}

/**
 * The core accepts CMSG_CANCEL_AURA only for a positive, non-passive aura on the player.
 * The caster does not have to be the player: Trinity removes the owned aura from the receiving
 * player without a caster filter. Unknown metadata must not become a speculative cancel control.
 */
export function isRemovablePlayerBuff(
  aura: Pick<ActiveAura, "flags">,
  metadata: Pick<SpellMetadata, "passive"> | undefined,
): boolean {
  if (metadata === undefined || metadata.passive) return false;
  const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
  const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
  return positive && !negative;
}

/**
 * Keep the display limit for actual client-visible auras, not for raw packet rows.  An unresolved
 * row remains visible until its metadata arrives (the existing honest fallback), while the
 * explicit client-hidden bit is authoritative and must never displace a legal passive or buff.
 */
export function visibleAuraEntries(
  auras: readonly ActiveAura[],
  limit: number,
  metadataFor: (spellId: number) => Pick<SpellMetadata, "hidden"> | undefined,
): ActiveAura[] {
  return auras.filter((aura) => metadataFor(aura.spellId)?.hidden !== true).slice(0, Math.max(0, limit));
}

/**
 * An aura packet arrives before the optional DBC lookup surprisingly often.  The spell id is an
 * implementation detail, not a useful name, so the temporary tooltip describes the effect's
 * relationship to the unit and the missing-data state without exposing that number.
 */
export function unresolvedAuraTooltip(aura: Pick<ActiveAura, "flags">): TooltipContent {
  const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
  const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
  return {
    title: negative ? "Неизвестный отрицательный эффект"
      : positive ? "Неизвестный положительный эффект" : "Неизвестный эффект",
    footer: ["Название, иконка и описание эффекта пока недоступны"],
  };
}

/** Buff and debuff strips over the player and the target frames. */

export function showAuras(): void {
  const world = game.world;
  auraTimers.length = 0;
  // The renderer's aura-derived appearance fallback rides the same tick as the strip, because it
  // answers the same question from the same two sources: which auras a unit carries, and what the
  // loaded metadata says they do. `loadAuraMetadata` calls this again when a batch lands, so a
  // stealth spell whose row had not arrived yet is picked up at that boundary — the same
  // batch-boundary refresh `syncMountSpellIds` relies on. `UNIT_FIELD_BYTES_1` byte 2 still wins
  // over anything published here; see `unitAppearance` in `world/Fields.ts`.
  game.renderer?.setUnitAuraAppearance(unitAuraAppearances());
  if (!frameXmlOwnsPlayerAuras()) {
    renderAuraStrip(playerAuras, world?.aurasFor(world.state.selfGuid) ?? [], 24);
  }
  const target = world?.targetGuid;
  renderAuraStrip(targetAuras, world?.aurasFor(target) ?? [], 16);
  targetAuras.hidden = target === undefined;
}

export function renderAuraStrip(container: HTMLElement, auras: ReturnType<WorldClient["aurasFor"]>, limit: number): void {
  const elements = visibleAuraEntries(auras, limit, (spellId) => game.spells.get(spellId)).map((aura) => {
    const metadata = game.spells.get(aura.spellId);
    const element = document.createElement("div");
    const duration = document.createElement("span");
    const removable = container === playerAuras
      && isRemovablePlayerBuff(aura, metadata);
    element.className = `aura-icon ${(aura.flags & 0x80) !== 0 ? "debuff" : "buff"}`;
    attachTooltip(element, () => metadata ? spellTooltip(aura.spellId) : unresolvedAuraTooltip(aura));
    const unresolved = metadata ? undefined : unresolvedAuraTooltip(aura);
    if (unresolved) element.dataset["metadataState"] = "unresolved";
    const label = metadata?.name ?? unresolved?.title ?? "Неизвестный эффект";
    element.setAttribute("aria-label", removable ? `${label}; нажмите правой кнопкой, чтобы снять` : label);
    if (removable) {
      element.classList.add("is-removable");
      element.setAttribute("role", "button");
      element.tabIndex = 0;
      const cancel = () => game.world?.cancelAura(aura.spellId);
      element.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        cancel();
      });
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        cancel();
      });
    }
    // No `hsl(id * 47)` backdrop: a random hue behind the icon fought the green and red borders
    // that carry the one thing the colour here has to say, buff against debuff.
    const iconUrl = spellIconUrl(metadata?.iconId ?? 0, game.gatewayOrigin);
    if (iconUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.addEventListener("error", () => image.remove(), { once: true });
      setIconSource(image, iconUrl);
      element.append(image);
    }
    if (aura.applications > 1) {
      const stacks = document.createElement("strong");
      stacks.textContent = String(aura.applications);
      element.append(stacks);
    }
    duration.className = "aura-duration";
    element.append(duration);
    if (aura.expiresAt !== undefined) auraTimers.push({ aura: element, label: duration, expiresAt: aura.expiresAt });
    return element;
  });
  container.replaceChildren(...elements);
}

export function updateAuraDurations(now: number): void {
  for (const timer of auraTimers) {
    const seconds = Math.max(0, (timer.expiresAt - now) / 1000);
    timer.aura.hidden = seconds <= 0;
    timer.label.textContent = seconds >= 3600 ? `${Math.ceil(seconds / 3600)}ч`
      : seconds >= 60 ? `${Math.ceil(seconds / 60)}м`
        : seconds >= 10 ? `${Math.ceil(seconds)}с`
          : seconds > 0 ? seconds.toFixed(1) : "";
  }
}

export async function loadAuraMetadata(world: WorldClient, attempt = 0): Promise<void> {
  const client = game.spellMetadataClient;
  if (!client) return;
  const epoch = spellMetadataEpoch();
  if (!isCurrentSpellMetadataRequest(world, client, epoch)) return;
  const ids = [...new Set([...world.auras.values()]
    .flatMap((auras) => [...auras.values()].map((aura) => aura.spellId)))];
  if (ids.length === 0) {
    clearAuraMetadataRetry(world);
    return;
  }
  try {
    const loaded = await client.load(ids);
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of loaded) game.spells.set(id, metadata);
    const unresolved = ids.some((id) => !game.spells.has(id));
    if (unresolved) scheduleAuraMetadataRetry(world, attempt);
    else clearAuraMetadataRetry(world);
    syncMountSpellIds(world);
    if (game.world === world) showAuras();
  } catch (error) {
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    scheduleAuraMetadataRetry(world, attempt);
    syncMountSpellIds(world);
    console.warn("Aura metadata unavailable", error);
  }
}
