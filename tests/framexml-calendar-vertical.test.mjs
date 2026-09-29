import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the production vertical over the canned seam with its calendar pinned to 15 September
// 2026, rendered by the real FrameXmlDomRenderer on a stand-in document, then the real load-on-demand
// Blizzard_Calendar loaded through this lane's owner (FrameXmlCalendarOwner.ts) from the clock's own
// GameTimeFrame click, and driven through the stock Lua against the canned server.
function fakeDocument() {
  const ids = new Map();
  const doc = {
    activeElement: undefined, head: undefined, body: undefined,
    createElement(tag) { return makeNode(tag); },
    createElementNS(_namespace, tag) { return makeNode(tag); },
    getElementById(id) {
      if (!ids.has(id)) ids.set(id, makeNode("div"));
      return ids.get(id);
    },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  function style() {
    return { setProperty(name, value) { this[name] = String(value); }, removeProperty(name) { delete this[name]; } };
  }
  function makeNode(tag) {
    const attributes = new Map();
    const listeners = new Map();
    const classes = new Set();
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: undefined, parentNode: undefined,
      style: style(), hidden: false, className: "", dataset: {}, textContent: "", value: "", disabled: false,
      width: 0, height: 0, offsetLeft: 0, offsetTop: 0, offsetWidth: 0, offsetHeight: 0, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      classList: {
        add(...names) { for (const name of names) classes.add(name); node.className = [...classes].join(" "); },
        remove(...names) { for (const name of names) classes.delete(name); node.className = [...classes].join(" "); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name); else classes.delete(name);
          node.className = [...classes].join(" ");
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
      get nextSibling() {
        const siblings = node.parentElement?.children ?? [];
        const index = siblings.indexOf(node);
        return index < 0 ? null : siblings[index + 1] ?? null;
      },
      append(...children) {
        for (const child of children) {
          if (!child || typeof child !== "object") continue;
          child.parentElement?.removeChild(child);
          child.parentElement = node;
          child.parentNode = node;
          node.children.push(child);
        }
      },
      appendChild(child) { node.append(child); return child; },
      insertBefore(child, before) {
        child.parentElement?.removeChild(child);
        child.parentElement = node;
        child.parentNode = node;
        const index = node.children.indexOf(before);
        if (index < 0) node.children.push(child); else node.children.splice(index, 0, child);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        if (child.parentElement === node) child.parentElement = undefined;
        if (child.parentNode === node) child.parentNode = undefined;
      },
      replaceChildren(...children) {
        for (const child of node.children) { child.parentElement = undefined; child.parentNode = undefined; }
        node.children = [];
        node.append(...children);
      },
      contains(other) {
        for (let current = other; current; current = current.parentElement) if (current === node) return true;
        return false;
      },
      remove() { node.parentElement?.removeChild(node); },
      setAttribute(name, value) { attributes.set(String(name), String(value)); },
      getAttribute(name) { return attributes.get(String(name)) ?? null; },
      removeAttribute(name) { attributes.delete(String(name)); },
      hasAttribute(name) { return attributes.has(String(name)); },
      addEventListener(name, listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      removeEventListener(name, listener) { listeners.set(name, (listeners.get(name) ?? []).filter((value) => value !== listener)); },
      dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event); },
      querySelector() { return undefined; },
      querySelectorAll() { return []; },
      closest() { return null; },
      focus() { doc.activeElement = node; },
      blur() { if (doc.activeElement === node) doc.activeElement = undefined; },
      setSelectionRange() {},
      getContext() { return undefined; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
    };
    return node;
  }
  doc.head = makeNode("head");
  doc.body = makeNode("body");
  return doc;
}

globalThis.document = fakeDocument();
globalThis.window = {
  devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768, location: { protocol: "http:", hostname: "localhost" },
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id),
};
globalThis.location = globalThis.window.location;
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine", concurrency: false };
const { clientArchives } = await import("../tools/mpq.mjs");
const chain = clientDirectory ? await clientArchives(clientDirectory) : undefined;

const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { FrameXmlDomRenderer } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlDomRenderer.js");
const { CannedFrameXmlCalendar } = await import("../dist/code/browser/framexml/FrameXmlCalendarCanned.js");
const { installFrameXmlCalendarRoutes, mountFrameXmlCalendar } = await import("../dist/code/browser/framexml/FrameXmlCalendarOwner.js");
const calendarRoute = await import("../dist/code/browser/framexml/FrameXmlCalendarController.js");

const decoder = new TextDecoder("utf-8");
const normalize = (path) => path.replaceAll("\\", "/").toLowerCase();
const ADDON_PREFIX = "interface/addons/blizzard_calendar/";
/** 15 September 2026, 10:00 on this machine's clock: the canned month's «today». */
const TODAY = new Date(2026, 8, 15, 10, 0);

