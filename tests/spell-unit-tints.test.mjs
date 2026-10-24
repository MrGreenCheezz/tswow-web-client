import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { UnitTints, WHITE, flashColour } from "../dist/code/browser/UnitTints.js";
import { planSpellAuraState, planSpellVisual } from "../dist/code/browser/SpellVisuals.js";
import { cloneMaterialTinted } from "../dist/code/browser/ModelBuild.js";
import { kitColour, loadSpellVisualKits } from "../dist/code/gateway/SpellVisual.js";
import { dbcDirectory } from "../tools/paths.mjs";

// 25.10 (6.27): a kit's CharProc 1 tint and CharProc 13 flash on its unit (CGUnit_C::CreateProceduralEffect 0x007265c0,
// UpdateModelTint 0x00720db0, GetFlashColor 0x0071a9a0).

const kit = (extra) => ({ startAnimation: -1, animation: -1, sound: 0, effects: [], ...extra });

test("6.27 a kit colour parameter is Wow.exe's int | 0xFF000000 read as b, g, r — 0xRRGGBB", () => {
  assert.equal(kitColour(6711039), 0x6666ff, "Frost Nova's 0x6666ff: blue");
  assert.equal(kitColour(65280), 0x00ff00);
  assert.equal(kitColour(0), 0);
  assert.equal(kitColour(-1), undefined);
  assert.equal(kitColour(Number.NaN), undefined);
});

test("6.27 the planner puts a kit's tint on its unit for the kit's life, and nothing on a point", () => {
  const visual = { id: 122, state: kit({ tint: 0x6666ff }), impact: kit({ flash: { colour: 0xff0000, delayMs: 500, durationMs: 500 } }) };
  const aura = planSpellAuraState(visual, { guid: 7n, point: { x: 0, y: 0, z: 0 } }, 1000);
  assert.deepEqual(aura.tints, [{ guid: 7n, startedAt: 1000, endsAt: Number.POSITIVE_INFINITY, tint: 0x6666ff }]);
  const go = planSpellVisual(visual, { caster: 1n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 7n, point: { x: 1, y: 0, z: 0 } }] }, 0);
  assert.equal(go.tints?.length, 1);
  assert.deepEqual(go.tints[0].flash, { colour: 0xff0000, delayMs: 500, durationMs: 500 });
  const point = planSpellVisual(visual, { caster: 0n, casterPoint: { x: 0, y: 0, z: 0 }, targets: [{ guid: 0n, point: { x: 1, y: 0, z: 0 } }] }, 0);
  assert.equal(point.tints, undefined, "no unit, no tint");
});

test("6.27 the newest tint wins, a cast's end takes its tint, a flash outranks a tint and fades to white", () => {
  const tints = new UnitTints();
  const frost = {}, poison = {};
  tints.add(frost, [{ guid: 7n, tint: 0x6666ff, startedAt: 0, endsAt: Number.POSITIVE_INFINITY }]);
  assert.equal(tints.colourOf(7n, 10), 0x6666ff);
  tints.add(poison, [{ guid: 7n, tint: 0x1db015, startedAt: 20, endsAt: 1000 }]);
  assert.equal(tints.colourOf(7n, 30), 0x1db015, "newest");
  assert.equal(tints.colourOf(7n, 1000), 0x6666ff, "the poison ran out");
  tints.cancel(frost);
  assert.equal(tints.colourOf(7n, 1001), WHITE);
  tints.add(poison, [{ guid: 7n, tint: 0x123456, startedAt: 0, endsAt: 1e9,
    flash: { colour: 0xff0000, delayMs: 100, durationMs: 200 } }]);
  assert.equal(tints.colourOf(7n, 50), 0xff0000, "held through the delay");
  const half = tints.colourOf(7n, 200);
  assert.equal(half, flashColour({ colour: 0xff0000, startedAt: 0, delayMs: 100, durationMs: 200 }, 200));
  assert.equal(half, 0xff8080, "half way back to white");
  assert.equal(tints.colourOf(7n, 400), 0x123456, "the flash is over, the tint shows again");
  tints.cancel(poison);
  assert.equal(tints.empty, true);
});

test("6.27 a tinted copy multiplies the colour and keeps the program", () => {
  const source = new THREE.MeshLambertMaterial({ color: 0xffffff });
  source.customProgramCacheKey = () => "body-key";
  const copy = cloneMaterialTinted(source, 0x6666ff);
  assert.equal(copy.customProgramCacheKey(), "body-key");
  assert.equal(copy.transparent, source.transparent);
  assert.equal(copy.color.getHex(), 0x6666ff);
  assert.equal(source.color.getHex(), 0xffffff, "the shared material is untouched");
});

const dbc = (() => { try { return dbcDirectory(); } catch { return ""; } })();
test("6.27 the gateway reads CharProc 1 and 13 off the dataset's kits", { skip: existsSync(join(dbc, "SpellVisualKit.dbc")) ? false : "no dataset DBCs" }, async () => {
  const kits = await loadSpellVisualKits(dbc);
  assert.equal(kits.get(285)?.tint, 0x6666ff, "Frost Nova's state kit");
  assert.deepEqual(kits.get(68)?.flash, { colour: 0x4f6bf0, delayMs: 500, durationMs: 500 });
});

test("6.27 the client accepts a kit's tint and flash and refuses a malformed one", async () => {
  const { SpellVisualKitClient } = await import("../dist/code/browser/SpellVisualClient.js");
  const client = new SpellVisualKitClient("ws://127.0.0.1:8090/ws");
  assert.equal(client.accept({ id: 1, kit: kit({ tint: 0x6666ff, flash: { colour: 0xff0000, delayMs: 0, durationMs: 500 } }) }), true);
  assert.equal(client.accept({ id: 1, kit: kit({ tint: 0x1000000 }) }), false);
  assert.equal(client.accept({ id: 1, kit: kit({ flash: { colour: 0xff0000, delayMs: "0", durationMs: 500 } }) }), false);
  assert.equal(client.accept({ id: 1, kit: kit({}) }), true, "an older gateway's kit without them");
});

test("6.27 the renderer tints a living, unfaded unit's model from the registry, and gives the copies back", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  assert.match(source, /this\.#applyUnitTint\(unit, dead \|\| opacity < 1 \|\| unit\.opacityBorrows !== undefined \? WHITE : this\.#unitTints\.colourOf\(object\.guid, now\)\);\n\s+\}\n\s+this\.#applyUnitOpacity\(unit, opacity/);
  assert.match(source, /this\.#releaseUnitTint\(unit\);[^\n]*\n\s+this\.#releaseUnitOpacity\(unit\);/);
  assert.match(source, /if \(plan\.tints && plan\.tints\.length > 0\) this\.#unitTints\.add\(handle, plan\.tints\);/);
  assert.match(source, /this\.#unitTints\.cancel\(handle\);/);
});
