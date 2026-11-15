import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { UnitTints, UNIT_ALPHA_FADE_MS, WHITE } from "../dist/code/browser/UnitTints.js";
import { auraStandInOpacity, unitDisplayAlpha } from "../dist/code/browser/UnitDisplayFade.js";
import { planSpellAuraState } from "../dist/code/browser/SpellVisuals.js";
import { loadSpellVisualKits } from "../dist/code/gateway/SpellVisual.js";
import { dbcDirectory } from "../tools/paths.mjs";

// 15.11 (6.11): a SpellVisualKit's CharProc 14 is Wow.exe's unit +0x984 record (CGUnit_C::CreateProceduralEffect
// 0x007265c0: alpha CharParamZero when 0 < alpha ≤ 1, time CharParamTwo × 1000 ms); 0x0071abe0 fades the model's alpha
// byte (0x00744030) to CreatureModelAlpha × the newest record's alpha over its time, or 1000 ms without one.

const kit = (extra) => ({ startAnimation: -1, animation: -1, sound: 0, effects: [], ...extra });
const tint = (unitAlpha, startedAt = 0, endsAt = Number.POSITIVE_INFINITY) => ({ guid: 7n, startedAt, endsAt, unitAlpha });

test("6.11 the newest live CharProc 14 record sets the factor and the time; none is 1 over 1000 ms", () => {
  const tints = new UnitTints();
  assert.deepEqual(tints.alphaOf(7n, 0), { alpha: 1, ms: UNIT_ALPHA_FADE_MS });
  const older = {};
  const newer = {};
  tints.add(older, [tint({ alpha: 0.3, ms: 1000 })]);
  tints.add(newer, [tint({ alpha: 0.5, ms: 0 })]);
  assert.deepEqual(tints.alphaOf(7n, 10), { alpha: 0.5, ms: 1000, held: true }, "the newest; its time 0 reads as 1000 (0x0071abe0)");
  assert.equal(tints.colourOf(7n, 10), WHITE, "an alpha record tints nothing");
  tints.cancel(newer);
  assert.deepEqual(tints.alphaOf(7n, 10), { alpha: 0.3, ms: 1000, held: true }, "the aura's end refades to the next head");
  tints.cancel(older);
  assert.deepEqual(tints.alphaOf(7n, 10), { alpha: 1, ms: UNIT_ALPHA_FADE_MS });
  tints.add(older, [tint({ alpha: 0.3, ms: 2000 }, 0, 50)]);
  assert.deepEqual(tints.alphaOf(7n, 60), { alpha: 1, ms: UNIT_ALPHA_FADE_MS }, "an ended kit's record is gone");
});

test("6.11 a live record takes the place of the stealth stand-in instead of multiplying it", () => {
  // Stealth (spell 1784, visual 184) carries StateKit 312's record 0.3: the unit is 0.3, not 0.35 × 0.3.
  assert.equal(auraStandInOpacity(0.35, true), 1);
  assert.equal(auraStandInOpacity(0.35, false), 0.35, "no record (kit not known yet): the stand-in stays");
});

test("6.11 the unit's alpha byte walks to the record's alpha over the record's time, in whole bytes (0x0071ac30)", () => {
  const unit = {};
  assert.equal(unitDisplayAlpha(unit, 1, 0), 1, "the first look at once");
  assert.equal(unitDisplayAlpha(unit, 0.3, 100, 2000), 1, "the fade starts now");
  // from 255 to round(0.3·255) = 76 over 2000 ms: at 1000 ms 255 + trunc(−179·1000/2000) = 166.
  assert.equal(Math.round(unitDisplayAlpha(unit, 0.3, 1100, 2000) * 255), 166);
  assert.equal(Math.round(unitDisplayAlpha(unit, 0.3, 2100, 2000) * 255), 76);
});

test("6.11 the planner carries a state kit's CharProc 14 on its unit for the aura's life", () => {
  const visual = { id: 184, state: kit({ unitAlpha: { alpha: 0.3, ms: 1000 } }) };
  const aura = planSpellAuraState(visual, { guid: 7n, point: { x: 0, y: 0, z: 0 } }, 1000);
  assert.deepEqual(aura.tints, [{ guid: 7n, startedAt: 1000, endsAt: Number.POSITIVE_INFINITY, unitAlpha: { alpha: 0.3, ms: 1000 } }]);
});

test("6.11 the client accepts a kit's unitAlpha and refuses one outside (0, 1]", async () => {
  const { SpellVisualKitClient } = await import("../dist/code/browser/SpellVisualClient.js");
  const client = new SpellVisualKitClient("ws://127.0.0.1:8090/ws");
  assert.equal(client.accept({ id: 1, kit: kit({ unitAlpha: { alpha: 0.5, ms: 0 } }) }), true);
  assert.equal(client.accept({ id: 1, kit: kit({ unitAlpha: { alpha: 0, ms: 0 } }) }), false);
  assert.equal(client.accept({ id: 1, kit: kit({ unitAlpha: { alpha: 0.5, ms: -1 } }) }), false);
});

const dbc = (() => { try { return dbcDirectory(); } catch { return ""; } })();
test("6.11 the gateway reads CharProc 14 off the dataset's kits", { skip: existsSync(join(dbc, "SpellVisualKit.dbc")) ? false : "no dataset DBCs" }, async () => {
  const kits = await loadSpellVisualKits(dbc);
  // Dataset rows: kit 312 CharProc [7, 14, −1, −1], CharParamZero[1] 0.3, CharParamTwo[1] 1; kit 3450 [14, …] 0.5, 0;
  // kit 5129 [14, …] 0 — no record (0x007265c0 takes 0 < alpha ≤ 1).
  const k312 = kits.get(312)?.unitAlpha;
  assert.ok(k312 && Math.abs(k312.alpha - 0.3) < 1e-6 && k312.ms === 1000, JSON.stringify(k312));
  assert.deepEqual(kits.get(3450)?.unitAlpha, { alpha: 0.5, ms: 0 });
  assert.equal(kits.get(5129)?.unitAlpha, undefined);
});
