/**
 * `InterfaceOptions_AddCategory` before the options chain is loaded (plan item 3.18).
 *
 * In the client InterfaceOptionsFrame.lua is ordinary FrameXML (stock TOC 37-45), so the function
 * exists before any TSWoW block or add-on runs, and a panel an add-on files while it loads lands in
 * the «AddOns» tab (InterfaceOptionsFrame.lua:585-650: without `issecure()` it gives the frame empty
 * okay/cancel/default/refresh handlers and inserts it into INTERFACEOPTIONS_ADDONCATEGORIES by name,
 * under its `parent`). This client loads that chain only on the first open of an options window
 * (FrameXmlOptionsOwner.ts); until then the call reached a recording no-op and the panel was lost.
 *
 * So a stand-in is installed before the corpus runs. It does at once what the stock function does to
 * the frame itself — the four handlers — and keeps the call; right after the chain has defined the
 * real function, the kept calls are made to it in their order, outside the chain's secure window, as
 * the add-on's own calls would have been. What is read at the replay rather than at the call is the
 * frame's `name`/`parent`, which an add-on normally sets before filing the panel.
 */

import type { GlueLuaVm } from "../glue/GlueLua.js";

const QUEUE = "__fxPendingOptionsCategories";
const STAND_IN = "__fxOptionsCategoryStandIn";

/** Runs before the corpus: the stand-in, unless something already defined the real function. */
export const FRAMEXML_OPTIONS_CATEGORY_QUEUE_PRELUDE = `
if rawget(_G, "InterfaceOptions_AddCategory") == nil then
  local queue = {}
  ${QUEUE} = queue
  local function standIn(frame, addOn, position)
    if type(frame) == "table" then
      frame.okay = frame.okay or function () end
      frame.cancel = frame.cancel or function () end
      frame.default = frame.default or function () end
      frame.refresh = frame.refresh or function () end
    end
    queue[#queue + 1] = { frame = frame, addOn = addOn, position = position }
  end
  ${STAND_IN} = standIn
  InterfaceOptions_AddCategory = standIn
end
`;

/** Replays the kept calls into the real function; returns how many were replayed. */
export const FRAMEXML_OPTIONS_CATEGORY_REPLAY = `
local queue, standIn = rawget(_G, "${QUEUE}"), rawget(_G, "${STAND_IN}")
local real = rawget(_G, "InterfaceOptions_AddCategory")
if queue == nil or real == nil or real == standIn then return 0 end
${QUEUE}, ${STAND_IN} = nil, nil
local failures = {}
for index = 1, #queue do
  local call = queue[index]
  local ok, message = pcall(real, call.frame, call.addOn, call.position)
  if not ok then failures[#failures + 1] = tostring(message) end
end
return #queue, table.concat(failures, "\\n")
`;

export function installFrameXmlOptionsCategoryQueue(vm: GlueLuaVm, chunk: string): boolean {
  return vm.execute(FRAMEXML_OPTIONS_CATEGORY_QUEUE_PRELUDE, chunk).ok;
}

/**
 * After the options chain ran, outside its secure window. A call the real function refuses with an
 * error (a nil frame, say) is the add-on's fault and must not take the options windows down with it:
 * it is reported on the console, as the client would have shown it at the add-on's own call.
 */
export function replayFrameXmlOptionsCategories(vm: GlueLuaVm): number {
  const replay = vm.compileFunction(FRAMEXML_OPTIONS_CATEGORY_REPLAY, "webclient/options-category-replay", []);
  if (!replay) return 0;
  try {
    const [count, failures] = vm.call(replay, [], 2);
    if (typeof failures === "string" && failures.length > 0) {
      console.warn(`[FrameXML options] an add-on's InterfaceOptions_AddCategory failed: ${failures}`);
    }
    return Number(count ?? 0);
  } finally {
    vm.release(replay);
  }
}
