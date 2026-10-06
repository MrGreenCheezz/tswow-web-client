/**
 * Plan item 3.31: the last five names the boot census still listed as unanswered, and
 * `SetEuropeanNumbers`, the C API Localization.xml needs (plan item 3.09).
 *
 * None of them is a C API. Each is a Lua function the stock corpus *defines*, but in a file this
 * client does not load (yet), and each is reached through the `_G` census fallback — which answered
 * with an unexplained counter stub. The rows below keep exactly that behaviour (a no-op, answering
 * nothing) and make it a documented answer, so the census reports a reason instead of a gap.
 *
 * Two properties make a no-op the truthful answer here and not a hidden gap:
 *
 * * Four of the five are called only behind an existence guard or only from a file that is itself
 *   absent, so in the real client they are either skipped or never reached; the stub changes the
 *   guard's branch but not the outcome (called, does nothing).
 * * The stub lands in `_G` with `rawset` on first read only, so the moment the owning file loads,
 *   its `function Name()` overwrites it: `Blizzard_RaidUI` and `Blizzard_ArenaUI` keep their own
 *   definitions (tests/framexml-census-remainder.test.mjs checks both).
 */

import type { FrameXmlNeutralAnswer } from "./FrameXmlNeutralApi.js";

const NOTHING: readonly unknown[] = Object.freeze([]);

export const FRAMEXML_CENSUS_REMAINDER_NEUTRAL: readonly FrameXmlNeutralAnswer[] = Object.freeze([
  {
    name: "LocalizeFrames", group: "options", values: NOTHING, answer: "—",
    reason: "UIParent.lua:457 calls it on VARIABLES_LOADED; it is defined by FrameXML/Localization.lua, "
      + "which the vertical TOC now loads at its stock slot (FrameXmlCorpus.ts), so the ruRU body — "
      + "SetEuropeanNumbers, re-anchoring PlayerHitIndicator, CATEGORY_TO_NOT_DISPLAY — replaces this "
      + "row there. The row only answers a VM loaded from a subset without that file.",
  },
  {
    name: "RaidGroupFrame_Update", group: "unit", values: NOTHING, answer: "—",
    reason: "RaidFrame.lua:41, :81 call it only behind `if RaidGroupFrame_Update`; Blizzard_RaidUI "
      + "defines it on load and overwrites this row (FrameXmlRaidLod.ts). Before that load the real "
      + "client skips the call — nothing to draw either way.",
  },
  {
    name: "CombatText_UpdateDisplayedMessages", group: "options", values: NOTHING, answer: "—",
    reason: "InterfaceOptionsPanels.lua:1255, :1318, :1330 guard it by existence; it belongs to "
      + "Blizzard_CombatText, which this client does not load: the browser's floating combat text "
      + "reads its own settings (FrameXmlCombatFeedback.ts), so there is no display to re-lay-out.",
  },
  {
    name: "ArenaEnemyBackground_SetOpacity", group: "pvp", values: NOTHING, answer: "—",
    reason: "PartyMemberFrame.lua:583 guards it by existence; Blizzard_ArenaUI.lua:327 defines it and "
      + "overwrites this row when the arena frames load (FrameXmlArenaLod.ts). Before that there are "
      + "no enemy backgrounds to fade.",
  },
  {
    name: "BNToastFrame_OnUpdate", group: "chat", values: NOTHING, answer: "—",
    reason: "UIParent.xml:29 calls it every frame from UIParent's OnUpdate; it is defined by BNet.lua, "
      + "which is not in the TOC. Its body only shows a queued Battle.net toast, and this client has "
      + "no Battle.net session, so no toast is ever queued.",
  },
  // Not a census remainder: the one C API that Localization.xml (loaded for LocalizeFrames above)
  // adds. Wow.exe 0x00510de0 reads its argument as a boolean (0x00815500: nil false, a number
  // non-zero, the strings "1".."9"/"t"/"y"/"enabled" true and "0"/"f"/"n"/"disabled" false, any
  // other value true) into a flag (0x0084f010) that only the "%F" conversion of string.format and
  // of the widget formatter reads (0x00853c50 / 0x00818070 → 0x0084f030: between digits, '.' and
  // ',' trade places). Nothing in the stock corpus formats with %F. 05.10-3.27b: a host C function
  // answers it (FrameXmlEuropeanNumbers.ts, installed by FrameXmlBoot before the corpus runs, so
  // this row is never reached and only documents the answer): it sets the flag that GlueLuaFormat.ts
  // and GlueWidgetFormat.ts read for %F, and answers nothing, as the client does.
  {
    name: "SetEuropeanNumbers", group: "options", values: NOTHING, answer: "—",
    reason: "Localization.lua:11 (ruRU LocalizeFrames) turns it on; a host C function sets the flag "
      + "that string.format's and SetFormattedText's %F read (decimal comma); no stock file uses %F.",
  },
]);