async function boot({ missingAddon = false, brokenOnShow = false } = {}) {
  const requests = [];
  const addonBytes = new Map();
  const seam = new CannedWorldSeam();
  // The canned calendar pinned to TODAY (the seam's own follows the page's clock).
  const calendar = new CannedFrameXmlCalendar(() => TODAY);
  Object.defineProperty(seam, "calendar", { value: calendar });
  const frameXml = new FrameXmlBoot({
    provider: {
      async read(path) {
        const key = normalize(path);
        requests.push(key);
        if (missingAddon && key.startsWith(ADDON_PREFIX)) return undefined;
        const data = await chain.read(path);
        if (data && key.startsWith(ADDON_PREFIX)) addonBytes.set(key, data.byteLength);
        // Loaded before Blizzard_Calendar.xml binds `function="CalendarFrame_OnShow"`: "error" runs the
        // stock OnShow and then raises; "empty" raises nothing and draws nothing (no month is named).
        if (data && brokenOnShow && key === `${ADDON_PREFIX}blizzard_calendar.lua`) {
          const body = brokenOnShow === "empty" ? "" : "stockOnShow(self) error(\"calendar test: a broken OnShow\")";
          return `${decoder.decode(data)}\nlocal stockOnShow = CalendarFrame_OnShow\nfunction CalendarFrame_OnShow(self) ${body} end\n`;
        }
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam, exercise: false,
    screen: () => ({ width: 1365, height: 768 }),
  });
  const started = performance.now();
  await frameXml.load();
  const loadMs = performance.now() - started;
  const renderer = new FrameXmlDomRenderer(document.createElement("section"), { bridge: frameXml.bridge });
  renderer.mount(frameXml.roots);
  const native = { opens: 0 };
  // The world mount's two calls: the routes after boot.load(), the owner in the publication block.
  installFrameXmlCalendarRoutes(frameXml, {
    toggle: () => { if (!calendarRoute.toggleFrameXmlCalendar()) native.opens += 1; },
    open: () => { if (!calendarRoute.openFrameXmlCalendar()) native.opens += 1; },
  });
  const cleanup = mountFrameXmlCalendar(seam, frameXml, renderer, { openNative: () => { native.opens += 1; } }).publish();
  return { boot: frameXml, seam, calendar, renderer, native, requests, addonBytes, loadMs, cleanup };
}

let loaded;
async function ready() {
  loaded ??= await boot();
  return loaded;
}

after(() => {
  loaded?.cleanup();
  loaded?.boot.close();
  chain?.close();
});

function lua(target, code, results = 1) {
  const fn = target.boot.vm.compileFunction(code, "calendar-test", []);
  assert.ok(fn, `compiles: ${code.slice(0, 60)}`);
  try { return target.boot.vm.call(fn, [], results); } finally { target.boot.vm.release(fn); }
}
const frame = (target, name) => target.boot.bridge.getFrame(name);
const shown = (target, name) => target.boot.bridge.isVisible(frame(target, name));
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
async function until(predicate, label) {
  for (let index = 0; index < 400 && !predicate(); index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), label);
}

/** Every shown event button's text on the day button of `day` in the viewed month. */
function dayTexts(target, day) {
  return lua(target, `
    local texts = {}
    for index = 1, 42 do
      local button = _G["CalendarDayButton" .. index]
      if button.monthOffset == 0 and button.day == ${day} then
        for slot = 1, 4 do
          local event = _G[button:GetName() .. "EventButton" .. slot]
          if event:IsShown() then texts[#texts + 1] = _G[event:GetName() .. "Text1"]:GetText() end
        end
      end
    end
    return table.concat(texts, " | ")`)[0];
}

function clickEvent(target, title, mouse = "LeftButton") {
  const found = lua(target, `
    for index = 1, 42 do
      local day = _G["CalendarDayButton" .. index]
      for slot = 1, 4 do
        local event = _G[day:GetName() .. "EventButton" .. slot]
        if event:IsShown() and event.eventIndex and CalendarGetDayEvent(day.monthOffset, day.day, event.eventIndex) == ${JSON.stringify(title)} then
          CalendarDayEventButton_OnClick(event, "${mouse}")
          return 1
        end
      end
    end
    return 0`)[0];
  assert.equal(found, 1, `an event button shows ${title}`);
}

test("boot reads nothing of Blizzard_Calendar; the clock shows the canned day and the raid invitation badge", withClient, async () => {
  const target = await ready();
  assert.equal(frame(target, "CalendarFrame"), undefined, "the vertical does not carry the LoD add-on");
  assert.equal(target.requests.some((path) => path.startsWith(ADDON_PREFIX)), false, "no add-on file is read at boot");
  assert.equal(target.boot.errorCount, 0, target.boot.vm.errors.join(" | "));
  // GameTime.lua: the date on the button and the pending-invite art (one invitation waits).
  target.boot.bridge.dispatchEvent("PLAYER_ENTERING_WORLD");
  assert.equal(lua(target, "return GameTimeFrame:GetText()")[0], "15");
  assert.equal(shown(target, "GameTimeCalendarInvitesTexture"), true);
  console.log(`[calendar] vertical boot ${Math.round(target.loadMs)} ms`);
});

test("GameTimeFrame's click loads Blizzard_Calendar, passes its gate and shows the canned month", withClient, async () => {
  const target = await ready();
  const errors = target.boot.errorCount;
  const diagnostics = target.boot.bridge.diagnostics.length;
  const widgets = target.boot.bridge.frames.length;
  const started = performance.now();
  // With its invite badge lit, GameTimeFrame_OnClick calls Calendar_LoadUI() and Calendar_Show().
  assert.equal(calendarRoute.frameXmlCalendarOwnsErrors(), false, "nothing loaded: calendar errors stay the native notice's");
  lua(target, "GameTimeFrame_OnClick(GameTimeFrame)", 0);
  assert.equal(calendarRoute.frameXmlCalendarOpen(), true, "the pending open is observable");
  await until(() => frame(target, "CalendarFrame") && shown(target, "CalendarFrame"), "CalendarFrame shows once loaded and gated");
  const openMs = performance.now() - started;
  await settle();
  assert.equal(target.native.opens, 0, "the native window never opened");
  assert.equal(calendarRoute.frameXmlCalendarOwnsErrors(), true, "loaded and gated: CalendarFrame_OnEvent shows them");
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
  assert.equal(target.boot.bridge.diagnostics.length, diagnostics, JSON.stringify(target.boot.bridge.diagnostics.slice(diagnostics)));
  const closure = {
    files: target.addonBytes.size,
    bytes: [...target.addonBytes.values()].reduce((sum, size) => sum + size, 0),
    widgets: target.boot.bridge.frames.length - widgets,
  };
  console.log(`[calendar] Blizzard_Calendar closure ${JSON.stringify(closure)}; first open ${Math.round(openMs)} ms`);
  assert.deepEqual([...target.addonBytes.keys()].sort(), [
    "interface/addons/blizzard_calendar/blizzard_calendar.lua", "interface/addons/blizzard_calendar/blizzard_calendar.toc",
    "interface/addons/blizzard_calendar/blizzard_calendar.xml", "interface/addons/blizzard_calendar/blizzard_calendartemplates.xml",
    "interface/addons/blizzard_calendar/localization.lua",
  ]);
  // The month and year, and the invite badge put out by opening the calendar.
  assert.equal(lua(target, "return CalendarMonthName:GetText()")[0], lua(target, "return MONTH_SEPTEMBER")[0]);
  assert.equal(lua(target, "return CalendarYearName:GetText()")[0], "2026");
  assert.equal(shown(target, "GameTimeCalendarInvitesTexture"), false);
  // OpenCalendar asked the (canned) server once for the month.
  assert.equal(target.calendar.server.calls.filter((call) => call.name === "requestCalendar").length, 1);
  // ruRU weeks start on Monday (Localization.lua CALENDAR_FIRST_WEEKDAY = 2); 1 September 2026 is a
  // Tuesday, so button 1 is 31 August and button 2 the first.
  assert.deepEqual(lua(target, "return CalendarDayButton1.day, CalendarDayButton1.monthOffset, CalendarDayButton2.day, CalendarDayButton2.monthOffset", 4), [31, -1, 1, 0]);
  assert.equal(lua(target, "return CalendarWeekday1Name:GetText()")[0], lua(target, "return WEEKDAY_MONDAY")[0]);
  // Today's frame sits on the 15th.
  assert.equal(lua(target, "return CalendarTodayFrame:GetParent().day")[0], 15);
});

test("the grid: the raid invitation, the player's own run, guild rows, raid save and four holidays", withClient, async () => {
  const target = await ready();
  if (!shown(target, "CalendarFrame")) {
    calendarRoute.openFrameXmlCalendar();
    await until(() => shown(target, "CalendarFrame"), "CalendarFrame open");
  }
  const start = lua(target, "return CALENDAR_EVENTNAME_FORMAT_START")[0];
  const end = lua(target, "return CALENDAR_EVENTNAME_FORMAT_END")[0];
  const format = (template, value) => template.replace("%s", value);
  // Holidays lead a day's list; ONGOING days of a run show no row of their own.
  assert.equal(dayTexts(target, 12), format(start, "Детская неделя"));
  assert.equal(dayTexts(target, 15), "", "the middle of Children's Week shows no row");
  assert.equal(dayTexts(target, 18), `${format(end, "Детская неделя")} | Наксрамас 25`);
  assert.equal(dayTexts(target, 20), `${format(start, "Хмельной фестиваль")} | Рыбомания Тернистой долины | Сбор гильдии`,
    "Brewfest opens after its hidden week; the weekly fishing contest on Sunday; the guild event to sign up to");
  assert.equal(dayTexts(target, 23), format(start, "Ярмарка Новолуния"), "the Faire after its two setup days");
  assert.equal(dayTexts(target, 24), "Мертвые копи");
  assert.equal(dayTexts(target, 16), "Новый устав");
  assert.equal(dayTexts(target, 10), "Склеп Аркавона", "an event already past stays on the grid");
  assert.deepEqual(lua(target, "return CalendarGetDayEventSequenceInfo(0, 18, 1)", 3), [7, 7, "END"]);
  assert.deepEqual(lua(target, "return CalendarGetDayEventSequenceInfo(0, 21, 1)", 3), [2, 16, "ONGOING"]);
  // The Brewfest overlay (a run longer than two days) on its ongoing days, from the holiday's art.
  assert.equal(lua(target, "return CalendarDayButton22OverlayFrameTexture:GetTexture()")[0].toLowerCase(),
    "interface\\calendar\\holidays\\calendar_brewfestongoing", "button 22 is the 21st");
  // The raid save of Naxxramas 25 resets on the 19th (4 days 3 hours after 10:00): a lockout row.
  const lockout = lua(target, `
    for index = 1, CalendarGetNumDayEvents(0, 19) do
      local title, hour, minute, calendarType, _, _, _, _, _, _, difficulty, _, _, _, difficultyName = CalendarGetDayEvent(0, 19, index)
      if calendarType == "RAID_LOCKOUT" then return title, hour, minute, difficulty, difficultyName end
    end`, 5);
  assert.deepEqual(lockout, ["Наксрамас", 13, 0, 1, lua(target, "return RAID_DIFFICULTY_25PLAYER")[0]]);
  assert.match(dayTexts(target, 19), /Наксрамас/, "the save shows by its format");
  // The pending invitation marks its day.
  assert.equal(lua(target, "return CalendarDayButton19PendingInviteTexture:IsShown() and 1 or 0")[0], 1, "button 19 is the 18th");
  // A day's art comes from its first shown row: the holiday's own «End» art, the dungeon's LFG icon.
  assert.equal(lua(target, "return CalendarDayButton19EventTexture:GetTexture()")[0].toLowerCase(),
    "interface\\calendar\\holidays\\calendar_childrensweekend");
  assert.equal(lua(target, "return CalendarDayButton25EventTexture:GetTexture()")[0].toLowerCase(),
    "interface\\lfgframe\\lfgicon-deadmines", "button 25 is the 24th");
  // Filters: the weekly-holiday CVar hides the fishing contest, through the stock drop-down's SetCVar.
  lua(target, "SetCVar('calendarShowWeeklyHolidays', '0') CalendarFrame_Update()", 0);
  assert.doesNotMatch(dayTexts(target, 20), /Рыбомания/);
  lua(target, "SetCVar('calendarShowWeeklyHolidays', '1') CalendarFrame_Update()", 0);
  assert.match(dayTexts(target, 20), /Рыбомания/);
});

async function openCalendar(target) {
  if (!shown(target, "CalendarFrame")) {
    calendarRoute.openFrameXmlCalendar();
    await until(() => shown(target, "CalendarFrame"), "CalendarFrame open");
  }
  lua(target, "CalendarFrame_CloseEvent()", 0);
}

test("the raid invitation: the view frame, its roster by status, and Accept through CMSG_CALENDAR_EVENT_RSVP", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  const errors = target.boot.errorCount;
  clickEvent(target, "Наксрамас 25");
  await settle();
  assert.equal(shown(target, "CalendarViewEventFrame"), true, "not the creator: the view frame");
  assert.equal(shown(target, "CalendarCreateEventFrame"), false);
  assert.equal(lua(target, "return CalendarViewEventTitle:GetText()")[0], "Наксрамас 25");
  assert.match(lua(target, "return CalendarViewEventCreatorName:GetText()")[0], /Тралл/);
  // «Рейд: Наксрамас (25 игроков)»-shaped: the event type and the icon's dungeon with its MapDifficulty name.
  const typeName = lua(target, "return CalendarViewEventTypeName:GetText()")[0];
  assert.ok(typeName.includes(lua(target, "return CALENDAR_TYPE_RAID")[0]) && typeName.includes("Наксрамас")
    && typeName.includes(lua(target, "return RAID_DIFFICULTY_25PLAYER")[0]), typeName);
  assert.equal(lua(target, "return CalendarViewEventIcon:GetTexture()")[0].toLowerCase(), "interface\\lfgframe\\lfgicon-naxxramas");
  // The roster, sorted by status: confirmed, accepted, tentative, invited.
  assert.equal(lua(target, "return CalendarEventGetNumInvites()")[0], 4);
  const roster = () => lua(target, `
    local rows = {}
    for index = 1, CalendarEventGetNumInvites() do
      local name, level, className, classFile, status, modStatus, mine = CalendarEventGetInvite(index)
      rows[#rows + 1] = name .. ":" .. status .. ":" .. modStatus .. ":" .. classFile .. (mine and ":me" or "")
    end
    return table.concat(rows, " ")`)[0];
  assert.equal(roster(), "Тралл:4:CREATOR:SHAMAN Утер:2:MODERATOR:PALADIN Сильвана:9::HUNTER Игрок:1::WARRIOR:me");
  assert.equal(lua(target, "return CalendarViewEventInviteListScrollFrameButton1Name:GetText()")[0], "Тралл");
  // Pending: every answer is open and flashing.
  assert.deepEqual(lua(target, `return CalendarViewEventAcceptButton:IsEnabled(), CalendarViewEventTentativeButton:IsEnabled(),
    CalendarViewEventDeclineButton:IsEnabled(), CalendarViewEventAcceptButtonFlashTexture:IsShown() and 1 or 0`, 4), [1, 1, 1, 1]);
  // The flash runs every frame: CalendarViewEventRSVPButton_OnUpdate reads the timer's smoothed progress.
  for (let frame = 0; frame < 4; frame += 1) target.boot.bridge.tick(0.2);
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
  const alpha = lua(target, "return CalendarViewEventAcceptButtonFlashTexture:GetAlpha()")[0];
  assert.ok(alpha > 0 && alpha <= 1, `the flash follows the timer (${alpha})`);
  lua(target, "CalendarViewEventAcceptButton:Click()", 0);
  assert.equal(lua(target, "return CalendarIsActionPending() and 1 or 0")[0], 1, "the latch holds until the server answers");
  await settle();
  const rsvp = target.calendar.server.calls.filter((call) => call.name === "rsvp").at(-1);
  assert.deepEqual(rsvp.args.slice(2), [1], "CALENDAR_STATUS_ACCEPTED");
  assert.equal(lua(target, "return CalendarIsActionPending() and 1 or 0")[0], 0);
  assert.equal(roster(), "Тралл:4:CREATOR:SHAMAN Игрок:2::WARRIOR:me Утер:2:MODERATOR:PALADIN Сильвана:9::HUNTER",
    "an equal status sorts by name");
  assert.equal(lua(target, "return CalendarViewEventAcceptButton:IsEnabled()")[0], 0, "accepted: Accept greys out");
  assert.equal(lua(target, "return CalendarGetNumPendingInvites()")[0], 0);
  assert.equal(lua(target, "return CalendarDayButton19PendingInviteTexture:IsShown() and 1 or 0")[0], 0, "the day's pending mark goes");
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
});

