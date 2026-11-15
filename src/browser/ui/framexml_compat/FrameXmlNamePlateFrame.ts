/**
 * plates12 (15.11, plan items 6.37 and 3.21): one name plate as Wow.exe 3.3.5a (12340) builds it — a real, unnamed
 * `Frame` under `WorldFrame` with the regions and the two status bars an add-on finds there.
 *
 * Read-only Ghidra, `.runtime/re-2026-11-15/plates12/` (d1.c … d4.c, l3.txt, l4.txt); behaviour described, no code
 * copied. Checked against the stand's recording `F:\WowOracle\runs\plates-probe3.txt` (every region of every plate read
 * through Lua on the real client, 03.11).
 *
 * The constructor (CGNamePlateFrame, 0x0098f790) makes, in this order — the order `GetRegions()` answers:
 *  1. the threat flash, BACKGROUND, `UI-TargetingFrame-Flash`, 172.316 × 45.429, TOP on the plate's TOP (−1.57,
 *     −10.18), cut (0, 0.555, 0.53, 0.6), hidden;
 *  2. the border, ARTWORK, `Nameplate-Border`, all points on the plate;
 *  -  the health bar (CGSimpleHealthBar, a StatusBar child), `UI-TargetingFrame-BarFill`, one level under the plate;
 *  3. the cast border, ARTWORK, `Nameplate-Border` turned round (1, 0, 0, 1), hidden;
 *  4. the cast shield, ARTWORK, `Nameplate-CastBar-Shield`, hidden;
 *  -  the cast bar (CSimpleStatusBar), `UI-TargetingFrame-BarFill`, one level under the plate, hidden;
 *  5. the spell icon, OVERLAY, 15.665 square, no picture, hidden;
 *  6. the glow, HIGHLIGHT, `Nameplate-Glow`, added (ADD), all points on the plate, hidden;
 *  7. the name, a FontString in NAMEPLATE_FONT at 15.665, shadow (1.567, −1.567) black, BOTTOM on the plate's CENTER;
 *  8. the level, a FontString in NAMEPLATE_FONT at 14.099, the same shadow;
 *  9. the skull, OVERLAY, `UI-TargetingFrame-Skull`, 15.665 square, CENTER on the level's CENTER;
 * 10. the raid mark, ARTWORK, `UI-RaidTargetingIcons`, 31.33 square, RIGHT on the border's LEFT;
 * 11. the dragon, BORDER, `EliteNameplateIcon`, 46.055 × 33.68, CENTER on the level's CENTER (4.70, −1.57), cut
 *     (0, 0.578125, 0, 0.84375).
 *
 * Attaching a plate to a unit (0x0098f390, every time one is taken for a unit, a reused one included) lays these again:
 * the name's colour white and its text; the plate's size 156.651 × 39.163; the health bar's BOTTOMLEFT on the plate's
 * (4.86, 4.90), its size 125.948 × 11.005 and its range and value from the unit (0x00990280); the cast border's size
 * and CENTER on the plate's CENTER half a plate down; the shield's size and CENTER on the cast border's CENTER half a
 * plate down; the cast bar's BOTTOMRIGHT on the cast border's (−4.86, 4.90), its size, range (0, 0), value 0 and colour;
 * the level's CENTER on the plate's BOTTOMRIGHT (−14.41, 11.12); the icon's CENTER on the cast border's BOTTOMLEFT
 * (14.41, 11.12); the glow's points on the plate; then the colour, level, dragon and raid mark (0x0098ee30, 0x0098ef10,
 * 0x0098e6e0, 0x0098e740). So an add-on that moved one of those parts finds it put back on the next unit — what it does
 * in OnShow, which runs after this, stays.
 */
import type { FrameXmlUiBridge } from "./FrameXmlRuntime.js";
import type { FrameXmlColor, FrameXmlFrame } from "./FrameXmlTypes.js";
import { linkFrameXmlStatusBarRegion, syncFrameXmlStatusBarRegion } from "./FrameXmlStatusBarRegion.js";

