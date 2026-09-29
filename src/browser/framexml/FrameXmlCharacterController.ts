import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import {
  adoptCharacterFramePortraitCanvas,
  adoptCharacterPortraitCanvas,
} from "../ui/Portraits.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import {
  FRAME_XML_MODEL_TYPES,
  type FrameXmlFrame,
} from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * The CharacterFrame subframes a host route may select. `PetPaperDollFrame` is the stock pet page
 * (PetPaperDollFrame.xml in the vertical; its C API is FrameXmlCompanions.ts), which stock
 * ToggleCharacter ignores while the character has no pet, companion or mount — the same three
 * answers make asking for it a no-op here (see `toggle`). `TokenFrame` is the load-on-demand
 * Blizzard_TokenUI's (FrameXmlTokenOwner.ts): until it has loaded it is an inert placeholder
 * (FrameXmlCharacterCompat.ts), and asking for it is likewise a no-op rather than a failure.
 */
export type FrameXmlCharacterSubFrame =
  "PaperDollFrame" | "PetPaperDollFrame" | "ReputationFrame" | "SkillFrame" | "TokenFrame";

/** The stock paperdoll's all-or-nothing ownership boundary. */
export interface FrameXmlCharacterOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
  /** Stock `ToggleCharacter(subFrame)`: open on that tab, switch to it, or close it when current. */
  showTab?(subFrame: FrameXmlCharacterSubFrame): void;
  dispose?(): void;
  onFailure?(): void;
}

let owner: FrameXmlCharacterOwner | undefined;

function closeAndDispose(current: FrameXmlCharacterOwner): void {
  try { current.hide(); } catch { /* teardown continues through the mount */ }
  try { current.dispose?.(); } catch { /* a stale VM must not block native fallback */ }
}

function demote(current: FrameXmlCharacterOwner): void {
  if (owner === current) owner = undefined;
  closeAndDispose(current);
  try { current.onFailure?.(); } catch { /* fail closed even if visual cleanup also failed */ }
}

function invoke(current: FrameXmlCharacterOwner, action: () => void): boolean {
  try {
    action();
    return true;
  } catch {
    demote(current);
    return false;
  }
}

/** Publish one gated stock owner and return an identity-safe, idempotent cleanup. */
export function publishFrameXmlCharacter(next: FrameXmlCharacterOwner): () => void {
  const previous = owner;
  if (previous && previous !== next) closeAndDispose(previous);
  owner = next;
  let cleaned = false;
  return (): void => {
    if (cleaned) return;
    cleaned = true;
    if (owner !== next) return;
    closeAndDispose(next);
    owner = undefined;
  };
}

export function frameXmlCharacterOpen(): boolean {
  const current = owner;
  if (!current) return false;
  try { return current.isOpen(); } catch { return false; }
}

/**
 * The C key and CharacterMicroButton. Both run stock `ToggleCharacter("PaperDollFrame")`
 * (Bindings.xml TOGGLECHARACTER0, MainMenuBarMicroButtons.xml), so an owner with pages opens on
 * the paper doll, switches to it from Reputation/Skills and closes only when it is already current.
 */
export function toggleFrameXmlCharacter(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => {
    if (current.showTab) current.showTab("PaperDollFrame");
    else if (current.isOpen()) current.hide();
    else current.show();
  });
}

export function closeFrameXmlCharacter(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.hide());
}

/**
 * Route a native shortcut for one character page (J → SkillFrame) to the stock tab. Returns false
 * when no stock owner is published, so the caller keeps its native fallback.
 */
export function toggleFrameXmlCharacterTab(subFrame: FrameXmlCharacterSubFrame): boolean {
  const current = owner;
  if (!current?.showTab) return false;
  return invoke(current, () => current.showTab!(subFrame));
}

type FrameXmlCharacterVm = Pick<FrameXmlBoot["vm"], "globalFunction" | "call" | "release">;
type FrameXmlCharacterBridge = Pick<FrameXmlBoot["bridge"],
  "getFrame" | "isVisible" | "Show" | "Hide" | "runInMutationBatch">;

