import { WorldClient } from "../../world/WorldClient.js";
import { AURA_FLAGS, type ActiveAura } from "../../world/AuraProtocol.js";
import type { SpellMetadata } from "../../gateway/SpellMetadata.js";
import { game } from "../game/Context.js";
import { syncMountSpellIds } from "../MountSpells.js";
import { isCurrentSpellMetadataRequest, spellMetadataEpoch } from "./SpellNames.js";
import { element, playerAuras, targetAuras } from "./Dom.js";
import { attachTooltip, type TooltipContent, type TooltipLine } from "./Widgets.js";
import { setIconSource, spellIconUrl } from "./IconImage.js";
import { spellTooltip } from "./Spellbook.js";
import { unitAuraAppearances } from "./WindowBindings.js";
import { NATIVE_LANES_REPLACED, NATIVE_TARGET_CONTEXT_REPLACED, nativeHudReplaced } from "./NativeHudReplacement.js";
import { debuffTypeBorder } from "./DebuffType.js";

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
function frameXmlOwnsPlayerAuras(): boolean {
  return nativeHudReplaced(NATIVE_LANES_REPLACED);
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

function formatAuraDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds >= 3600) return `${Math.ceil(seconds / 3600)} ч`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} мин`;
  if (seconds >= 10) return `${Math.ceil(seconds)} с`;
  return seconds > 0 ? `${seconds.toFixed(1).replace(".", ",")} с` : "";
}

/**
 * A buff/debuff tooltip: the spell's own lines plus the aura context the book cannot know.
 *
 * The spell tooltip stays shared and monochrome for the book; the colour lives here, on the
 * strip, where buff-against-debuff, stacks and the cancel hint are the informative part. Tones
 * reuse the item-tooltip vocabulary (`stat` green, `unmet` red, `gold`, `muted`).
 */
export function auraTooltip(
  aura: Pick<ActiveAura, "flags" | "spellId" | "applications" | "casterGuid" | "maxDuration">,
  metadata: Pick<SpellMetadata, "passive"> | undefined,
  removable: boolean,
): TooltipContent {
  const base = spellTooltip(aura.spellId);
  const negative = (aura.flags & AURA_FLAGS.negative) !== 0;
  const positive = (aura.flags & AURA_FLAGS.positive) !== 0;
  const head: Array<string | TooltipLine> = [];
  if (negative) head.push({ text: "Отрицательный эффект", tone: "unmet" });
  else if (positive) head.push({ text: "Положительный эффект", tone: "stat" });
  if (aura.applications > 1) head.push({ text: `Стаки: ${aura.applications}`, tone: "gold" });
  if (aura.maxDuration !== undefined && aura.maxDuration > 0) {
    const duration = formatAuraDuration(aura.maxDuration);
    if (duration) head.push({ text: `Длительность: ${duration}`, tone: "muted" });
  }
  const self = game.world?.state.selfGuid;
  if (aura.casterGuid !== undefined && self !== undefined && aura.casterGuid === self) {
    head.push({ text: "Наложено вами", tone: "muted" });
  }
  if (removable) head.push({ text: "Правый клик — снять эффект", tone: "muted" });
  return { title: base.title, lines: [...head, ...(base.lines ?? [])], footer: base.footer };
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
    showAuraStrip(playerAuras, world?.aurasFor(world.state.selfGuid) ?? [], 24);
  }
  const target = world?.targetGuid;
  showAuraStrip(targetAuras, world?.aurasFor(target) ?? [], 16);
  const targetHidden = target === undefined;
  if (targetAuras.hidden !== targetHidden) targetAuras.hidden = targetHidden;
}

/** What a strip was last drawn from, by identity, and what drawing it produced. */
interface DrawnAuraStrip {
  readonly origin: string | undefined;
  /** Each visible aura followed by the metadata row it was drawn with, in strip order. */
  readonly inputs: readonly unknown[];
  readonly elements: readonly Element[];
  readonly timers: typeof auraTimers;
}

const drawnAuraStrips = new WeakMap<HTMLElement, DrawnAuraStrip>();

/**
 * `renderAuraStrip`, skipped when it would draw exactly what is already there.
 *
 * Every input of a strip is an identity: an aura object is replaced whenever its slot changes
 * (`applyAuraUpdate`), a metadata row whenever it is fetched, and the gateway origin names the icon
 * route. When all of them — and the elements on screen — are the ones last drawn, the rebuild would
 * produce the same icons, so the old ones stay (with their duration timers). A crowd's aura packets
 * and every metadata batch landing call `showAuras`; only the player's and the target's own changes
 * now touch these strips.
 */
function showAuraStrip(container: HTMLElement, auras: ReturnType<WorldClient["aurasFor"]>, limit: number): void {
  const inputs = visibleAuraEntries(auras, limit, (spellId) => game.spells.get(spellId))
    .flatMap((aura) => [aura, game.spells.get(aura.spellId)]);
  const drawn = drawnAuraStrips.get(container);
  if (drawn && drawn.origin === game.gatewayOrigin && sameIdentities(drawn.inputs, inputs)
    && sameIdentities(drawn.elements, [...container.children])) {
    auraTimers.push(...drawn.timers);
    return;
  }
  const first = auraTimers.length;
  renderAuraStrip(container, auras, limit);
  drawnAuraStrips.set(container, {
    origin: game.gatewayOrigin, inputs, elements: [...container.children], timers: auraTimers.slice(first),
  });
}

function sameIdentities(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

export function renderAuraStrip(container: HTMLElement, auras: ReturnType<WorldClient["aurasFor"]>, limit: number): void {
  const elements = visibleAuraEntries(auras, limit, (spellId) => game.spells.get(spellId)).map((aura) => {
    const metadata = game.spells.get(aura.spellId);
    const element = document.createElement("div");
    const duration = document.createElement("span");
    const removable = container === playerAuras
      && isRemovablePlayerBuff(aura, metadata);
    element.className = `aura-icon ${(aura.flags & 0x80) !== 0 ? "debuff" : "buff"}`;
    // 5.20: a debuff's border in the stock DebuffTypeColor of its dispel type (debuffTypeBorder).
    const typeColor = (aura.flags & 0x80) !== 0 ? debuffTypeBorder(metadata?.debuffType) : undefined;
    if (typeColor) {
      element.style.borderColor = typeColor;
      element.dataset["debuffType"] = metadata?.debuffType ?? "";
    }
    attachTooltip(element, () => metadata ? auraTooltip(aura, metadata, removable) : unresolvedAuraTooltip(aura));
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
  // The strips' countdowns are drawn for nobody while both native strips are behind stock owners:
  // the player strip under BuffFrame (not even built then), the target strip under TargetFrame's
  // aura rows. The next frame after either is handed back counts down from the world's clock again.
  if (frameXmlOwnsPlayerAuras() && nativeHudReplaced(NATIVE_TARGET_CONTEXT_REPLACED)) return;
  for (const timer of auraTimers) {
    const seconds = Math.max(0, (timer.expiresAt - now) / 1000);
    const hidden = seconds <= 0;
    if (timer.aura.hidden !== hidden) timer.aura.hidden = hidden;
    // `toFixed(1)` allocates a new string 60 times a second per aura; the visible tenth changes
    // at most 10 times a second, so only touch the label when its text actually moved.
    const label = seconds >= 3600 ? `${Math.ceil(seconds / 3600)}ч`
      : seconds >= 60 ? `${Math.ceil(seconds / 60)}м`
        : seconds >= 10 ? `${Math.ceil(seconds)}с`
          : seconds > 0 ? seconds.toFixed(1) : "";
    if (timer.label.textContent !== label) timer.label.textContent = label;
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
    // An id the gateway has answered "no row" for is settled (`SpellMetadataClient.answered`): a
    // retry would ask nobody and redraw the same strip. A client double without the method (the
    // tests' `{ load }`) keeps the old rule.
    const settled = typeof client.answered === "function" ? (id: number) => client.answered(id) : () => false;
    const unresolved = ids.some((id) => !game.spells.has(id) && !settled(id));
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