/** 0x00b2da74 and 0x00b2da70 as Lua reads them on WorldFrame's 768 units (NamePlate.ts keeps the canvas twin). */
export const FRAME_XML_NAME_PLATE_WIDTH = 156.651;
export const FRAME_XML_NAME_PLATE_HEIGHT = 39.163;
const BAR_WIDTH = 125.948;
const BAR_HEIGHT = 11.005;
const BAR_LEFT = 4.86;
const BAR_BOTTOM = 4.9;
const NAME_SIZE = 15.665;
const LEVEL_SIZE = 14.099;
const SHADOW = 1.567;
const LEVEL_FROM_RIGHT = 14.41;
const LEVEL_FROM_BOTTOM = 11.12;
const ICON_SIZE = 15.665;
const RAID_SIZE = 31.33;
const ELITE_WIDTH = 46.055;
const ELITE_HEIGHT = 33.68;
const FLASH_WIDTH = 172.316;
const FLASH_HEIGHT = 45.429;

/** The recording's plate frame level and its bars' (the target's are 20 and 19). */
export const FRAME_XML_NAME_PLATE_LEVEL = 10;
export const FRAME_XML_NAME_PLATE_TARGET_LEVEL = 20;

/** NAMEPLATE_FONT where the client's GlobalStrings do not answer it: the recording's file. */
export const FRAME_XML_NAME_PLATE_FONT = "Fonts\\FRIZQT__.TTF";

export const FRAME_XML_NAME_PLATE_TEXTURES = Object.freeze({
  flash: "Interface\\TargetingFrame\\UI-TargetingFrame-Flash",
  border: "Interface\\Tooltips\\Nameplate-Border",
  shield: "Interface\\Tooltips\\Nameplate-CastBar-Shield",
  glow: "Interface\\Tooltips\\Nameplate-Glow",
  skull: "Interface\\TargetingFrame\\UI-TargetingFrame-Skull",
  raid: "Interface\\TargetingFrame\\UI-RaidTargetingIcons",
  elite: "Interface\\Tooltips\\EliteNameplateIcon",
  bar: "Interface\\TargetingFrame\\UI-TargetingFrame-BarFill",
});

/**
 * The cast bar's colour as the attach leaves it, as `GetStatusBarColor` read it on every plate that was not casting
 * (0.698, 0, 1, 1), and while the target cast (1, 0.698, 0, 1) — 178 of 255 for the 0.698.
 */
export const FRAME_XML_NAME_PLATE_CAST_IDLE: FrameXmlColor = Object.freeze({ r: 178 / 255, g: 0, b: 1, a: 1 });
export const FRAME_XML_NAME_PLATE_CAST_COLOUR: FrameXmlColor = Object.freeze({ r: 1, g: 178 / 255, b: 0, a: 1 });

/** Every part of one plate. `regions` is `GetRegions()`'s order. */
export interface FrameXmlNamePlateParts {
  readonly frame: FrameXmlFrame;
  readonly flash: FrameXmlFrame;
  readonly border: FrameXmlFrame;
  readonly castBorder: FrameXmlFrame;
  readonly shield: FrameXmlFrame;
  readonly spellIcon: FrameXmlFrame;
  readonly glow: FrameXmlFrame;
  readonly name: FrameXmlFrame;
  readonly level: FrameXmlFrame;
  readonly skull: FrameXmlFrame;
  readonly raidIcon: FrameXmlFrame;
  readonly elite: FrameXmlFrame;
  readonly healthBar: FrameXmlFrame;
  readonly castBar: FrameXmlFrame;
}

/** `SetWidth`/`SetHeight` as the Lua methods write them: the attributes, compared first. */
export function setFrameXmlSize(bridge: FrameXmlUiBridge, frame: FrameXmlFrame, width: number, height: number): void {
  const w = String(width);
  const h = String(height);
  if (frame.attributes["width"] === w && frame.attributes["height"] === h) return;
  bridge.update(frame, (m) => {
    m.setAttribute("width", w);
    m.setAttribute("height", h);
  });
}

