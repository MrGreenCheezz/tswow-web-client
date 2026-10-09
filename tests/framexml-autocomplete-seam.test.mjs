import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.18 (L5c, 04.10): GetAutoCompleteResults as Wow.exe 3.3.5a 12340 answers it
// (0x0057b3a0 → 0x0057b250 → 0x0057aca0; list order 0x0057b130; fold 0x0076e8d0). The rules are in
// FrameXmlAutoComplete.ts; the Ghidra notes in .runtime/re-2026-10-04/l5c/.
const {
  FrameXmlAutoCompleteModel, frameXmlAutoCompleteFold, FRAMEXML_AUTOCOMPLETE_BINDINGS,
} = await import("../dist/code/browser/framexml/FrameXmlAutoComplete.js");
const { FRAMEXML_SEAM_BINDINGS } = await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");
const { EventBus } = await import("../dist/code/world/EventBus.js");

// AutoComplete.lua:3-10.
const IN_GROUP = 0x1, IN_GUILD = 0x2, FRIEND = 0x4, BNET = 0x8, ONLINE = 0x20, ALL = 0xffffffff;
const SELF = 0x1n;

function makeWorld() {
  const names = new Map();
  return {
    state: { selfGuid: SELF },
    names,
    events: new EventBus(),
    contacts: { flags: 7, contacts: [] },
    guildRoster: { welcomeText: "", infoText: "", ranks: [], members: [] },
    group: undefined,
  };
}

function harness(world = makeWorld(), extra = {}) {
  let clock = 1000;
  const model = new FrameXmlAutoCompleteModel({ world: () => world, now: () => clock, ...extra });
  model.attach();
  return { world, model, tick: (ms = 10) => { clock += ms; } };
}

const friend = (guid, online) => ({ guid, flags: 1, note: "", status: online ? 1 : 0, areaId: 0, level: 0, classId: 0 });
const guildMember = (guid, name, online) => ({ guid, name, online, status: online ? 1 : 0, rankId: 0, level: 80, classId: 1, gender: 0, areaId: 0, lastSaveDays: 0, note: "", officerNote: "" });
const whisper = (world, guid, type = 7, language = 0) => world.events.emit("CHAT_MESSAGE", {
  type, language, senderGuid: guid, senderName: "", receiverGuid: 0n, receiverName: "", channel: "", text: "hi", tag: 0, achievementId: 0,
});

test("the fold is Wow.exe's: Latin and Cyrillic case-insensitive, Ё between Е and Ж", () => {
  const fold = (char) => frameXmlAutoCompleteFold(char.codePointAt(0));
  assert.equal(fold("a"), fold("A"));
  assert.equal(fold("é"), fold("É"));
  assert.equal(fold("я"), fold("Я"));
  assert.equal(fold("а"), fold("А"));
  assert.equal(fold("ё"), fold("Ё"));
  assert.ok(fold("Е") < fold("Ё") && fold("Ё") < fold("Ж"), "Ё sorts after Е and before Ж");
  assert.notEqual(fold("Ё"), fold("Е"), "Ё is not Е");
  assert.equal(fold("1"), 0x31);
});

test("friends, guild and group, filtered by include/exclude; the character itself never", () => {
  const { world, model } = harness();
  world.names.set(0x10n, "Вася");
  world.names.set(0x11n, "Валера");
  world.contacts.contacts.push(friend(0x10n, true), friend(0x11n, false));
  world.guildRoster.members.push(guildMember(0x20n, "Варвара", true), guildMember(SELF, "Ваня", true));
  world.group = { members: [{ name: "Вадим", guid: 0x30n, online: true, status: 1, subGroup: 0, flags: 0, roles: 0 }] };
  // ALL: alphabetical (no whisper yet), the player left out.
  assert.deepEqual([...model.results(["ва", ALL, 0, 10])], ["Вадим", "Валера", "Варвара", "Вася"]);
  // ONLINE_NOT_IN_GROUP (AutoComplete.lua:25-28): online, not in the group, no Battle.net.
  assert.deepEqual([...model.results(["Ва", ONLINE, IN_GROUP | BNET, 10])], ["Варвара", "Вася"]);
  // FRIEND (:44-47), NOT_FRIEND (:33-36), IN_GUILD (:41-43).
  assert.deepEqual([...model.results(["в", FRIEND, BNET, 10])], ["Валера", "Вася"]);
  assert.deepEqual([...model.results(["в", ALL, FRIEND | BNET, 10])], ["Вадим", "Варвара"]);
  assert.deepEqual([...model.results(["в", IN_GUILD, BNET, 10])], ["Варвара"]);
  // numReturns: the drop-down asks for one more than it shows; 0 and below return everything.
  assert.deepEqual([...model.results(["в", ALL, 0, 2])], ["Вадим", "Валера"]);
  assert.equal(model.results(["в", ALL, 0, 0]).length, 4);
  // A non-matching prefix, and a text longer than every name.
  assert.deepEqual([...model.results(["Вz", ALL, 0, 10])], []);
  assert.deepEqual([...model.results(["Вадимыч", ALL, 0, 10])], []);
});

test("a name equal to the text is left out unless allowFullMatch", () => {
  const { world, model } = harness();
  world.guildRoster.members.push(guildMember(0x20n, "Ингвар", true), guildMember(0x21n, "Ингварр", true));
  assert.deepEqual([...model.results(["ингвар", ALL, 0, 10])], ["Ингварр"]);
  assert.deepEqual([...model.results(["ингвар", ALL, 0, 10, undefined, true])], ["Ингвар", "Ингварр"]);
});

