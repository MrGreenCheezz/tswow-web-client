/**
 * Stock CalendarFrame (Blizzard_Calendar, load-on-demand) as the calendar window: the `/dbc/calendar`
 * catalog client, the gate, the lazy owner and the Lua routes from the stock entry points.
 *
 * Nothing of the add-on is read at boot. The first open — GameTimeFrame's click (stock ToggleCalendar,
 * or Calendar_Show while its invite badge glows), `/calendar`, the native game menu's «Календарь» or
 * the HUD's calendar button, all through `ui/Calendar.ts` — runs `boot.loadAddon` beside the catalog
 * fetch, hands the add-on's frames to the renderer, gates them, and shows CalendarFrame through the
 * client's own ShowUIPanel. A failed load or gate demotes the owner for good and opens the native
 * window the player asked for; the catalog is optional (a gateway built before the route answers
 * 404): the window then works without holidays, dungeon icons or raid names.
 */

import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlCalendar } from "./FrameXmlCalendar.js";
import type { FrameXmlCalendarHoliday } from "./FrameXmlCalendarHolidays.js";
import {
  FRAMEXML_CALENDAR_FILTER_DEFAULTS, type FrameXmlCalendarCatalog, type FrameXmlCalendarModel,
  type FrameXmlCalendarRaidMap, type FrameXmlCalendarTexture,
} from "./FrameXmlCalendarModel.js";
import { publishFrameXmlCalendar, type FrameXmlCalendarRouteOwner } from "./FrameXmlCalendarController.js";
import {
  createFrameXmlLodWindowOwner, frameXmlLodChild, frameXmlLodSilentProbe, type FrameXmlLodWindowOwner,
} from "./FrameXmlMacroBindingLod.js";

export const FRAMEXML_CALENDAR_ADDON = "Blizzard_Calendar";
/** CALENDAR_MAX_DAYS_PER_MONTH in Blizzard_Calendar.lua: six weeks of day buttons. */
const DAY_BUTTONS = 42;
/** The route's shape (src/gateway/CalendarCatalog.ts CALENDAR_CATALOG_VERSION). */
const CATALOG_VERSION = 1;

// ---- the catalog ----------------------------------------------------------------------------

const integer = (value: unknown): value is number => Number.isInteger(value);
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const words = (value: unknown, length: number): value is number[] =>
  Array.isArray(value) && value.length === length && value.every((word) => integer(word) && word >= 0 && word <= 0xffffffff);

function holidays(value: unknown): FrameXmlCalendarHoliday[] | undefined {
  if (!Array.isArray(value) || value.length > 1000) return undefined;
  const rows: FrameXmlCalendarHoliday[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (!row || typeof row !== "object" || !integer(row["id"]) || !text(row["name"], 256) || !text(row["description"], 8192)
      || !text(row["texture"], 256) || !integer(row["region"]) || !integer(row["looping"]) || !integer(row["priority"])
      || !integer(row["filterType"]) || !words(row["durations"], 10) || !words(row["dates"], 26) || !words(row["flags"], 10)) return undefined;
    rows.push({
      id: row["id"], name: row["name"], description: row["description"], texture: row["texture"], region: row["region"],
      looping: row["looping"], priority: row["priority"], filterType: row["filterType"],
      durations: row["durations"], dates: row["dates"], flags: row["flags"],
    });
  }
  return rows;
}

function textures(value: unknown): FrameXmlCalendarTexture[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const rows: FrameXmlCalendarTexture[] = [];
  for (const row of value as Record<string, unknown>[]) {
    if (!row || typeof row !== "object" || !integer(row["id"]) || !text(row["name"], 256) || !text(row["texture"], 256)
      || !integer(row["expansion"]) || !integer(row["type"]) || !integer(row["faction"]) || !integer(row["difficulty"])
      || !text(row["difficultyToken"], 128)) return undefined;
    rows.push({
      id: row["id"], name: row["name"], texture: row["texture"], expansion: row["expansion"], type: row["type"],
      faction: row["faction"], difficulty: row["difficulty"], difficultyToken: row["difficultyToken"],
    });
  }
  return rows;
}

