import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { UPDATE_FIELDS } from "../dist/code/generated/updateFields.js";
import { GO_TYPE_CHEST } from "../dist/code/world/GameObjectProtocol.js";
import { LOCK_KEY_ITEM, LOCK_KEY_SKILL } from "../dist/code/world/LockRules.js";
import { game } from "../dist/code/browser/game/Context.js";
import { gameObjectLockHint } from "../dist/code/browser/game/Interaction.js";

// G9: a vein, a herb or a chest without a known opener used to eat the click in silence.
// The hint names the missing piece from the same Lock.dbc data the opener matching reads.

const bytes1 = (type) => (type << 8) >>> 0;

function chest(entry = 500, flags = 0) {
  return {
    guid: 9n, typeId: 5,
    fields: new Map([
      [UPDATE_FIELDS.GAMEOBJECT_BYTES_1.offset, bytes1(GO_TYPE_CHEST)],
      [UPDATE_FIELDS.GAMEOBJECT_FLAGS.offset, flags],
      [UPDATE_FIELDS.OBJECT_FIELD_ENTRY.offset, entry],
    ]),
    position: { x: 0, y: 0, z: 0 },
  };
}

const template = (lockId) => ({
  entry: 500, type: GO_TYPE_CHEST, displayId: 1, name: "Сундук",
  iconName: "", castBarCaption: "", data: [lockId], size: 1,
});

function fakeWorld({ lockId = 123, knownSpells = [] } = {}) {
  return {
    knownSpells: knownSpells.map((id) => ({ id, slot: 0 })),
    gameObjectTemplates: new Map([[500, template(lockId)]]),
    gameObjectTemplate: (entry) => (entry === 500 ? template(lockId) : undefined),
  };
}

function stubLocks({ ready = true, opener = 0, cases = [] } = {}) {
  game.locks = {
    ready,
    spellFor: () => opener,
    casesOf: () => cases,
  };
}

const near = { x: 1, y: 0, z: 0 };
const far = { x: 500, y: 0, z: 0 };

test("a lock without a known opener names the profession", () => {
  const previous = game.locks;
  try {
    stubLocks({ cases: [{ type: LOCK_KEY_SKILL, index: 2, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), near), "Нужен навык: Травничество");
    stubLocks({ cases: [{ type: LOCK_KEY_SKILL, index: 3, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), near), "Нужен навык: Горное дело");
    stubLocks({ cases: [{ type: LOCK_KEY_SKILL, index: 1, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), near), "Нужен навык: Вскрытие замков");
    stubLocks({ cases: [{ type: LOCK_KEY_ITEM, index: 0, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), near), "Нужен ключ");
  } finally {
    game.locks = previous;
  }
});

test("no hint when there is an opener, no lock, no template, no data or no range", () => {
  const previous = game.locks;
  try {
    stubLocks({ opener: 3365, cases: [{ type: LOCK_KEY_SKILL, index: 2, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld({ knownSpells: [3365] }), chest(), near), undefined,
      "an opener means the click works");
    stubLocks({ cases: [{ type: LOCK_KEY_SKILL, index: 2, skill: 0 }] });
    assert.equal(gameObjectLockHint(fakeWorld({ lockId: 0 }), chest(), near), undefined,
      "lockless objects are not a lock story");
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), far), undefined,
      "a hint is for what is in reach");
    const unknown = fakeWorld();
    unknown.gameObjectTemplate = () => undefined;
    unknown.gameObjectTemplates = new Map();
    assert.equal(gameObjectLockHint(unknown, chest(), near), undefined,
      "a pending query stays silent");
  } finally {
    game.locks = previous;
  }
});

test("unloaded lock data says it is loading rather than guessing", () => {
  const previous = game.locks;
  try {
    game.locks = undefined;
    assert.equal(gameObjectLockHint(fakeWorld(), chest(), near), "Данные замков загружаются…");
  } finally {
    game.locks = previous;
  }
});

test("the click and the target frame surface the hint instead of swallowing it", async () => {
  const npc = await readFile(new URL("../src/browser/ui/Npc.ts", import.meta.url), "utf8");
  assert.match(npc, /gameObjectLockHint\(world, target, self\.position\)/,
    "the eaten click notices the missing skill");
  const frames = await readFile(new URL("../src/browser/ui/Frames.ts", import.meta.url), "utf8");
  assert.match(frames, /lockHint \?\? "Использовать"/, "the button labels itself with the hint");
  assert.match(frames, /aria-disabled/, "marked, never disabled — the loot button's rule");
});
