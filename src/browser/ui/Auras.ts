import { WorldClient } from "../../world/WorldClient.js";
import { AURA_FLAGS, type ActiveAura } from "../../world/AuraProtocol.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { game } from "../game/Context.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import { element, playerAuras, targetAuras } from "./Dom.js";
import { attachTooltip } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { spellTooltip } from "./Spellbook.js";
import { unknownLabel } from "./Format.js";

export const auraTimers: Array<{ aura: HTMLElement; label: HTMLElement; expiresAt: number }> = [];

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

/** Buff and debuff strips over the player and the target frames. */

export function showAuras(): void {
  const world = game.world;
  auraTimers.length = 0;
  renderAuraStrip(playerAuras, world?.aurasFor(world.state.selfGuid) ?? [], 24);
  const target = world?.targetGuid;
  renderAuraStrip(targetAuras, world?.aurasFor(target) ?? [], 16);
  targetAuras.hidden = target === undefined;
}

export function renderAuraStrip(container: HTMLElement, auras: ReturnType<WorldClient["aurasFor"]>, limit: number): void {
  const elements = auras.slice(0, limit).map((aura) => {
    const metadata = game.spells.get(aura.spellId);
    const element = document.createElement("div");
    const duration = document.createElement("span");
    const removable = container === playerAuras
      && isRemovablePlayerBuff(aura, metadata);
    element.className = `aura-icon ${(aura.flags & 0x80) !== 0 ? "debuff" : "buff"}`;
    attachTooltip(element, () => spellTooltip(aura.spellId));
    const label = metadata?.name ?? unknownLabel("заклинание", aura.spellId);
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

export async function loadAuraMetadata(world: WorldClient): Promise<void> {
  const client = game.spellMetadataClient;
  if (!client) return;
  const epoch = spellMetadataEpoch();
  if (!isCurrentSpellMetadataRequest(world, client, epoch)) return;
  const ids = [...world.auras.values()].flatMap((auras) => [...auras.values()].map((aura) => aura.spellId));
  try {
    const loaded = await client.load(ids);
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    for (const [id, metadata] of loaded) game.spells.set(id, metadata);
    syncMountSpellIds(world);
    if (game.world === world) showAuras();
  } catch (error) {
    if (!isCurrentSpellMetadataRequest(world, client, epoch)) {
      return;
    }
    syncMountSpellIds(world);
    console.warn("Aura metadata unavailable", error);
  }
}