function raids(value: unknown): FrameXmlCalendarRaidMap[] | undefined {
  if (!Array.isArray(value) || value.length > 10_000) return undefined;
  const rows: FrameXmlCalendarRaidMap[] = [];
  for (const row of value as Record<string, unknown>[]) {
    const difficulties = row?.["difficulties"];
    if (!row || typeof row !== "object" || !integer(row["mapId"]) || !text(row["name"], 256) || !Array.isArray(difficulties)) return undefined;
    const list: FrameXmlCalendarRaidMap["difficulties"][number][] = [];
    for (const entry of difficulties as Record<string, unknown>[]) {
      if (!entry || typeof entry !== "object" || !integer(entry["difficulty"]) || !text(entry["token"], 128)
        || !integer(entry["resetSeconds"])) return undefined;
      list.push({ difficulty: entry["difficulty"], token: entry["token"], resetSeconds: entry["resetSeconds"] });
    }
    rows.push({ mapId: row["mapId"], name: row["name"], difficulties: list });
  }
  return rows;
}

/**
 * `/dbc/calendar?v=1`, fetched once per page when the window first opens. A failure is kept (not
 * retried) and the model runs without the catalog.
 */
export class FrameXmlCalendarCatalogClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  #pending: Promise<FrameXmlCalendarCatalog | undefined> | undefined;
  /** Why the catalog is missing, for diagnostics; undefined while unfetched or loaded. */
  failure: string | undefined;

  constructor(gatewayOrigin: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.#url = new URL(`/dbc/calendar?v=${CATALOG_VERSION}`, gatewayOrigin).href;
    this.#fetch = fetcher;
  }

  load(): Promise<FrameXmlCalendarCatalog | undefined> {
    this.#pending ??= (async () => {
      try {
        const response = await this.#fetch(this.#url);
        if (!response.ok) throw new Error(`calendar gateway returned ${response.status}`);
        const body = await response.json() as Record<string, unknown>;
        if (body?.["version"] !== CATALOG_VERSION) throw new Error("calendar catalog of another version");
        const holidayRows = holidays(body["holidays"]);
        const textureRows = textures(body["textures"]);
        const raidRows = raids(body["raids"]);
        if (!holidayRows || !textureRows || !raidRows) throw new Error("malformed calendar catalog");
        return Object.freeze({ holidays: holidayRows, textures: textureRows, raids: raidRows });
      } catch (error) {
        this.failure = error instanceof Error ? error.message : String(error);
        return undefined;
      }
    })();
    return this.#pending;
  }
}

// ---- the gate -------------------------------------------------------------------------------

/** Drawn with CalendarFrame: rendered inside it. */
const CALENDAR_CHILDREN: readonly (readonly [name: string, type: string, clickable: boolean])[] = [
  ["CalendarPrevMonthButton", "Button", true],
  ["CalendarNextMonthButton", "Button", true],
  ["CalendarCloseButton", "Button", true],
  ["CalendarFilterButton", "Button", true],
];

/**
 * Declared `hidden="true"` (the event frames, pickers and their buttons): the renderer draws a hidden
 * subtree only when it is shown, so these are proven by name, type, ancestry and script.
 */
const CALENDAR_HIDDEN_CHILDREN: readonly (readonly [name: string, type: string, script: string])[] = [
  ["CalendarViewEventFrame", "Frame", "OnShow"],
  ["CalendarViewEventAcceptButton", "Button", "OnClick"],
  ["CalendarViewEventTentativeButton", "Button", "OnClick"],
  ["CalendarViewEventDeclineButton", "Button", "OnClick"],
  ["CalendarViewEventRemoveButton", "Button", "OnClick"],
  ["CalendarCreateEventFrame", "Frame", "OnShow"],
  ["CalendarCreateEventTitleEdit", "EditBox", "OnTextChanged"],
  ["CalendarCreateEventInviteEdit", "EditBox", "OnEnterPressed"],
  ["CalendarCreateEventInviteButton", "Button", "OnClick"],
  ["CalendarCreateEventCreateButton", "Button", "OnClick"],
  ["CalendarViewHolidayFrame", "Frame", "OnShow"],
  ["CalendarViewRaidFrame", "Frame", "OnShow"],
  ["CalendarEventPickerFrame", "Frame", "OnLoad"],
  ["CalendarTexturePickerFrame", "Frame", "OnLoad"],
  ["CalendarMassInviteFrame", "Frame", "OnShow"],
];