test("a new event: day menu, raid icon picker, time, a checked pre-invite, a refused name, and CMSG_CALENDAR_ADD_EVENT", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  const errors = target.boot.errorCount;
  // The 17th's context menu: create, and the two guild entries (the canned rank may create guild events).
  lua(target, `for index = 1, 42 do local day = _G["CalendarDayButton" .. index]
    if day.monthOffset == 0 and day.day == 17 then CalendarDayButton_OnClick(day, "RightButton") end end`, 0);
  assert.equal(shown(target, "CalendarContextMenu"), true);
  const menu = lua(target, `local texts = {} for index = 1, 12 do local button = _G["CalendarContextMenuButton" .. index]
    if button and button:IsShown() and button:GetText() then texts[#texts + 1] = button:GetText() end end return table.concat(texts, "|")`)[0];
  assert.equal(menu, lua(target, "return CALENDAR_CREATE_EVENT .. '|' .. CALENDAR_CREATE_GUILD_EVENT .. '|' .. CALENDAR_CREATE_GUILD_ANNOUNCEMENT")[0]);
  lua(target, "CalendarDayContextMenu_CreateEvent()", 0);
  assert.equal(shown(target, "CalendarCreateEventFrame"), true);
  assert.equal(lua(target, "return CalendarCreateEventFrame.mode")[0], "create");
  // The creator is listed as such before anything is sent.
  assert.deepEqual(lua(target, "return CalendarEventGetNumInvites(), select(6, CalendarEventGetInvite(1))", 2), [1, "CREATOR"]);
  lua(target, `CalendarCreateEventTitleEdit:SetText("Рейд в Склеп")
    CalendarCreateEventTitleEdit_OnTextChanged(CalendarCreateEventTitleEdit)`, 0);
  // Raid: the icon picker lists the raids of the player's faction, newest expansion first.
  lua(target, "CalendarCreateEventTypeDropDown_OnClick({ GetID = function() return CALENDAR_EVENTTYPE_RAID end })", 0);
  assert.equal(shown(target, "CalendarTexturePickerFrame"), true);
  const textures = lua(target, "local list = { CalendarEventGetTextures(CALENDAR_EVENTTYPE_RAID) } return #list, list[1], list[4], list[9], list[13]", 5);
  assert.deepEqual(textures.slice(0, 2), [16, "Наксрамас"]);
  assert.equal(textures[2], lua(target, "return RAID_DIFFICULTY_10PLAYER")[0]);
  assert.deepEqual(textures.slice(3), ["Склеп Аркавона", "Огненные Недра"], "expansion 2 before 0, then by name");
  lua(target, "CalendarTexturePickerFrame.selectedTextureIndex = 3 CalendarTexturePickerAcceptButton_OnClick()", 0);
  assert.equal(lua(target, "return CalendarCreateEventTextureName:GetText()")[0].includes("Склеп Аркавона"), true);
  lua(target, "CalendarCreateEventHourDropDown_OnClick({ value = 20 })", 0);
  // Утер is checked by the server before he is listed (the core's pre-invite, event id 0).
  lua(target, `CalendarCreateEventInviteEdit:SetText("Утер") CalendarCreateEventInviteButton_OnClick(CalendarCreateEventInviteButton)`, 0);
  await settle();
  assert.equal(lua(target, "return CalendarEventGetNumInvites()")[0], 2);
  // Two seconds between invites (Wow.exe's own throttle): a second name at once is not sent.
  assert.equal(lua(target, "return CalendarCanSendInvite() and 1 or 0")[0], 0);
  target.calendar.monotonicMs += 2_000;
  assert.equal(lua(target, "return CalendarCanSendInvite() and 1 or 0")[0], 1);
  lua(target, `CalendarCreateEventInviteEdit:SetText("Незнакомец") CalendarCreateEventInviteButton_OnClick(CalendarCreateEventInviteButton)`, 0);
  await settle();
  assert.equal(shown(target, "StaticPopup1"), true, "CALENDAR_UPDATE_ERROR raises the CALENDAR_ERROR popup");
  assert.equal(lua(target, "return StaticPopup1Text:GetText()")[0], lua(target, "return PLAYER_NOT_FOUND")[0]);
  lua(target, "StaticPopup_Hide('CALENDAR_ERROR')", 0);
  assert.equal(lua(target, "return CalendarEventGetNumInvites()")[0], 2, "a refused name is not listed");
  lua(target, "CalendarCreateEventCreateButton_OnClick(CalendarCreateEventCreateButton)", 0);
  await settle();
  const add = target.calendar.server.calls.filter((call) => call.name === "addEvent").at(-1);
  const [fields, invites] = add.args;
  const { unpackWowTime } = await import("../dist/code/world/CalendarProtocol.js");
  assert.deepEqual({ ...fields, time: unpackWowTime(fields.time) }, {
    title: "Рейд в Склеп", description: "", eventType: 0, maxSize: 100, textureId: 239,
    time: { year: 2026, month: 9, day: 17, hour: 20, minute: 0 }, lockDate: 0, flags: 0,
  });
  assert.deepEqual(invites, [{ guid: 0x1n, status: 1, moderator: 2 }, { guid: 0x23n, status: 0, moderator: 0 }]);
  assert.equal(shown(target, "CalendarCreateEventFrame"), false, "CALENDAR_NEW_EVENT closes the create frame");
  assert.match(dayTexts(target, 17), /Рейд в Склеп/, "the new event is on its day");
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
});

