// 6.18 review (line A7a, slice G, 05.10): Wow.exe 0x004e3cd0 hangs the select-screen figure's
// weapons with no sheath state (0x004eacd0: ranged on attachment 2, the left hand). That is the
// select screen's rule only: the creation screen draws CharStartOutfit, whose rows carry a melee
// weapon beside a ranged one (a rogue: dagger, off-hand dagger and a thrown knife), and was not
// checked against Wow.exe — it keeps the hang it had (ranged stowed, melee in the hands).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SHEATH_MELEE, SHEATH_RANGED, attachmentPoint } from "../dist/code/browser/Attachment.js";
import { figureSheath } from "../dist/code/browser/glue/CharSelectWorn.js";
import { characterLook } from "../dist/code/browser/glue/GlueCharacterScene.js";

function summary(classId) {
  const equipment = Array.from({ length: 23 }, () => ({ displayId: 0, inventoryType: 0 }));
  equipment[17] = { displayId: 1017, inventoryType: 15 };
  return {
    guid: 7n, name: "Тест", race: 1, classId, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, flags: 0, equipment,
  };
}

test("the select screen holds the ranged weapon; any other figure keeps the melee hang", () => {
  assert.equal(figureSheath(17, true), SHEATH_RANGED);
  assert.equal(figureSheath(15, true), SHEATH_MELEE);
  assert.equal(figureSheath(16, true), SHEATH_MELEE);
  assert.equal(figureSheath(17, false), SHEATH_MELEE, "the creation screen: not checked, unchanged");
  const knife = { slot: 17, inventoryType: 25, path: "knife.m2" };
  const dagger = { slot: 16, inventoryType: 22, path: "dagger.m2" };
  // The rogue's CharStartOutfit row: an off-hand dagger and a thrown knife must not share the left hand.
  assert.notEqual(attachmentPoint(knife, figureSheath(17, false)), attachmentPoint(dagger, figureSheath(16, false)));
});

test("a select-screen look says so; the creation look does not", async () => {
  assert.equal(characterLook(summary(3), 49).charSelect, true);
  const creation = await readFile(new URL("../src/browser/glue/GlueCreation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(creation, /charSelect\s*:/, "GlueCreation.sceneLook never claims the select screen");
  const scene = await readFile(new URL("../src/browser/glue/GlueCharacterScene.ts", import.meta.url), "utf8");
  assert.match(scene, /attachmentPoint\(item, figureSheath\(item\.slot, charSelect\)\)/,
    "hangAttachments hangs by the look's screen");
  assert.match(scene, /hangAttachments\(request, wvm, appearance, instance, template, look\.charSelect === true\)/);
});
