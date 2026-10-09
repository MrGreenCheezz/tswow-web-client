import assert from "node:assert/strict";
import test, { after } from "node:test";

// The session edges of Wow.exe 3.3.5a 12340 (read-only Ghidra, .runtime/re-2026-09-30/a2-lifecycle):
// the game-UI start (0x0052a980) marks the character not logged in, runs FrameXML.toc (the TSWoW
// blocks included), then every enabled add-on with its ADDON_LOADED (0x005f80b0), then asks for the
// account data whose arrival raises VARIABLES_LOADED (0x00518bf0 — at once when it is at hand), and
// with the player in the world enters it (0x00528010): PLAYER_LOGIN once per UI, right before the
// first PLAYER_ENTERING_WORLD. IsLoggedIn (0x0060a450) answers 1 from that moment, nil before.
// FrameXML.toc itself raises no ADDON_LOADED. Only primitives read back from Lua are compared.
const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");

const RECORDER = `
  EVENT_LOG = {}
  local function note(text) EVENT_LOG[#EVENT_LOG + 1] = text end
  note("load:" .. tostring(IsLoggedIn()))
  local frame = CreateFrame("Frame")
  for _, name in ipairs({ "ADDON_LOADED", "VARIABLES_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD" }) do
    frame:RegisterEvent(name)
  end
  frame:SetScript("OnEvent", function(self, event, name)
    note(event .. (name and ("(" .. name .. ")") or "") .. ":" .. tostring(IsLoggedIn()))
  end)
`;

function fixture() {
  return createFixtureProvider({
    "interface/framexml/framexml.toc": "Recorder.lua",
    "interface/framexml/recorder.lua": RECORDER,
    "interface/addons/eager/eager.toc": "## Interface: 30300\nEager.lua",
    "interface/addons/eager/eager.lua": "EAGER_RAN = true",
  });
}

function log(boot) {
  const fn = boot.vm.compileFunction("return table.concat(EVENT_LOG, ' ')", "login-log", []);
  try { return String(boot.vm.call(fn, [], 1)[0]).split(" "); } finally { boot.vm.release(fn); }
}

test("the vertical session edges run in Wow.exe's order: add-ons, variables, login, world", async () => {
  assert.deepEqual([...FRAMEXML_VERTICAL_EXERCISE_EVENTS], ["VARIABLES_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD"]);
  const boot = new FrameXmlBoot({
    provider: fixture(), eagerAddons: ["Eager"], installedAddons: ["Eager"],
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS,
  });
  try {
    await boot.load();
    assert.equal(boot.vm.getGlobal("EAGER_RAN"), true);
    assert.deepEqual(log(boot), [
      "load:nil",
      "ADDON_LOADED(Eager):nil",
      "VARIABLES_LOADED:nil",
      "PLAYER_LOGIN:1",
      "PLAYER_ENTERING_WORLD:1",
    ]);
  } finally {
    boot.close();
  }
});

test("IsLoggedIn is nil through a boot without the login edge and 1 after it", async () => {
  const quiet = new FrameXmlBoot({ provider: fixture(), exerciseEvents: ["VARIABLES_LOADED"] });
  try {
    await quiet.load();
    assert.deepEqual(log(quiet), ["load:nil", "VARIABLES_LOADED:nil"]);
  } finally {
    quiet.close();
  }
});

// The stock vertical: UIParent's PLAYER_LOGIN runs CombatLog_LoadUI (UIParent.lua:480-483), which
// UIParentLoadAddOn's Blizzard_CombatLog through a synchronous LoadAddOn; without an owner of that
// add-on (plan item 3.01) a `message()` dialog would greet every session. RaidFrame's PLAYER_LOGIN
// asks GetNumRaidMembers. Neither may raise, and no dialog may open.
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
after(() => chain?.close());

