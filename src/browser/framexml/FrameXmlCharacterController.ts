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

/** The stock paperdoll's all-or-nothing ownership boundary. */
export interface FrameXmlCharacterOwner {
  isOpen(): boolean;
  show(): void;
  hide(): void;
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

export function toggleFrameXmlCharacter(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => {
    if (current.isOpen()) current.hide();
    else current.show();
  });
}

export function closeFrameXmlCharacter(): boolean {
  const current = owner;
  if (!current) return false;
  return invoke(current, () => current.hide());
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
): FrameXmlCharacterModelGate | undefined {
  try {
    const character = boot.bridge.getFrame("CharacterFrame");
    const paperDoll = boot.bridge.getFrame("PaperDollFrame");
    const model = boot.bridge.getFrame("CharacterModelFrame");
    if (!character || character.type !== "Frame"
      || !paperDoll || paperDoll.type !== "Frame" || paperDoll.parent !== character
      || !model || !FRAME_XML_MODEL_TYPES.has(model.type) || !frameDescendsFrom(model, paperDoll)) {
      return undefined;
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
      || !elementDescendsFrom(portraitElement, characterElement)) return undefined;

    const paperScripts = ["OnLoad", "OnEvent", "OnShow", "OnHide"] as const;
    if (!paperScripts.every((script) => boot.bridge.hasScript(paperDoll, script))) return undefined;

    for (const name of EQUIPMENT_SLOT_NAMES) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || frame.type !== "Button" || !frameDescendsFrom(frame, paperDoll)
        || !renderedFrameElement(element, frame) || !elementDescendsFrom(element, paperDollElement)
        || !hasAnyScript(boot, frame, ["OnLoad", "OnEvent", "OnClick"])) return undefined;
    }

    const attributes = boot.bridge.getFrame("CharacterAttributesFrame");
    const attributesElement = attributes ? renderer.elementFor(attributes) : undefined;
    if (!attributes || attributes.type !== "Frame" || !frameDescendsFrom(attributes, paperDoll)
      || !renderedFrameElement(attributesElement, attributes)
      || !elementDescendsFrom(attributesElement, paperDollElement)) return undefined;
    for (const name of STAT_FRAME_NAMES) {
      const frame = boot.bridge.getFrame(name);
      const element = frame ? renderer.elementFor(frame) : undefined;
      if (!frame || frame.type !== "Frame" || !frameDescendsFrom(frame, attributes)
        || !renderedFrameElement(element, frame) || !elementDescendsFrom(element, attributesElement)
        || !boot.bridge.hasScript(frame, "OnEnter") || !boot.bridge.hasScript(frame, "OnLeave")) {
        return undefined;
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
    const portraitCleanup = adoptCharacterPortraitCanvas(
      modelElement,
      measured && measured.width > 0 ? measured.width
        : Number.isFinite(declaredWidth) && declaredWidth > 0 ? declaredWidth : undefined,
      measured && measured.height > 0 ? measured.height
        : Number.isFinite(declaredHeight) && declaredHeight > 0 ? declaredHeight : undefined,
    );
    if (!portraitCleanup) return undefined;
    let characterPortraitCleanup: (() => void) | undefined;
    try {
      characterPortraitCleanup = adoptCharacterFramePortraitCanvas(portraitElement);
    } catch (error) {
      portraitCleanup();
      throw error;
    }
    if (!characterPortraitCleanup) {
      portraitCleanup();
      return undefined;
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
  } catch {
    return undefined;
  }
}

/** Friendly alias for callers that name the resulting 2D canvas/model bridge directly. */
export const frameXmlCharacterGate = frameXmlCharacterModelGate;