test("the player's own event opens for editing; an update and a delete go out and come back", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  const errors = target.boot.errorCount;
  clickEvent(target, "Мертвые копи");
  await settle();
  assert.equal(shown(target, "CalendarCreateEventFrame"), true, "the creator edits");
  assert.equal(lua(target, "return CalendarCreateEventFrame.mode")[0], "edit");
  assert.equal(lua(target, "return CalendarCreateEventTitleEdit:GetText()")[0], "Мертвые копи");
  assert.equal(lua(target, "return CalendarEventHaveSettingsChanged() and 1 or 0")[0], 0);
  lua(target, `CalendarCreateEventTitleEdit:SetText("Мертвые копи (героич.)")
    CalendarCreateEventTitleEdit_OnTextChanged(CalendarCreateEventTitleEdit) CalendarCreateEventCreateButton_Update()`, 0);
  assert.equal(lua(target, "return CalendarEventHaveSettingsChanged() and 1 or 0, CalendarCreateEventCreateButton:IsEnabled()", 2).join(), "1,1");
  lua(target, "CalendarCreateEventCreateButton_OnClick(CalendarCreateEventCreateButton)", 0);
  await settle();
  const update = target.calendar.server.calls.filter((call) => call.name === "updateEvent").at(-1);
  assert.equal(update.args[2].title, "Мертвые копи (героич.)");
  assert.equal(dayTexts(target, 24), "Мертвые копи (героич.)", "the updated alert renames the row");
  assert.equal(lua(target, "return CalendarEventHaveSettingsChanged() and 1 or 0")[0], 0, "the alert is the new original");
  // Moderation from the invite list: Андуин becomes a moderator (CMSG_CALENDAR_EVENT_MODERATOR_STATUS).
  const anduin = lua(target, `for index = 1, CalendarEventGetNumInvites() do if CalendarEventGetInvite(index) == "Андуин" then return index end end`)[0];
  lua(target, `CalendarEventSetModerator(${anduin})`, 0);
  assert.deepEqual(target.calendar.server.calls.at(-1).args.slice(3, 4), [1]);
  await settle();
  const anduinNow = lua(target, `for index = 1, CalendarEventGetNumInvites() do if CalendarEventGetInvite(index) == "Андуин" then return index end end`)[0];
  assert.equal(lua(target, `return select(6, CalendarEventGetInvite(${anduinNow}))`)[0], "MODERATOR");
  // Delete from the day's menu, through its confirmation popup.
  clickEvent(target, "Мертвые копи (героич.)", "RightButton");
  assert.equal(shown(target, "CalendarContextMenu"), true);
  lua(target, "CalendarDayContextMenu_DeleteEvent()", 0);
  assert.equal(shown(target, "StaticPopup1"), true);
  lua(target, "StaticPopup1Button1:Click()", 0);
  await settle();
  assert.equal(target.calendar.server.calls.at(-1).name, "removeEvent");
  assert.equal(dayTexts(target, 24), "", "the removed alert takes the row away");
  assert.equal(shown(target, "CalendarCreateEventFrame"), false, "CALENDAR_CLOSE_EVENT closes the open event");
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
});

