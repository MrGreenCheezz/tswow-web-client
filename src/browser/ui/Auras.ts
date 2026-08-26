import { WorldClient } from "../../world/WorldClient.js";
import { game } from "../game/Context.js";
import { element, playerAuras, targetAuras } from "./Dom.js";
import { attachTooltip } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { spellTooltip } from "./Spellbook.js";
import { unknownLabel } from "./Format.js";

export const auraTimers: Array<{ aura: HTMLElement; label: HTMLElement; expiresAt: number }> = [];

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
    element.className = `aura-icon ${(aura.flags & 0x80) !== 0 ? "debuff" : "buff"}`;
    attachTooltip(element, () => spellTooltip(aura.spellId));
    element.setAttribute("aria-label", metadata?.name ?? unknownLabel("заклинание", aura.spellId));
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
  const ids = [...world.auras.values()].flatMap((auras) => [...auras.values()].map((aura) => aura.spellId));
  try {
    for (const [id, metadata] of await client.load(ids)) game.spells.set(id, metadata);
    if (game.world === world) showAuras();
  } catch (error) {
    console.warn("Aura metadata unavailable", error);
  }
}