function calendarRoot(boot: FrameXmlBoot, renderer: FrameXmlDomRenderer): { frame: FrameXmlFrame; element: HTMLElement } | undefined {
  const frame = boot.bridge.getFrame("CalendarFrame");
  const uiParent = boot.bridge.getFrame("UIParent");
  const element = frame ? renderer.elementFor(frame) : undefined;
  if (!frame || frame.type !== "Frame" || !uiParent || frame.parent !== uiParent || !element
    || element.getAttribute("data-framexml-name") !== "CalendarFrame"
    || !["OnLoad", "OnShow", "OnHide", "OnEvent"].every((script) => boot.bridge.hasScript(frame, script))) return undefined;
  return { frame, element };
}

/**
 * Structural, rendered and behavioural proof that stock CalendarFrame can be the calendar window.
 *
 * CalendarFrame must be the named Frame under UIParent with its stock scripts; the month buttons,
 * the view/create/holiday/raid event frames, the pickers and the RSVP and create buttons must be
 * rendered inside it (or in the strata layer a HIGH child is lifted to); the 42 day buttons
 * CalendarFrame_OnLoad makes in Lua must exist under it with their OnClick; the seam must carry the
 * calendar model. One silent Show — CalendarFrame_OnShow runs CalendarFrame_Update over the real C
 * API, with PlaySound and OpenCalendar muted — must name a month and draw the day buttons, and it
 * and the Hide after it must raise no Lua error or bridge diagnostic. Ends hidden.
 */
export function frameXmlCalendarGate(
  seam: { readonly calendar?: FrameXmlCalendar | undefined },
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
): FrameXmlFrame | undefined {
  try {
    if (!seam.calendar?.ui) return undefined;
    const root = calendarRoot(boot, renderer);
    if (!root) return undefined;
    for (const [name, type, clickable] of CALENDAR_CHILDREN) {
      const child = frameXmlLodChild(boot, renderer, root.frame, root.element, name, type);
      if (!child || (clickable && !boot.bridge.hasScript(child, "OnClick"))) return undefined;
    }
    for (const [name, type, script] of CALENDAR_HIDDEN_CHILDREN) {
      const child = boot.bridge.getFrame(name);
      let ancestor = child?.parent;
      while (ancestor && ancestor !== root.frame) ancestor = ancestor.parent;
      if (!child || child.type !== type || !ancestor || !boot.bridge.hasScript(child, script)) return undefined;
    }
    const days: FrameXmlFrame[] = [];
    for (let index = 1; index <= DAY_BUTTONS; index += 1) {
      const day = boot.bridge.getFrame(`CalendarDayButton${index}`);
      if (!day || day.type !== "Button" || day.parent !== root.frame || !boot.bridge.hasScript(day, "OnClick")) return undefined;
      days.push(day);
    }
    const errors = boot.errorCount;
    const diagnostics = boot.bridge.diagnostics.length;
    const shown = frameXmlLodSilentProbe(boot, "webclient/calendar-gate-show", ["PlaySound", "OpenCalendar"],
      "CalendarFrame:Show() return CalendarFrame:IsShown() and 1 or 0, CalendarMonthName:GetText(), CalendarYearName:GetText()", 3);
    renderer.sync();
    const drawn = days.every((day) =>
      frameXmlLodChild(boot, renderer, root.frame, root.element, day.name ?? "", "Button") === day);
    const hidden = frameXmlLodSilentProbe(boot, "webclient/calendar-gate-hide", ["PlaySound"],
      "CalendarFrame:Hide() return CalendarFrame:IsShown() and 1 or 0", 1);
    renderer.sync();
    if (!shown || shown[0] !== 1 || typeof shown[1] !== "string" || shown[1] === "" || shown[2] === undefined
      || !drawn || !hidden || hidden[0] !== 0
      || boot.errorCount !== errors || boot.bridge.diagnostics.length !== diagnostics) return undefined;
    return boot.bridge.isVisible(root.frame) ? undefined : root.frame;
  } catch {
    return undefined;
  }
}

// ---- adoption -------------------------------------------------------------------------------

const FILTER_HOOK = "__fxCalendarFilter";

/**
 * The five filter CVars: registered with Wow.exe's defaults (a map this host does not seed would
 * answer nil and CalendarFilterDropDown would show every filter off), read once into the model, and
 * followed through SetCVar — CalendarFilterDropDown_OnClick sets one and redraws in the same call.
 */
