/**
 * 3.34 (03.10, L5): ScrollingMessageFrame scroll methods the widget layer lacked — the stock guild
 * bank log scrolls its `GuildBankMessageFrame` (insertMode TOP) with `SetScrollOffset` from a
 * FauxScrollFrame (Blizzard_GuildBankUI.lua:635). Wow.exe 3.3.5a (12340) method table 0x00b2cf98…
 * 0x00b2cfd8; behaviour in FrameXmlRuntime (`SetMessageScrollOffset`, `GetMessageCurrentScroll`,
 * `ScrollToTop`). `AtTop` and `GetNumLinesDisplayed` answer from the client's slot layout, which this
 * renderer does not keep line by line; they stay unanswered.
 */
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { WidgetMethod } from "./GlueWidgets.js";

export function messageScrollMethods(bridge: FrameXmlUiBridge): Record<string, WidgetMethod> {
  return {
    // 0x00973470: only a number moves anything (lua_isnumber), then lua_tonumber.
    SetScrollOffset: ({ frame, args }) => {
      const value = typeof args[0] === "number" ? args[0] : typeof args[0] === "string" ? Number(args[0]) : Number.NaN;
      if (Number.isFinite(value)) bridge.SetMessageScrollOffset(frame, value);
    },
    GetCurrentScroll: ({ frame }) => [bridge.GetMessageCurrentScroll(frame)],
    ScrollToTop: ({ frame }) => { bridge.ScrollToTop(frame); },
  };
}
