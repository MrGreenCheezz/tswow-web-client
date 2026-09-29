import assert from "node:assert/strict";
import test, { after } from "node:test";

// MPQ-backed: the stock player menu's «Покинуть группу» (UnitPopup.lua:1271-1272) through the real
// corpus. On 2026-09-28 it reached the stub floor — offered for a dungeon-finder group of four bots,
// the click closed the menu, counted one stub call and sent nothing. The chat API is installed over
// the loaded VM the way the world mount installs it, against a recording world.
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

const { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { CannedWorldSeam } = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_VERTICAL_TOC } = await import("../dist/code/browser/framexml/FrameXmlCorpus.js");
const { installFrameXmlChatApi } = await import("../dist/code/browser/framexml/FrameXmlChatApi.js");
const decoder = new TextDecoder("utf-8");

test("the player menu's LEAVE reaches WorldClient.leaveGroup once, never the stub floor", withClient, async () => {
  const boot = new FrameXmlBoot({
    provider: { async read(path) { const data = await chain.read(path); return data ? decoder.decode(data) : undefined; } },
    locale: "ruRU", subset: FRAMEXML_VERTICAL_TOC, seam: new CannedWorldSeam(),
    exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS, screen: () => ({ width: 1920, height: 1080 }),
  });
  try {
    await boot.load();
    const calls = [];
    const world = { leaveGroup() { calls.push("leaveGroup"); } };
    const installed = installFrameXmlChatApi(boot.vm, {
      world: () => world, notice() {}, cast() {}, use() {}, unitGuid: () => undefined,
    });
    assert.ok(installed.installed.includes("LeaveParty"));
    const errors = boot.errorCount;
    // PlayerFrame's right click (PlayerFrame.lua: ToggleDropDownMenu on PlayerFrameDropDown, whose
    // initializer is UnitPopup_ShowMenu(..., "SELF")), then a click on the LEAVE row.
    const ran = boot.vm.execute(`
      __leave_party = GetNumPartyMembers()
      ToggleDropDownMenu(1, nil, PlayerFrameDropDown, "PlayerFrame", 106, 27)
      local row
      for index = 1, (DropDownList1.numButtons or 0) do
        local button = _G["DropDownList1Button" .. index]
        if button.value == "LEAVE" then row = button end
      end
      __leave_shown = row and 1 or 0
      __leave_enabled = row and (row:IsEnabled() and 1 or 0) or -1
      __leave_label = row and row:GetText() == PARTY_LEAVE and 1 or 0
      if row then row:Click("LeftButton") end
      __leave_stub = __fxCalls["LeaveParty"] or 0
      __leave_menu = DropDownList1:IsShown() and 1 or 0
    `, "@leave-party-vertical");
    assert.equal(ran.ok, true, ran.error);
    const read = (name) => boot.vm.getGlobal(name);
    assert.equal(read("__leave_party"), 4, "the canned party: four members, as the bots were");
    assert.equal(read("__leave_shown"), 1, "UnitPopup_HideButtons keeps LEAVE for a party (UnitPopup.lua:638-640)");
    assert.equal(read("__leave_enabled"), 1);
    assert.equal(read("__leave_label"), 1, "the row is GlobalStrings' PARTY_LEAVE");
    assert.deepEqual(calls, ["leaveGroup"], "one CMSG_GROUP_DISBAND");
    assert.equal(read("__leave_stub"), 0, "the stub floor is never reached");
    assert.equal(read("__leave_menu"), 0, "the menu closes");
    assert.deepEqual(boot.errors.slice(errors).map((error) => error.message), []);
  } finally {
    boot.close();
  }
});