test("the stock vertical takes PLAYER_LOGIN without an error or a load-failure dialog", withClient, async () => {
  const decoder = new TextDecoder("utf-8");
  const boot = new FrameXmlBoot({
    provider: {
      async read(path) {
        const data = await chain.read(path);
        return data ? decoder.decode(data) : undefined;
      },
    },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1365, height: 768 }),
    beforeExercise: (loaded) => {
      loaded.vm.execute(`
        LOGIN_DIALOGS = {}
        local stock = message
        message = function(text, ...) LOGIN_DIALOGS[#LOGIN_DIALOGS + 1] = tostring(text); return stock(text, ...) end
      `, "@login-test:message");
    },
  });
  try {
    const inventory = await boot.load();
    assert.deepEqual(inventory.exercise.events, ["VARIABLES_LOADED", "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD"]);
    const fn = boot.vm.compileFunction(
      "return #LOGIN_DIALOGS, table.concat(LOGIN_DIALOGS, '|'), IsLoggedIn(), IsAddOnLoaded('Blizzard_CombatLog') and 1 or 0",
      "login-probe", []);
    const [dialogs, texts, loggedIn, combatLog] = boot.vm.call(fn, [], 4);
    boot.vm.release(fn);
    assert.equal(dialogs, 0, `no load-failure dialog: ${texts}`);
    assert.equal(loggedIn, 1);
    assert.equal(combatLog, 0, "the combat log stays unloaded until its owner (3.01)");
    assert.equal(inventory.exercise.errorsAfter - inventory.exercise.errorsBefore, 0, "no Lua error in the session events");
  } finally {
    boot.close();
  }
});

// The UI teardown (0x00528f00): with the character in the world, the world exit's
// PLAYER_LEAVING_WORLD (0x00528c30) comes before PLAYER_LOGOUT; outside it only PLAYER_LOGOUT.
async function teardown(exerciseEvents, inCombat = false) {
  const seen = [];
  const boot = new FrameXmlBoot({
    provider: createFixtureProvider({
      "interface/framexml/framexml.toc": "Teardown.lua",
      "interface/framexml/teardown.lua": `
        local frame = CreateFrame("Frame")
        frame:RegisterEvent("PLAYER_LEAVING_WORLD"); frame:RegisterEvent("PLAYER_LOGOUT")
        frame:RegisterEvent("PLAYER_REGEN_ENABLED")
        frame:SetScript("OnEvent", function(self, event) __teardownNote(event) end)
        ${inCombat ? 'UnitAffectingCombat = function(unit) if unit == "player" then return 1 end end' : ""}
      `,
    }),
    exerciseEvents,
  });
  boot.vm.registerGlobal("__teardownNote", (args) => { seen.push(String(args[0])); return []; });
  await boot.load();
  boot.close();
  return seen;
}

test("closing the UI in the world raises PLAYER_LEAVING_WORLD, then PLAYER_LOGOUT", async () => {
  assert.deepEqual(await teardown(FRAMEXML_VERTICAL_EXERCISE_EVENTS), ["PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
  assert.deepEqual(await teardown(["VARIABLES_LOADED"]), ["PLAYER_LOGOUT"], "never entered: no leave");
});

test("closing the UI in combat first raises PLAYER_REGEN_ENABLED (0x00528f00, the unit's in-combat flag)", async () => {
  // Review A2-3: before the world exit the teardown raises event 0x99 (PLAYER_REGEN_ENABLED) when the
  // character's unit flags carry UNIT_FLAG_IN_COMBAT (bit 19), so handlers waiting for combat to end run.
  assert.deepEqual(await teardown(FRAMEXML_VERTICAL_EXERCISE_EVENTS, true),
    ["PLAYER_REGEN_ENABLED", "PLAYER_LEAVING_WORLD", "PLAYER_LOGOUT"]);
  assert.deepEqual(await teardown(["VARIABLES_LOADED"], true), ["PLAYER_LOGOUT"], "not in the world: no character, no regen");
});
