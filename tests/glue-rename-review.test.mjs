import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";
import { GlueSession } from "../dist/code/browser/glue/GlueSession.js";

/**
 * The review fixes to 2.07/10.05 (30.09): one reader on the socket, the client's own checks in
 * RenameCharacter (FUN_004e3410 → FUN_004d8d20), EnterWorld's gate (FUN_004d9bd0), and no status
 * dialog left without an answer to close it.
 */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    GlueScreenInfo = {};
    SEEN = {};
    CHAR_RENAME_IN_PROGRESS = "Переименование персонажа...";
    function SetGlueScreen(name) end
  `,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>
          self:RegisterEvent("FORCE_RENAME_CHARACTER");
          self:RegisterEvent("OPEN_STATUS_DIALOG");
          self:RegisterEvent("CLOSE_STATUS_DIALOG");
          self:RegisterEvent("CHARACTER_LIST_UPDATE");
          self:RegisterEvent("UPDATE_STATUS_DIALOG");
        </OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event .. " / " .. tostring(arg1) .. " / " .. tostring(arg2);</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

/**
 * A stage whose world records every read it is asked for and whether another was still waiting —
 * the second reader a cancelled rename used to leave behind — and whose rows can carry any flags.
 */
async function reviewStage({ flags = { 1: 0x4000 }, canRename = true, cvars = {} } = {}) {
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  const characters = base.map((character, at) => ({ ...character, flags: character.flags | (flags[at] ?? 0) }));
  const reads = [];
  let waiting = 0;
  let overlapped = 0;
  const pending = [];
  const read = (kind, answer) => {
    reads.push(kind);
    if (waiting > 0) overlapped += 1;
    waiting += 1;
    return answer.finally(() => { waiting -= 1; });
  };
  const world = {
    characters: () => read("characters", Promise.resolve(characters.map((character) => ({ ...character })))),
    deleteCharacter: () => read("delete", Promise.resolve(71)),
    close: () => {},
  };
  if (canRename) {
    world.renameCharacter = (guid, name) => read(`rename ${name}`, new Promise((resolve) => { pending.push(resolve); }));
  }
  const entered = [];
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      session: { connect: async () => world },
      enterWorld: (request) => entered.push([request.index, request.character.name]),
    },
  });
  await runtime.load();
  runtime.session.beginSession(canned.auth);
  await runtime.session.connect(canned.realm);
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-rename-review");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  for (const [name, value] of Object.entries(cvars)) lua(`SetCVar("${name}", "${value}"); return 1`);
  const seen = () => {
    const text = lua('return table.concat(SEEN, "\\n")');
    return typeof text === "string" && text ? text.split("\n") : [];
  };
  const clearSeen = () => lua("SEEN = {}; return 1");
  const settle = async () => {
    for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve));
  };
  clearSeen();
  reads.length = 0;
  return {
    runtime, lua, seen, clearSeen, settle, entered, base, reads,
    overlapped: () => overlapped,
    answer: async (result) => { await settle(); pending.shift()(result); },
  };
}

test("a cancelled rename's answer is still read before the list is asked for again: one reader", async () => {
  const stage = await reviewStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    // The list is asked for while the rename's answer is still on its way.
    stage.lua("GetCharacterListUpdate(); return 1");
    await stage.settle();
    assert.deepEqual(stage.reads, ["rename Ана"], "the list request waits for the rename's answer");
    await stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.reads, ["rename Ана", "characters"]);
    assert.equal(stage.overlapped(), 0, "never two reads in flight on one connection");
  } finally {
    stage.runtime.close();
  }
});

test("a success that arrives after the cancel renames the row quietly, as the client applies it", async () => {
  const stage = await reviewStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.clearSeen();
    await stage.answer({ result: 0, guid: stage.base[1].guid, name: "Ана" });
    await stage.settle();
    assert.deepEqual(stage.seen(), ["CHARACTER_LIST_UPDATE / nil / nil"], "no dialog, no rename dialog");
    assert.equal(stage.lua("return (GetCharacterInfo(2))"), "Ана");
    assert.deepEqual(stage.entered, [], "a cancelled wait does not carry on into the world");
    // The row lost its rename flag, so the next EnterWorld passes the rename step — and, with the
    // declined flag cleared too (FUN_004e2870), stops at the declension frame for a Russian name (10.09).
    stage.lua("EnterWorld(); return 1");
    assert.deepEqual(stage.entered, []);
    assert.equal(stage.seen().some((line) => line.startsWith("FORCE_RENAME_CHARACTER")), false);
  } finally {
    stage.runtime.close();
  }
});

test("a refusal that arrives after the cancel says nothing", async () => {
  const stage = await reviewStage();
  try {
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.clearSeen();
    await stage.answer({ result: 48 });
    await stage.settle();
    assert.deepEqual(stage.seen(), []);
    assert.equal(stage.lua("return (GetCharacterInfo(2))"), stage.base[1].name);
  } finally {
    stage.runtime.close();
  }
});

test("EnterWorld while a cancelled rename is unanswered waits for the answer, then checks again", async () => {
  const stage = await reviewStage();
  try {
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.lua("SelectCharacter(1); EnterWorld(); return 1");
    assert.deepEqual(stage.entered, [], "the world would be a second reader on the socket");
    await stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.entered, [[1, "Аларин"]]);
  } finally {
    stage.runtime.close();
  }
});

test("a waiting EnterWorld is dropped once the player has left the screen or picked another character", async () => {
  // The wait is a WebClient artefact (one reader on the socket); the click it stands for must not
  // fire later from the creation screen, or for a character the player has moved away from.
  const stage = await reviewStage();
  try {
    stage.lua('SetCurrentGlueScreenName("charselect"); return 1');
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.lua("SelectCharacter(1); EnterWorld(); return 1");
    stage.lua('SetCurrentGlueScreenName("charcreate"); return 1');
    await stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.entered, [], "no world entry from the creation screen");

    stage.lua('SetCurrentGlueScreenName("charselect"); return 1');
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.lua("SelectCharacter(1); EnterWorld(); SelectCharacter(3); return 1");
    await stage.answer({ result: 89 });
    await stage.settle();
    assert.deepEqual(stage.entered, [], "the click was for character 1, and 3 is selected now");

    // The latest click is the one that counts.
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), 1);
    stage.lua("StatusDialogClick(); return 1");
    stage.lua("SelectCharacter(1); EnterWorld(); SelectCharacter(3); EnterWorld(); return 1");
    await stage.answer({ result: 89 });
    await stage.settle();
    assert.equal(stage.entered.length, 1);
    assert.equal(stage.entered[0][0], 3);
  } finally {
    stage.runtime.close();
  }
});

test("a success enters with the row the answer names, not a stale list that still asks for a name", async () => {
  // The world's list is never updated here: a re-read would hand back the old row, flag and all.
  const stage = await reviewStage();
  try {
    stage.lua("SelectCharacter(2); return 1");
    assert.equal(stage.lua('return RenameCharacter(2, "Анабель")'), 1);
    stage.clearSeen();
    await stage.answer({ result: 0, guid: stage.base[1].guid, name: "Анабель" });
    await stage.settle();
    assert.deepEqual(stage.seen(), ["CLOSE_STATUS_DIALOG / nil / nil", "CHARACTER_LIST_UPDATE / nil / nil"]);
    // Not the rename dialog again: the declension step (10.09) — a Russian name, and the rename
    // cleared the declined flag — is what stops the world entry now.
    assert.deepEqual(stage.entered, []);
    assert.deepEqual(stage.reads, ["rename Анабель"], "no second CMSG_CHAR_ENUM");
  } finally {
    stage.runtime.close();
  }
});

test("RenameCharacter does nothing without a name or the rename flag, and refuses the current name", async () => {
  const stage = await reviewStage();
  try {
    const name = stage.base[1].name;
    assert.equal(stage.lua('return RenameCharacter(2, "")'), undefined);
    assert.equal(stage.lua("return RenameCharacter(2, nil)"), undefined);
    assert.equal(stage.lua('return RenameCharacter(1, "Ана")'), undefined, "character 1 has no rename flag");
    assert.deepEqual(stage.seen(), [], "FUN_004e3410 returns before any event");
    // The same name in another case is the same name (FUN_0076ea40 folds case).
    assert.equal(stage.lua(`return RenameCharacter(2, "${name.toUpperCase()}")`), undefined);
    assert.equal(stage.lua(`return RenameCharacter(2, "${name.toLowerCase()}")`), undefined);
    assert.deepEqual(stage.seen(), [
      "FORCE_RENAME_CHARACTER / CHAR_CREATE_NAME_IN_USE / nil",
      "FORCE_RENAME_CHARACTER / CHAR_CREATE_NAME_IN_USE / nil",
    ]);
    assert.deepEqual(stage.reads, []);
  } finally {
    stage.runtime.close();
  }
});

test("Ё is its own letter to the current-name check, so a name that differs only there is sent", async () => {
  const stage = await reviewStage();
  try {
    const name = stage.base[1].name;
    const at = [...name].findIndex((letter) => letter === "е" || letter === "Е");
    assert.ok(at >= 0, `fixture name ${name} has an Е to swap`);
    const letters = [...name];
    letters[at] = letters[at] === "е" ? "ё" : "Ё";
    const swapped = letters.join("");
    assert.equal(stage.lua(`return RenameCharacter(2, "${swapped}")`), 1);
    await stage.settle();
    assert.deepEqual(stage.reads, [`rename ${swapped}`]);
  } finally {
    stage.runtime.close();
  }
});

test("forceEnglishNames limits the new name to ASCII letters", async () => {
  const stage = await reviewStage({ cvars: { forceEnglishNames: "1" } });
  try {
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), undefined);
    assert.deepEqual(stage.seen(), ["FORCE_RENAME_CHARACTER / CHAR_NAME_INVALID_CHARACTER / nil"]);
    assert.equal(stage.lua('return RenameCharacter(2, "Ana")'), 1);
    await stage.settle();
    assert.deepEqual(stage.reads, ["rename Ana"]);
  } finally {
    stage.runtime.close();
  }
});

test("a connection that cannot rename brings the rename dialog back instead of a CANCEL dialog nobody closes", async () => {
  const stage = await reviewStage({ canRename: false });
  try {
    assert.equal(stage.lua('return RenameCharacter(2, "Ана")'), undefined);
    assert.deepEqual(stage.seen(), ["FORCE_RENAME_CHARACTER / CHAR_RENAME_FAILED / nil"]);
  } finally {
    stage.runtime.close();
  }
});

test("EnterWorld refuses a locked character with codes 84 and 85 before it asks for a new name", async () => {
  const stage = await reviewStage({ flags: { 0: 0x4 | 0x4000, 1: 0x01000000 | 0x4000, 2: 0x4000 } });
  try {
    stage.lua([
      'CHAR_LOGIN_LOCKED_FOR_TRANSFER = "перенос"',
      'CHAR_LOGIN_LOCKED_BY_BILLING = "оплата"',
      "SelectCharacter(1); EnterWorld()",
      "SelectCharacter(2); EnterWorld()",
      "SelectCharacter(3); EnterWorld()",
      "return 1",
    ].join("; "));
    // Each OKAY dialog is re-measured once visible (UPDATE_STATUS_DIALOG), like every glue dialog.
    assert.deepEqual(stage.seen(), [
      "OPEN_STATUS_DIALOG / OKAY / перенос",
      "UPDATE_STATUS_DIALOG / перенос / nil",
      "OPEN_STATUS_DIALOG / OKAY / оплата",
      "UPDATE_STATUS_DIALOG / оплата / nil",
      "FORCE_RENAME_CHARACTER / CHAR_RENAME_DESCRIPTION / nil",
    ]);
    assert.deepEqual(stage.entered, []);
  } finally {
    stage.runtime.close();
  }
});

test("the character screen's own OKAY dialogs are re-measured once visible", async () => {
  const stage = await reviewStage();
  try {
    stage.lua("SelectCharacter(0); EnterWorld(); return 1");
    assert.deepEqual(stage.seen(), [
      "OPEN_STATUS_DIALOG / OKAY / Персонаж не выбран.",
      "UPDATE_STATUS_DIALOG / Персонаж не выбран. / nil",
    ]);
  } finally {
    stage.runtime.close();
  }
});

test("a rename cancelled while it waits in the queue is never sent", async () => {
  // Wow.exe sends CMSG_CHAR_RENAME inside RenameCharacter, so its CANCEL always comes after the packet.
  // Queued behind another request here (`GlueSession.request`), a rename cancelled before its turn
  // must not reach the character afterwards.
  const canned = fakeGlueSession("charselect");
  const base = await (await canned.connect()).characters();
  const sent = [];
  let hold = false;
  let releaseList;
  const world = {
    characters: async () => {
      if (hold) await new Promise((resolve) => { releaseList = resolve; });
      return base.map((character) => ({ ...character }));
    },
    deleteCharacter: async () => 71,
    renameCharacter: async (guid, name) => { sent.push(name); return { result: 0, guid, name }; },
    close: () => {},
  };
  const session = new GlueSession({ connect: async () => world, fireEvent: () => {} });
  session.beginSession(canned.auth);
  await session.connect(canned.realm);
  hold = true;
  const refresh = session.refreshCharacters();
  for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.busy, true, "the list request holds the queue");
  const pending = session.renameCharacter(2, "Ана");
  session.cancelPending();
  releaseList();
  await refresh;
  assert.equal((await pending).status, "cancelled");
  assert.deepEqual(sent, [], "nothing goes out after the CANCEL");
  assert.equal(session.characters[1].name, base[1].name, "the row is untouched");
  // A rename that is not cancelled still goes out once the queue frees.
  assert.equal((await session.renameCharacter(2, "Ана")).status, "answered");
  assert.deepEqual(sent, ["Ана"]);
});