/** `SetTexCoord(left, right, top, bottom)`, compared first. */
export function setFrameXmlTexCoord(
  bridge: FrameXmlUiBridge, frame: FrameXmlFrame, left: number, right: number, top: number, bottom: number,
): void {
  const now = frame.texCoords;
  if (now && !now.corners && now.left === left && now.right === right && now.top === top && now.bottom === bottom) return;
  bridge.update(frame, (m) => { m.texCoords = { left, right, top, bottom }; }, "paint");
}

/** A colour as a texture's vertex colour (`SetVertexColor`), compared first. */
export function setFrameXmlVertexColour(bridge: FrameXmlUiBridge, frame: FrameXmlFrame, r: number, g: number, b: number, a = 1): void {
  const now = frame.vertexColor;
  if (now && now.r === r && now.g === g && now.b === b && now.a === a) return;
  bridge.update(frame, (m) => { m.vertexColor = { r, g, b, a }; }, "paint");
}

/** A FontString's text colour (`SetTextColor`), compared first. */
export function setFrameXmlTextColour(bridge: FrameXmlUiBridge, frame: FrameXmlFrame, r: number, g: number, b: number, a = 1): void {
  const now = frame.textColor;
  if (now && now.r === r && now.g === g && now.b === b && now.a === a) return;
  bridge.update(frame, (m) => { m.textColor = { r, g, b, a }; }, "paint");
}

/** `Show`/`Hide`, only on a change (each fires OnShow/OnHide). */
export function setFrameXmlShown(bridge: FrameXmlUiBridge, frame: FrameXmlFrame, shown: boolean): void {
  if (frame.visible === shown) return;
  if (shown) bridge.Show(frame);
  else bridge.Hide(frame);
}

/** A StatusBar's colour (`SetStatusBarColor`), compared first; the bar's texture follows. */
export function setFrameXmlStatusBarColour(bridge: FrameXmlUiBridge, bar: FrameXmlFrame, colour: FrameXmlColor): void {
  const now = bar.statusBar.color;
  if (now.r !== colour.r || now.g !== colour.g || now.b !== colour.b || now.a !== colour.a) {
    bridge.update(bar, (m) => { m.statusBar.color = { r: colour.r, g: colour.g, b: colour.b, a: colour.a }; }, "paint");
  }
  syncFrameXmlStatusBarRegion(bridge, bar);
}

/** `SetMinMaxValues` then `SetValue` on a StatusBar (OnValueChanged on a new value); the bar's texture follows. */
export function setFrameXmlStatusBarValue(bridge: FrameXmlUiBridge, bar: FrameXmlFrame, min: number, max: number, value: number): void {
  const state = bar.statusBar;
  const low = Math.fround(min);
  const high = Math.fround(Math.max(min, max));
  if (state.min !== low || state.max !== high) {
    bridge.update(bar, (m) => {
      m.statusBar.min = low;
      m.statusBar.max = high;
    }, "paint");
  }
  bridge.SetValue(bar, value);
  syncFrameXmlStatusBarRegion(bridge, bar);
}

function region(
  bridge: FrameXmlUiBridge, plate: FrameXmlFrame, type: "Texture" | "FontString", layer: string, texture?: string,
): FrameXmlFrame | undefined {
  const made = bridge.createChild(plate, type, undefined, layer);
  if (made && texture) bridge.SetTexture(made, texture);
  return made;
}

function fontString(bridge: FrameXmlUiBridge, plate: FrameXmlFrame, fontFile: string, size: number): FrameXmlFrame | undefined {
  const made = region(bridge, plate, "FontString", "ARTWORK");
  if (!made) return undefined;
  bridge.update(made, (m) => {
    m.setAttribute("fontFile", fontFile);
    m.setAttribute("fontHeight", String(size));
    m.setAttribute("fontFlags", "");
    m.setAttribute("shadowOffsetX", String(SHADOW));
    m.setAttribute("shadowOffsetY", String(-SHADOW));
    m.setAttribute("shadowColor", "0 0 0 1");
    m.justifyH = "CENTER";
  });
  setFrameXmlTextColour(bridge, made, 1, 1, 1, 1);
  return made;
}