test("whispers in both directions put the partner first, most recent first; add-on whispers do not", () => {
  const { world, model, tick } = harness();
  for (const [guid, name] of [[0x40n, "Аня"], [0x41n, "Алла"], [0x42n, "Ада"], [0x43n, "Ася"]]) world.names.set(guid, name);
  world.guildRoster.members.push(guildMember(0x42n, "Ада", false));
  whisper(world, 0x40n, 7);
  tick();
  whisper(world, 0x41n, 9);
  tick();
  whisper(world, 0x43n, 7, 0xffffffff);
  whisper(world, 0x43n, 7, -1);
  assert.deepEqual([...model.results(["а", ALL, 0, 10])], ["Алла", "Аня", "Ада"]);
  tick();
  whisper(world, 0x40n, 7);
  assert.deepEqual([...model.results(["а", ALL, 0, 10])], ["Аня", "Алла", "Ада"]);
  // A whisper partner is ONLINE until the realm says the name is not found.
  assert.deepEqual([...model.results(["а", ONLINE, 0, 10])], ["Аня", "Алла"]);
  world.events.emit("CHAT_PLAYER_NOT_FOUND", { name: "АНЯ" });
  assert.deepEqual([...model.results(["а", ONLINE, 0, 10])], ["Алла"]);
  assert.deepEqual([...model.results(["а", ALL, 0, 10])], ["Аня", "Алла", "Ада"], "the node stays: INTERACTED_WITH is never taken back");
  model.detach();
  tick();
  whisper(world, 0x42n, 7);
  assert.deepEqual([...model.results(["а", ALL, 0, 10])], ["Аня", "Алла", "Ада"], "detached: no more whispers recorded");
});

test("editing from the centre: the text before the cursor starts the name, the rest follows later", () => {
  const { world, model } = harness();
  world.guildRoster.members.push(guildMember(0x50n, "Тралл", true), guildMember(0x51n, "Тирион", true), guildMember(0x52n, "Траки", true));
  // «Тл|» typed with the cursor after «Т»: «Т…л…».
  assert.deepEqual([...model.results(["Тл", ALL, 0, 10, 1])], ["Тралл"]);
  // 0x0057ad57-0x0057ad80 tries name length − text length starts from the cursor: the last place the
  // rest could stand is not tried, so «Траки»'s final «и» is not found while «Тирион»'s second letter is.
  assert.deepEqual([...model.results(["Ти", ALL, 0, 10, 1])], ["Тирион"]);
  assert.deepEqual([...model.results(["Тк", ALL, 0, 10, 1])], ["Траки"], "«к» before the last place");
  // The cursor at the end (or out of range) is the plain prefix test.
  assert.deepEqual([...model.results(["Тр", ALL, 0, 10, 2])], ["Траки", "Тралл"]);
  assert.deepEqual([...model.results(["Тр", ALL, 0, 10, 9])], ["Траки", "Тралл"]);
  assert.deepEqual([...model.results(["Тр", ALL, 0, 10, -1])], ["Траки", "Тралл"]);
  // With the CVar off the cursor is ignored.
  const off = harness(world, { cvar: (name) => (name === "autoCompleteWhenEditingFromCenter" ? "0" : undefined) });
  assert.deepEqual([...off.model.results(["Тл", ALL, 0, 10, 1])], []);
});

test("autoCompleteUseContext off ignores the flags; recency off sorts by name only", () => {
  const { world } = harness();
  world.guildRoster.members.push(guildMember(0x60n, "Бета", true), guildMember(0x61n, "Альфа", true));
  const noContext = harness(world, { cvar: (name) => (name === "autoCompleteUseContext" ? "0" : undefined) });
  assert.deepEqual([...noContext.model.results(["", FRIEND, IN_GUILD, 10])], ["Альфа", "Бета"]);
  const noRecency = harness(world, { cvar: (name) => (name === "autoCompleteResortNamesOnRecency" ? "0" : undefined) });
  world.names.set(0x60n, "Бета");
  whisper(world, 0x60n, 7);
  assert.deepEqual([...noRecency.model.results(["", ALL, 0, 10])], ["Альфа", "Бета"]);
});

test("a guild left is not read; the binding answers through the seam table", () => {
  let inGuild = true;
  const { world, model } = harness(makeWorld(), { inGuild: () => inGuild });
  world.guildRoster.members.push(guildMember(0x70n, "Гром", true));
  assert.deepEqual([...model.results(["г", ALL, 0, 10])], ["Гром"]);
  inGuild = false;
  assert.deepEqual([...model.results(["г", ALL, 0, 10])], []);
  inGuild = true;
  assert.equal(FRAMEXML_SEAM_BINDINGS.GetAutoCompleteResults, FRAMEXML_AUTOCOMPLETE_BINDINGS.GetAutoCompleteResults);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetAutoCompleteResults({ autoComplete: model }, ["г", ALL, 0, 1])], ["Гром"]);
  assert.deepEqual([...FRAMEXML_SEAM_BINDINGS.GetAutoCompleteResults({}, ["г", ALL, 0, 1])], []);
  assert.deepEqual([...model.results([undefined, ALL, 0, 1])], [], "no text: nothing");
});