function filterSource(): string {
  const names = Object.keys(FRAMEXML_CALENDAR_FILTER_DEFAULTS);
  const defaults = names.map((name) => (FRAMEXML_CALENDAR_FILTER_DEFAULTS[name] ? "1" : "0"));
  return `
local names = { ${names.map((name) => JSON.stringify(name)).join(", ")} }
local defaults = { ${defaults.map((value) => JSON.stringify(value)).join(", ")} }
for index = 1, #names do
  RegisterCVar(names[index], defaults[index])
  ${FILTER_HOOK}(names[index], GetCVarBool(names[index]) and 1 or 0)
end
hooksecurefunc("SetCVar", function(name)
  if type(name) == "string" and string.find(string.lower(name), "^calendarshow") then
    ${FILTER_HOOK}(name, GetCVarBool(name) and 1 or 0)
  end
end)
`;
}

const CHILD_CLICK = "__fxCalendarChildClick";
const CHILD_CLICKED = "__fxCalendarChildClicked";

/**
 * A stopgap for a renderer gap, until FrameXmlDomRenderer stops a registered click at the control
 * that took it. A day button (RegisterForClicks LeftButtonUp/RightButtonUp) is the DOM parent of its
 * four event buttons and its «more» button, which register the same releases; the mouseup bubbles,
 * so both OnClicks ran — the client runs only the topmost. Measured on the RICH route: a click on the
 * 28th's raid row opened the day's first row (Children's Week) instead. A child's click marks its
 * day button until the browser's event dispatch is over, and the day button's OnClick skips a marked
 * release. Retire when the renderer ignores a release that bubbled out of another control.
 */
const CLICK_GUARD_SOURCE = `
local mark, marked = ${CHILD_CLICK}, ${CHILD_CLICKED}
local dayClick = CalendarDayButton_OnClick
CalendarDayButton_OnClick = function(self, ...)
  if marked(self) then return end
  return dayClick(self, ...)
end
local eventClick = CalendarDayEventButton_OnClick
CalendarDayEventButton_OnClick = function(self, ...)
  mark(self:GetParent())
  return eventClick(self, ...)
end
local moreClick = CalendarDayButtonMoreEventsButton_OnClick
CalendarDayButtonMoreEventsButton_OnClick = function(self, ...)
  mark(self:GetParent())
  return moreClick(self, ...)
end
`;

/**
 * A stopgap for a widget-layer gap, until GlueAnimations.ts has Animation:GetSmoothProgress. The
 * RSVP buttons' OnUpdate (CalendarViewEventRSVPButton_OnUpdate, Blizzard_Calendar.lua:3135) reads it
 * on CalendarViewEventFlashTimer every frame an invitation waits for an answer. Measured on the RICH
 * route: 2,313 Lua errors in six seconds of an open invitation. The progress after the animation's
 * own smoothing, the curves GlueAnimations eases with.
 */
const SMOOTH_PROGRESS_SOURCE = `
local timer = CalendarViewEventFlashTimer
if type(timer) == "table" and timer.GetSmoothProgress == nil then
  timer.GetSmoothProgress = function(self)
    local progress = self:GetProgress() or 0
    local mode = self:GetSmoothing()
    if mode == "IN" then return progress * progress end
    if mode == "OUT" then return 1 - (1 - progress) * (1 - progress) end
    if mode == "IN_OUT" then return progress * progress * (3 - 2 * progress) end
    return progress
  end
end
`;

function adopt(model: FrameXmlCalendarModel, boot: FrameXmlBoot): void {
  model.useGlobalStrings((name) => boot.vm.globalString(name));
  boot.vm.executeReported(SMOOTH_PROGRESS_SOURCE, "@webclient/calendar-flash");
  boot.vm.registerGlobal(FILTER_HOOK, (args) => {
    if (typeof args[0] === "string") model.setFilter(args[0], args[1] === 1);
    return [];
  });
  boot.vm.executeReported(filterSource(), "@webclient/calendar-filters");
  const marked = new Set<unknown>();
  boot.vm.registerGlobal(CHILD_CLICK, (args) => {
    const day = args[0];
    if (day && typeof day === "object" && !marked.has(day)) {
      marked.add(day);
      // After the whole dispatch (target and bubbling), not a microtask: those run between listeners.
      setTimeout(() => { marked.delete(day); }, 0);
    }
    return [];
  });
  boot.vm.registerGlobal(CHILD_CLICKED, (args) => [marked.delete(args[0]) ? 1 : undefined]);
  boot.vm.executeReported(CLICK_GUARD_SOURCE, "@webclient/calendar-click-guard");
}

// ---- the owner ------------------------------------------------------------------------------

