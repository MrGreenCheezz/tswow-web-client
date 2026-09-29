import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildQuestLogView,
  questObjectiveLabel,
} from "../dist/code/world/QuestProtocol.js";

function questTemplate() {
  return {
    objectives: [
      { entry: 299, count: 10, gameObject: false, itemDrop: 0, text: "" },
      { entry: 1617, count: 1, gameObject: true, itemDrop: 0, text: "" },
      { entry: 448, count: 1, gameObject: false, itemDrop: 0, text: "Особая формулировка задания" },
    ],
    itemObjectives: [{ itemId: 769, count: 8 }],
  };
}

test("quest objectives preserve target identity for metadata-backed presentation", () => {
  const view = buildQuestLogView(
    [{ slot: 0, questId: 62, state: 0, counters: [3, 0, 1, 0], timer: 0 }],
    new Map([[62, questTemplate()]]),
    new Map([[769, 5]]),
  );

  assert.deepEqual(
    view[0].objectives.map(({ kind, id }) => [kind, id]),
    [["creature", 299], ["gameObject", 1617], ["creature", 448], ["item", 769]],
  );
});

test("resolved names replace numeric fallbacks while authored quest text remains authoritative", () => {
  const view = buildQuestLogView(
    [{ slot: 0, questId: 62, state: 0, counters: [3, 0, 1, 0], timer: 0 }],
    new Map([[62, questTemplate()]]),
    new Map([[769, 5]]),
  );
  const [creature, gameObject, authored, item] = view[0].objectives;

  assert.equal(questObjectiveLabel(creature, "Лесной волк"), "Лесной волк");
  assert.equal(questObjectiveLabel(gameObject, "Сундук Братства"), "Сундук Братства");
  assert.equal(questObjectiveLabel(item, "Кусок мяса вепря"), "Кусок мяса вепря");
  assert.equal(questObjectiveLabel(authored, "Волк"), "Особая формулировка задания");

  assert.equal(questObjectiveLabel(creature), "Существо #299");
  assert.equal(questObjectiveLabel(gameObject), "Объект #1617");
  assert.equal(questObjectiveLabel(item), "Предмет #769");
});

test("tracker item objectives remain pointer-interactive for their inventory tooltip", async () => {
  const css = await readFile(new URL("../src/browser/style.css", import.meta.url), "utf8");
  assert.match(css, /#quest-tracker\s+\.quest-objective-item\s*\{[^}]*pointer-events:\s*auto\s*;/);
});