/**
 * The class file token stock PaperDoll code needs, or undefined when `UnitClass("player")` has none.
 *
 * PaperDollFrame_SetStat runs `strupper(select(2, UnitClass("player")))` for every stat row after
 * the first (PaperDollFrame.lua:268-269), and VARIABLES_LOADED/ComputePetBonus do the same. A nil
 * token aborts UpdatePaperdollStats after «Сила» and prints «nil» in the level line — measured on the
 * canned route with UnitClass forced to nil for a TSWoW custom class. The real client never answers
 * nil for an existing player, so the owner below never opens the stock frame without a token.
 */
export function frameXmlPlayerClassToken(vm: FrameXmlCharacterVm): string | undefined {
  const unitClass = vm.globalFunction("UnitClass");
  if (!unitClass) return undefined;
  try {
    const [, token] = vm.call(unitClass, ["player"], 2);
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } finally {
    vm.release(unitClass);
  }
}

/** The first result of a stock global, or `absent` when the corpus does not define it. */
function stockValue(vm: FrameXmlCharacterVm, name: string, args: readonly unknown[], absent: unknown): unknown {
  const ref = vm.globalFunction(name);
  if (!ref) return absent;
  try { return vm.call(ref, args, 1)[0]; } finally { vm.release(ref); }
}

/** PetPaperDollFrame_UpdateIsAvailable's own condition: a pet, a critter or a mount (PetPaperDollFrame.lua:53). */
function petPageAvailable(vm: FrameXmlCharacterVm): boolean {
  if (stockValue(vm, "HasPetUI", [], false) === true) return true;
  return ["CRITTER", "MOUNT"].some((type) => Number(stockValue(vm, "GetNumCompanions", [type], 0)) > 0);
}

/**
 * The host owner for the stock CharacterFrame, driven through CharacterFrame.lua's own toggle.
 *
 * Showing CharacterFrame and PaperDollFrame directly left whichever subframe the player had last
 * selected visible and PanelTemplates' `selectedTab` on that tab: measured on the canned route,
 * «host show, click Tab3, host hide, host show» gave PaperDollFrame and ReputationFrame both shown
 * with tab 3 selected (and so disabled), and the next «Персонаж» click then *closed* the frame
 * because ToggleCharacter saw the paper doll as the current page. `ToggleCharacter(subFrame)` is
 * the one stock entry that sets the tab and hides every other subframe (CharacterFrame.lua:3-31).
 *
 * UIParent's ShowUIPanel owns the actual Show. Its refusals are stock behaviour, not failures: a
 * fullscreen panel (the world map hides UIParent) or a blocking center panel sends a left panel to
 * ShowUIPanelFailed (UIParent.lua:1327-1364), and C then does nothing, as in the real client. The
 * host used to fill in with its own Show there and demote the owner when the frame stayed invisible
 * under the hidden UIParent: measured on the canned route, C over the fullscreen map un-hid the
 * native character window on top of it and the stock frame was gone for the rest of the mount. So
 * every decision reads the shown flags (`IsShown`, what ToggleCharacter itself reads), not
 * visibility. Only when the panel manager accepts and still leaves the root hidden does the owner
 * complete the transition through the bridge; a frame that then fails to show demotes the owner
 * through the controller's demote-on-throw path. Lua errors inside OnShow handlers are reported by
 * the VM and do not demote it.
 *
 * The class token is checked when the frame opens, not once at publication: the mount can publish
 * before the player's own object has arrived (its wait times out after 5 s), and a one-time check
 * then kept the native sheet — and with it the native micro-button row — for the whole session.
 * Without the player there is nothing to draw and C stays a no-op; a player whose class has no
 * token (a TSWoW class the dataset does not name) demotes the owner, and the same press opens the
 * native sheet.
 */