test("a holiday opens CalendarViewHolidayFrame; a guild event is signed up to", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  const errors = target.boot.errorCount;
  clickEvent(target, "Детская неделя");
  await settle();
  assert.equal(shown(target, "CalendarViewHolidayFrame"), true, JSON.stringify(lua(target, `return CalendarFrame.eventFrame and CalendarFrame.eventFrame:GetName() or "nil",
    CalendarFrame_GetModal() and CalendarFrame_GetModal():GetName() or "nil", CalendarGetEventIndex()`, 5)));
  assert.equal(lua(target, "return CalendarViewHolidayTitleFrameText:GetText()")[0], "Детская неделя");
  assert.match(lua(target, "return CalendarViewHolidayDescription:GetText()")[0], /сиротке/);
  lua(target, "CalendarFrame_CloseEvent()", 0);
  clickEvent(target, "Сбор гильдии");
  await settle();
  assert.equal(shown(target, "CalendarViewEventFrame"), true);
  assert.equal(lua(target, "return CalendarViewEventAcceptButton:GetText()")[0], lua(target, "return CALENDAR_SIGNUP")[0]);
  lua(target, "CalendarViewEventAcceptButton:Click()", 0);
  await settle();
  assert.deepEqual(target.calendar.server.calls.filter((call) => call.name === "signUp").at(-1).args.slice(1), [false]);
  const status = lua(target, `for index = 1, CalendarGetNumDayEvents(0, 20) do
    local title, _, _, _, _, _, _, _, status = CalendarGetDayEvent(0, 20, index)
    if title == "Сбор гильдии" then return status end end`)[0];
  assert.equal(status, 7, "CALENDAR_INVITESTATUS_SIGNEDUP");
  // The canned server answers as TrinityCore does (SMSG_CALENDAR_EVENT_INVITE, no EVENT_STATUS), and the
  // day's menu now offers to cancel the sign-up instead of a second one (the core would store a duplicate).
  lua(target, "CalendarFrame_CloseEvent()", 0);
  clickEvent(target, "Сбор гильдии", "RightButton");
  assert.equal(shown(target, "CalendarContextMenu"), true);
  const menu = lua(target, `local texts = {} for index = 1, 12 do local button = _G["CalendarContextMenuButton" .. index]
    if button and button:IsShown() and button:GetText() then texts[#texts + 1] = button:GetText() end end return table.concat(texts, "|")`)[0].split("|");
  assert.ok(menu.includes(lua(target, "return CALENDAR_REMOVE_SIGNUP")[0]), menu.join("|"));
  assert.ok(!menu.includes(lua(target, "return CALENDAR_SIGNUP")[0]), menu.join("|"));
  lua(target, "CalendarContextMenu_Hide()", 0);
  assert.equal(target.calendar.server.calls.filter((call) => call.name === "signUp").length, 1);
  assert.equal(target.boot.errorCount, errors, target.boot.vm.errors.slice(errors).join(" | "));
});