function statusBar(bridge: FrameXmlUiBridge, plate: FrameXmlFrame): FrameXmlFrame | undefined {
  const bar = bridge.CreateFrame("StatusBar", undefined, plate);
  if (!bar) return undefined;
  bridge.update(bar, (m) => {
    m.statusBar.texture = FRAME_XML_NAME_PLATE_TEXTURES.bar;
    m.statusBar.orientation = "HORIZONTAL";
    // 0x004910a0(level − 1): a level under the plate, so the plate's own regions draw over it.
    m.frameLevel = FRAME_XML_NAME_PLATE_LEVEL - 1;
  });
  const fill = bridge.createChild(bar, "Texture", undefined, "ARTWORK");
  if (!fill) return undefined;
  linkFrameXmlStatusBarRegion(bridge, bar, fill);
  return bar;
}

/** CGNamePlateFrame's constructor (0x0098f790) under `worldFrame`; undefined when the bridge refuses a part. */
export function buildFrameXmlNamePlate(
  bridge: FrameXmlUiBridge,
  worldFrame: FrameXmlFrame,
  fontFile: string = FRAME_XML_NAME_PLATE_FONT,
): FrameXmlNamePlateParts | undefined {
  return bridge.runInMutationBatch(() => {
    const frame = bridge.CreateFrame("Frame", undefined, worldFrame);
    if (!frame) return undefined;
    bridge.update(frame, (m) => { m.frameLevel = FRAME_XML_NAME_PLATE_LEVEL; });
    setFrameXmlSize(bridge, frame, FRAME_XML_NAME_PLATE_WIDTH, FRAME_XML_NAME_PLATE_HEIGHT);

    const flash = region(bridge, frame, "Texture", "BACKGROUND", FRAME_XML_NAME_PLATE_TEXTURES.flash);
    const border = region(bridge, frame, "Texture", "ARTWORK", FRAME_XML_NAME_PLATE_TEXTURES.border);
    const healthBar = statusBar(bridge, frame);
    const castBorder = region(bridge, frame, "Texture", "ARTWORK", FRAME_XML_NAME_PLATE_TEXTURES.border);
    const shield = region(bridge, frame, "Texture", "ARTWORK", FRAME_XML_NAME_PLATE_TEXTURES.shield);
    const castBar = statusBar(bridge, frame);
    const spellIcon = region(bridge, frame, "Texture", "OVERLAY");
    const glow = region(bridge, frame, "Texture", "HIGHLIGHT", FRAME_XML_NAME_PLATE_TEXTURES.glow);
    const name = fontString(bridge, frame, fontFile, NAME_SIZE);
    const level = fontString(bridge, frame, fontFile, LEVEL_SIZE);
    const skull = region(bridge, frame, "Texture", "OVERLAY", FRAME_XML_NAME_PLATE_TEXTURES.skull);
    const raidIcon = region(bridge, frame, "Texture", "ARTWORK", FRAME_XML_NAME_PLATE_TEXTURES.raid);
    const elite = region(bridge, frame, "Texture", "BORDER", FRAME_XML_NAME_PLATE_TEXTURES.elite);
    if (!flash || !border || !healthBar || !castBorder || !shield || !castBar || !spellIcon || !glow || !name || !level
      || !skull || !raidIcon || !elite) return undefined;

    setFrameXmlSize(bridge, flash, FLASH_WIDTH, FLASH_HEIGHT);
    bridge.SetPoint(flash, "TOP", frame, "TOP", -1.57, -10.18);
    setFrameXmlTexCoord(bridge, flash, 0, 0.555, 0.53, 0.6);
    bridge.Hide(flash);
    bridge.SetAllPoints(border, frame);
    setFrameXmlTexCoord(bridge, castBorder, 1, 0, 0, 1);
    bridge.Hide(castBorder);
    bridge.Hide(shield);
    bridge.Hide(castBar);
    setFrameXmlSize(bridge, spellIcon, ICON_SIZE, ICON_SIZE);
    bridge.Hide(spellIcon);
    bridge.update(glow, (m) => { m.alphaMode = "ADD"; }, "paint");
    bridge.SetAllPoints(glow, frame);
    bridge.Hide(glow);
    bridge.SetPoint(name, "BOTTOM", frame, "CENTER", 0, 0);
    setFrameXmlSize(bridge, skull, ICON_SIZE, ICON_SIZE);
    bridge.SetPoint(skull, "CENTER", level, "CENTER", 0, 0);
    bridge.Hide(skull);
    setFrameXmlSize(bridge, raidIcon, RAID_SIZE, RAID_SIZE);
    bridge.SetPoint(raidIcon, "RIGHT", border, "LEFT", 0, 0);
    bridge.Hide(raidIcon);
    setFrameXmlSize(bridge, elite, ELITE_WIDTH, ELITE_HEIGHT);
    bridge.SetPoint(elite, "CENTER", level, "CENTER", 4.7, -1.57);
    setFrameXmlTexCoord(bridge, elite, 0, 0.578125, 0, 0.84375);
    bridge.Hide(elite);
    return {
      frame, flash, border, castBorder, shield, spellIcon, glow, name, level, skull, raidIcon, elite, healthBar, castBar,
    };
  });
}