export function createFrameXmlCharacterOwner(
  boot: { readonly vm: FrameXmlCharacterVm; readonly bridge: FrameXmlCharacterBridge },
  character: FrameXmlFrame,
  onFailure?: () => void,
): FrameXmlCharacterOwner {
  const callStock = (name: string, args: readonly unknown[]): void => {
    const ref = boot.vm.globalFunction(name);
    if (!ref) throw new Error(`CharacterFrame ${name} is unavailable`);
    try { boot.vm.call(ref, args, 0); } finally { boot.vm.release(ref); }
  };
  /** ShowUIPanel's own refusal for a left panel: a fullscreen panel, or a blocking center one. */
  const panelsRefused = (): boolean => boot.bridge.getFrame("UIParent")?.visible === false
    || !stockValue(boot.vm, "CanOpenPanels", [], 1);
  /** False while the player's own object is absent; throws for a player the paper doll cannot draw. */
  const playerDrawable = (): boolean => {
    if (frameXmlPlayerClassToken(boot.vm)) return true;
    if (!stockValue(boot.vm, "UnitExists", ["player"], undefined)) {
      console.warn('[framexml] CharacterFrame: the player has not arrived yet; not opened');
      return false;
    }
    throw new Error('UnitClass("player") has no class token; the stock paper doll cannot draw it');
  };
  const toggle = (name: FrameXmlCharacterSubFrame): void => {
    const target = boot.bridge.getFrame(name);
    // Stock ToggleCharacter ignores a subframe whose `hidden` placeholder stands in for an add-on
    // not loaded yet (CharacterFrame.lua:4-6): the currency tab before Blizzard_TokenUI, or after
    // its gate failed. The paper doll stays the owner's.
    if (!target && name === "TokenFrame") return;
    if (!target || target.parent !== character) throw new Error(`CharacterFrame has no ${name}`);
    // Stock ToggleCharacter also ignores the pet page while PetPaperDollFrame_UpdateIsAvailable has
    // marked it `hidden` — no pet, no companion, no mount (PetPaperDollFrame.lua:52-66) — and the
    // owner reads the same three answers rather than the Lua field it sets.
    if (name === "PetPaperDollFrame" && !petPageAvailable(boot.vm)) return;
    const selected = character.visible && target.visible;
    if (!character.visible && !playerDrawable()) return;
    let refused = false;
    boot.bridge.runInMutationBatch(() => {
      callStock("ToggleCharacter", [name]);
      if (selected) {
        // Stock closes the frame when its current page is asked for again (HideUIPanel).
        if (character.visible) boot.bridge.Hide(character);
        return;
      }
      if (character.visible) return;
      refused = panelsRefused();
      if (refused) return;
      boot.bridge.Show(character);
      callStock("CharacterFrame_ShowSubFrame", [name]);
    });
    if (!selected && !refused && (!character.visible || !target.visible)) {
      throw new Error(`stock ToggleCharacter did not show ${name}`);
    }
  };
  return {
    isOpen: () => boot.bridge.isVisible(character),
    show: () => { if (!character.visible) toggle("PaperDollFrame"); },
    showTab: toggle,
    hide: () => {
      if (!character.visible) return;
      boot.bridge.runInMutationBatch(() => {
        // HideUIPanel releases UIParent's left panel slot that ShowUIPanel took.
        const hide = boot.vm.globalFunction("HideUIPanel");
        if (hide) {
          try { boot.vm.call(hide, [character], 0); } finally { boot.vm.release(hide); }
        }
        if (character.visible) boot.bridge.Hide(character);
      });
    },
    ...(onFailure ? { onFailure } : {}),
  };
}

const EQUIPMENT_SLOT_NAMES = [
  "CharacterHeadSlot", "CharacterNeckSlot", "CharacterShoulderSlot", "CharacterBackSlot",
  "CharacterChestSlot", "CharacterShirtSlot", "CharacterTabardSlot", "CharacterWristSlot",
  "CharacterHandsSlot", "CharacterWaistSlot", "CharacterLegsSlot", "CharacterFeetSlot",
  "CharacterFinger0Slot", "CharacterFinger1Slot", "CharacterTrinket0Slot",
  "CharacterTrinket1Slot", "CharacterMainHandSlot", "CharacterSecondaryHandSlot",
  "CharacterRangedSlot",
] as const;