export interface FrameXmlCalendarOwnerHost {
  /** The native window alone, for a stock load that failed while the player waited. */
  openNative(): void;
  /** `/dbc/calendar`; unused when the model already carries a catalog (the canned seam's). */
  readonly catalog?: FrameXmlCalendarCatalogClient | undefined;
}

const SHOW_CALENDAR = "__fxShowCalendar";
const TOGGLE_CALENDAR = "__fxToggleCalendar";

/**
 * The lazy owner. `onFailure` lets the mount record the demotion; the stock entry points are pointed
 * back at the host (which now opens the native window), since the loaded add-on had replaced them.
 */
export function createLazyFrameXmlCalendarOwner(
  seam: { readonly calendar?: FrameXmlCalendar | undefined },
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  host: FrameXmlCalendarOwnerHost,
  onFailure?: () => void,
): FrameXmlCalendarRouteOwner {
  let adopted = false;
  const owner: FrameXmlLodWindowOwner = createFrameXmlLodWindowOwner(boot, renderer, {
    addon: FRAMEXML_CALENDAR_ADDON,
    prepare: async () => {
      const model = seam.calendar?.ui;
      if (!model || model.catalog || !host.catalog) return;
      const catalog = await host.catalog.load();
      if (catalog) model.useCatalog(catalog);
    },
    gate: (gateBoot, gateRenderer) => {
      // Localized names before the gate's silent show draws the month.
      seam.calendar?.ui?.useGlobalStrings((name) => gateBoot.vm.globalString(name));
      return frameXmlCalendarGate(seam, gateBoot, gateRenderer);
    },
    adopt: (adoptBoot) => {
      const model = seam.calendar?.ui;
      if (model) adopt(model, adoptBoot);
      adopted = true;
    },
    showSource: "ShowUIPanel(CalendarFrame)",
    hideSource: "HideUIPanel(CalendarFrame)",
    onFailure: (wanted) => {
      onFailure?.();
      boot.vm.executeReported(
        `Calendar_Show = ${SHOW_CALENDAR}\nCalendar_Toggle = ${TOGGLE_CALENDAR}\nCalendar_Hide = function() end`,
        "@webclient/calendar-fallback");
      console.warn("[FrameXML calendar] stock CalendarFrame failed to load, gate or open; the native window stays");
      if (wanted) host.openNative();
    },
  });
  return {
    get failed() { return owner.failed; },
    get loaded() { return adopted && !owner.failed; },
    isOpen: () => owner.isOpen(),
    show: () => owner.show(),
    hide: () => owner.hide(),
    dispose: () => {
      adopted = false;
      owner.dispose();
    },
  };
}

/**
 * The stock entry points, right after `boot.load()`: ToggleCalendar (GameTimeFrame's click), the
 * Calendar_Show GameTimeFrame calls while its invite badge glows, `/calendar`, and Calendar_LoadUI
 * (whose Lua LoadAddOn is only a status view here). They reach the host's calendar routes, which ask
 * the stock owner first. Once the add-on loads it defines its own Calendar_Show/Toggle/Hide, which
 * work on the loaded frame directly.
 */
export function installFrameXmlCalendarRoutes(boot: FrameXmlBoot, routes: { toggle(): void; open(): void }): void {
  boot.vm.registerGlobal(TOGGLE_CALENDAR, () => { routes.toggle(); return []; });
  boot.vm.registerGlobal(SHOW_CALENDAR, () => { routes.open(); return []; });
  boot.vm.executeReported(`
ToggleCalendar = ${TOGGLE_CALENDAR}
Calendar_LoadUI = function() return true end
Calendar_Show = ${SHOW_CALENDAR}
Calendar_Toggle = ${TOGGLE_CALENDAR}
if type(SlashCmdList) == "table" then
  SlashCmdList["CALENDAR"] = function() ToggleCalendar() end
end
`, "@webclient/calendar-owner");
}

/** The world mount's one entry: publish the lazy owner; returns the cleanup run before the VM goes. */
export function mountFrameXmlCalendar(
  seam: { readonly calendar?: FrameXmlCalendar | undefined },
  boot: FrameXmlBoot,
  renderer: FrameXmlDomRenderer,
  host: FrameXmlCalendarOwnerHost,
): { publish(): () => void } {
  return {
    publish: () => publishFrameXmlCalendar(createLazyFrameXmlCalendarOwner(seam, boot, renderer, host)),
  };
}