/**
 * The fixed half of the attach (0x0098f390): the parts' sizes and points, the name in white with its text, the cast bar
 * empty in its idle colour. The unit's colour, level, dragon, mark and bars are the pool's (FrameXmlNamePlatePool.ts).
 */
export function attachFrameXmlNamePlate(bridge: FrameXmlUiBridge, parts: FrameXmlNamePlateParts, name: string): void {
  const { frame, healthBar, castBorder, shield, castBar, level, spellIcon, glow } = parts;
  setFrameXmlTextColour(bridge, parts.name, 1, 1, 1, 1);
  setFrameXmlSize(bridge, frame, FRAME_XML_NAME_PLATE_WIDTH, FRAME_XML_NAME_PLATE_HEIGHT);
  bridge.SetPoint(healthBar, "BOTTOMLEFT", frame, "BOTTOMLEFT", BAR_LEFT, BAR_BOTTOM);
  setFrameXmlSize(bridge, healthBar, BAR_WIDTH, BAR_HEIGHT);
  setFrameXmlSize(bridge, castBorder, FRAME_XML_NAME_PLATE_WIDTH, FRAME_XML_NAME_PLATE_HEIGHT);
  bridge.SetPoint(castBorder, "CENTER", frame, "CENTER", 0, -FRAME_XML_NAME_PLATE_HEIGHT / 2);
  setFrameXmlSize(bridge, shield, FRAME_XML_NAME_PLATE_WIDTH, FRAME_XML_NAME_PLATE_HEIGHT);
  bridge.SetPoint(shield, "CENTER", castBorder, "CENTER", 0, -FRAME_XML_NAME_PLATE_HEIGHT / 2);
  bridge.SetPoint(castBar, "BOTTOMRIGHT", castBorder, "BOTTOMRIGHT", -BAR_LEFT, BAR_BOTTOM);
  setFrameXmlSize(bridge, castBar, BAR_WIDTH, BAR_HEIGHT);
  setFrameXmlStatusBarValue(bridge, castBar, 0, 0, 0);
  setFrameXmlStatusBarColour(bridge, castBar, FRAME_XML_NAME_PLATE_CAST_IDLE);
  bridge.SetPoint(level, "CENTER", frame, "BOTTOMRIGHT", -LEVEL_FROM_RIGHT, LEVEL_FROM_BOTTOM);
  bridge.SetPoint(spellIcon, "CENTER", castBorder, "BOTTOMLEFT", LEVEL_FROM_RIGHT, LEVEL_FROM_BOTTOM);
  bridge.SetAllPoints(glow, frame);
  bridge.SetText(parts.name, name);
}