const STAT_FRAME_NAMES = [
  "PlayerStatFrameLeft1", "PlayerStatFrameLeft2", "PlayerStatFrameLeft3",
  "PlayerStatFrameLeft4", "PlayerStatFrameLeft5", "PlayerStatFrameLeft6",
  "PlayerStatFrameRight1", "PlayerStatFrameRight2", "PlayerStatFrameRight3",
  "PlayerStatFrameRight4", "PlayerStatFrameRight5", "PlayerStatFrameRight6",
] as const;

export interface FrameXmlCharacterModelGate {
  readonly character: FrameXmlFrame;
  readonly paperDoll: FrameXmlFrame;
  readonly model: FrameXmlFrame;
  readonly modelElement: HTMLElement;
  readonly portraitCleanup: () => void;
}

/** Reuses the composed cleanup when the host probes the same mounted stock owner more than once. */
let activeModelGate: FrameXmlCharacterModelGate | undefined;

function frameDescendsFrom(frame: FrameXmlFrame, ancestor: FrameXmlFrame): boolean {
  let current: FrameXmlFrame | undefined = frame;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function elementDescendsFrom(element: HTMLElement, ancestor: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentElement;
  }
  return false;
}

function renderedFrameElement(
  element: HTMLElement | undefined,
  frame: FrameXmlFrame,
): element is HTMLElement {
  return !!element
    && element.getAttribute("data-framexml-name") === frame.name
    && element.getAttribute("data-framexml-type") === frame.type;
}

function hasAnyScript(boot: FrameXmlBoot, frame: FrameXmlFrame, scripts: readonly string[]): boolean {
  return scripts.some((script) => boot.bridge.hasScript(frame, script));
}

/**
 * Structural and model gate for the stock CharacterFrame/PaperDollFrame.
 *
 * The stock panel is published only when its actual model box, inherited equipment handlers and
 * stat rows are present. The canvas is then adopted into that model box; any missing dependency
 * leaves the native character sheet untouched.
 */
