/**
 * Plan item 3.21: widget methods the boot census found called but unanswered.
 *
 * `ColorSelect:SetColorRGB/GetColorRGB` (ColorPickerFrame — OpenColorPicker, UIDropDownMenu.lua:986-996,
 * and the chat colour swatches, ChatConfigFrame.lua:1336-1374) and
 * `ScrollingMessageFrame:UpdateColorByID` (ChatFrame.lua:2522, :2530 on UPDATE_CHAT_COLOR).
 *
 * Behaviour is the client's, read from Wow.exe.clean (descriptions only, no code copied):
 *
 * * `SetColorRGB` (0x00971050): each of r, g, b is clamped to [0, 1] (0x00960420), packed into a
 *   byte colour (0x0048bd20: channel × 255 + 0.5, whole part), stored, and the widget's
 *   `OnColorSelect` script — when it has one — runs with the stored colour (0x0096dd80), on every
 *   call, changed or not: OpenColorPicker relies on that («This must come last, since it triggers a
 *   call to ColorPickerFrame.func()»). It answers nothing.
 * * `GetColorRGB` (0x009710d0): the stored colour, each channel byte / 255.
 *   The client keeps the colour as HSV between the two calls (0x00984f60 / 0x00985030); the float
 *   loss of that round trip is not modelled here — the answer is the stored byte / 255.
 * * `UpdateColorByID(id, r, g, b)` (0x00973590 → 0x0096a6e0): all four must be numbers, otherwise
 *   nothing happens; id 0 changes nothing; every line added with that id (AddMessage's fifth
 *   argument) takes the clamped colour; the others keep theirs.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { WidgetMethod } from "./GlueWidgets.js";

type Rgb = readonly [number, number, number];

/** Clamp as 0x00960420 does: below 0 or not a number → 0, 1 and above → 1. */
function unit(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!(number >= 0)) return 0;
  return number >= 1 ? 1 : number;
}

/** One channel as the client packs it (0x0048bd20): a float, × 255 + 0.5, whole part. */
function toByte(value: number): number {
  return Math.floor(Math.fround(value) * 255 + 0.5);
}

/** Lua's `type(x) == "number"` for a binding argument (lua_isnumber also takes numeric strings). */
function isLuaNumber(value: unknown): boolean {
  if (typeof value === "number") return true;
  return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
}

export function colorSelectMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  const colors = new WeakMap<FrameXmlFrame, Rgb>();
  const read = (frame: FrameXmlFrame): readonly [number, number, number] => {
    const [r, g, b] = colors.get(frame) ?? [0, 0, 0];
    return [r / 255, g / 255, b / 255];
  };
  return {
    SetColorRGB: ({ frame, args }) => {
      colors.set(frame, [toByte(unit(args[0])), toByte(unit(args[1])), toByte(unit(args[2]))]);
      bridge.fireScript(frame, "OnColorSelect", ...read(frame));
    },
    GetColorRGB: ({ frame }) => read(frame),
  };
}

export function messageColorMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    UpdateColorByID: ({ frame, self, args }) => {
      if (!args.slice(0, 4).every(isLuaNumber) || args.length < 4) return;
      const id = Math.trunc(Number(args[0]));
      if (id === 0) return;
      const matches = (lineID: unknown): boolean =>
        isLuaNumber(lineID) && Math.trunc(Number(lineID)) === id;
      if (!self.messageFrame.messages.some((message) => matches(message.lineID))) return;
      const color = { r: unit(args[1]), g: unit(args[2]), b: unit(args[3]), a: 1 };
      bridge.update(frame, (mutable) => {
        const state = mutable.messageFrame;
        state.messages = state.messages.map((message) => matches(message.lineID) ? { ...message, color } : message);
        state.revision += 1;
      }, "paint");
    },
  };
}