test("a mouse release on a day's second row opens that row, not the day's first (the release bubbles in the DOM)", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  // The 18th: Children's Week ends (row 1) and the raid invitation (row 2). The renderer's element for
  // the raid row sits inside the day button's element, and both registered LeftButtonUp.
  const [dayName, rowName] = lua(target, `for index = 1, 42 do local day = _G["CalendarDayButton" .. index]
    if day.monthOffset == 0 and day.day == 18 then return day:GetName(), day:GetName() .. "EventButton2" end end`, 2);
  target.renderer.sync();
  const row = target.renderer.elementFor(frame(target, rowName));
  const day = target.renderer.elementFor(frame(target, dayName));
  assert.ok(row && day, "both rows are drawn");
  const release = { type: "mouseup", button: 0, detail: 1, target: row, preventDefault() {}, stopPropagation() {} };
  for (const element of [row, day]) element.dispatchEvent(release);
  await settle();
  assert.equal(shown(target, "CalendarViewEventFrame"), true);
  assert.equal(shown(target, "CalendarViewHolidayFrame"), false, "the day's own OnClick did not open its first row");
  assert.equal(lua(target, "return CalendarViewEventTitle:GetText()")[0], "Наксрамас 25");
  // A release on the day itself still reaches the day (its first row).
  await new Promise((resolve) => setTimeout(resolve, 5));
  lua(target, "CalendarFrame_CloseEvent()", 0);
  day.dispatchEvent({ ...release, target: day });
  await settle();
  assert.equal(shown(target, "CalendarViewHolidayFrame"), true);
});