export function frameXmlCharacterModelGate(
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  onUnavailable?: (reason: string) => void,
): FrameXmlCharacterModelGate | undefined {
  const unavailable = (reason: string): undefined => { onUnavailable?.(reason); return undefined; };
  try {
    const character = boot.bridge.getFrame("CharacterFrame");
    const paperDoll = boot.bridge.getFrame("PaperDollFrame");
    const model = boot.bridge.getFrame("CharacterModelFrame");
    if (!character || character.type !== "Frame"
      || !paperDoll || paperDoll.type !== "Frame" || paperDoll.parent !== character
      || !model || !FRAME_XML_MODEL_TYPES.has(model.type) || !frameDescendsFrom(model, paperDoll)) {
      return unavailable("CharacterFrame/PaperDollFrame/CharacterModelFrame hierarchy");
    }

    const characterElement = renderer.elementFor(character);
    const paperDollElement = renderer.elementFor(paperDoll);
    const modelElement = renderer.elementFor(model);
    const portrait = boot.bridge.getFrame("CharacterFramePortrait");
    const portraitElement = portrait ? renderer.elementFor(portrait) : undefined;
    if (!renderedFrameElement(characterElement, character)
      || !renderedFrameElement(paperDollElement, paperDoll)
      || !renderedFrameElement(modelElement, model)
      || !elementDescendsFrom(modelElement, paperDollElement)
      // CharacterFramePortrait is a stock Texture owner.  Do not adopt an arbitrary element or
      // create a replacement icon when the authored owner was omitted/mis-parented.
      || !portrait || portrait.type !== "Texture" || !frameDescendsFrom(portrait, character)
      || !renderedFrameElement(portraitElement, portrait)
      || !elementDescendsFrom(portraitElement, characterElement)) return unavailable("Character model/portrait rendered hierarchy");

    const paperScripts = ["OnLoad", "OnEvent", "OnShow", "OnHide"] as const;
    if (!paperScripts.every((script) => boot.bridge.hasScript(paperDoll, script))) return unavailable("PaperDollFrame lifecycle scripts");

    for (const name of EQUIPMENT_SLOT_NAMES) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || frame.type !== "Button" || !frameDescendsFrom(frame, paperDoll)
        || !renderedFrameElement(element, frame) || !elementDescendsFrom(element, paperDollElement)
        || !hasAnyScript(boot, frame, ["OnLoad", "OnEvent", "OnClick"])) return unavailable(`${name} equipment widget`);
    }

    const attributes = boot.bridge.getFrame("CharacterAttributesFrame");
    const attributesElement = attributes ? renderer.elementFor(attributes) : undefined;
    if (!attributes || attributes.type !== "Frame" || !frameDescendsFrom(attributes, paperDoll)
      || !renderedFrameElement(attributesElement, attributes)
      || !elementDescendsFrom(attributesElement, paperDollElement)) return unavailable("CharacterAttributesFrame rendered hierarchy");
    for (const name of STAT_FRAME_NAMES) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || frame.type !== "Frame" || !frameDescendsFrom(frame, attributes)
        || !renderedFrameElement(element, frame) || !elementDescendsFrom(element, attributesElement)
        || !boot.bridge.hasScript(frame, "OnEnter") || !boot.bridge.hasScript(frame, "OnLeave")) {
        return unavailable(`${name} stat widget or hover scripts`);
      }
    }

    if (activeModelGate
      && activeModelGate.character === character
      && activeModelGate.paperDoll === paperDoll
      && activeModelGate.model === model
      && activeModelGate.modelElement === modelElement) {
      return activeModelGate;
    }
    activeModelGate?.portraitCleanup();

    const measured = typeof (renderer as FrameXmlDomRenderer & {
      measure?: (frame: FrameXmlFrame) => { width: number; height: number } | undefined;
    }).measure === "function"
      ? renderer.measure(model)
      : undefined;
    const modelAttributes = (model as FrameXmlFrame & {
      attributes?: Readonly<Record<string, string>>;
    }).attributes;
    const declaredWidth = Number(modelAttributes?.["width"]);
    const declaredHeight = Number(modelAttributes?.["height"]);
    // Both outputs are drawn only while stock IsVisible holds for their frame: with CharacterFrame
    // closed a look change rebuilds neither (PortraitRenderer's hidden targets), and opening it
    // repaints each once. The bridge's own flags, so a hidden UIParent (the full-screen map) counts.
    const portraitCleanup = adoptCharacterPortraitCanvas(
      modelElement,
      measured && measured.width > 0 ? measured.width
        : Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth : undefined,
      measured && measured.height > 0 ? measured.height
        : Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight : undefined,
      () => boot.bridge.isVisible(model),
    );
    if (!portraitCleanup) return unavailable("CharacterModelFrame portrait canvas adoption");
    let characterPortraitCleanup: (() => void) | undefined;
    try {
      characterPortraitCleanup = adoptCharacterFramePortraitCanvas(portraitElement,
        () => boot.bridge.isVisible(portrait));
    } catch (error) {
      portraitCleanup();
      throw error;
    }
    if (!characterPortraitCleanup) {
      portraitCleanup();
      return unavailable("CharacterFramePortrait canvas adoption");
    }
    let gate: FrameXmlCharacterModelGate;
    const cleanup = (): void => {
      characterPortraitCleanup();
      portraitCleanup();
      if (activeModelGate === gate) activeModelGate = undefined;
    };
    gate = { character, paperDoll, model, modelElement, portraitCleanup: cleanup };
    activeModelGate = gate;
    return gate;
  } catch (error) {
    return unavailable(String(error));
  }
}

/** Friendly alias for callers that name the resulting 2D canvas/model bridge directly. */
export const frameXmlCharacterGate = frameXmlCharacterModelGate;