test("the route closes it; /calendar and ToggleCalendar reopen and close it", withClient, async () => {
  const target = await ready();
  await openCalendar(target);
  assert.equal(calendarRoute.closeFrameXmlCalendar(), true);
  assert.equal(shown(target, "CalendarFrame"), false);
  lua(target, "SlashCmdList.CALENDAR('')", 0);
  assert.equal(shown(target, "CalendarFrame"), true, "/calendar");
  lua(target, "ToggleCalendar()", 0);
  assert.equal(shown(target, "CalendarFrame"), false, "GameTimeFrame's ToggleCalendar");
  assert.equal(target.native.opens, 0);
});

test("a missing add-on demotes the owner: the native window opens and the stock entry points fall back", withClient, async () => {
  const target = await boot({ missingAddon: true });
  try {
    lua(target, "ToggleCalendar()", 0);
    await until(() => target.native.opens > 0, "the native window opened for the waiting player");
    assert.equal(calendarRoute.frameXmlCalendarPublished(), false, "the route answers false from now on");
    lua(target, "Calendar_Show()", 0);
    assert.equal(target.native.opens, 2, "Calendar_Show (the badge's click) reaches the native window");
  } finally {
    target.cleanup();
    target.boot.close();
  }
});

test("a gate that fails closes the owner: nothing stock stays shown and the waiting player gets the native window", withClient, async () => {
  for (const brokenOnShow of ["error", "empty"]) {
    const target = await boot({ brokenOnShow });
    try {
      lua(target, "ToggleCalendar()", 0);
      await until(() => target.native.opens > 0, `${brokenOnShow}: the native window opened for the waiting player`);
      assert.ok(frame(target, "CalendarFrame"), `${brokenOnShow}: the add-on loaded; its silent Show is what failed`);
      assert.equal(shown(target, "CalendarFrame"), false, `${brokenOnShow}: the stock frame stays hidden`);
      assert.equal(calendarRoute.frameXmlCalendarPublished(), false, `${brokenOnShow}: the route answers false from now on`);
      assert.equal(calendarRoute.frameXmlCalendarOwnsErrors(), false, `${brokenOnShow}: errors are the native notice's again`);
      lua(target, "ToggleCalendar()", 0);
      assert.equal(target.native.opens, 2, `${brokenOnShow}: GameTimeFrame's ToggleCalendar reaches the native window`);
      assert.equal(shown(target, "CalendarFrame"), false);
    } finally {
      target.cleanup();
      target.boot.close();
    }
  }
});
