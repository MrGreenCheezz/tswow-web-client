import assert from "node:assert/strict";
import test from "node:test";
import { OPCODES } from "../dist/code/generated/opcodes.js";
import { missReasonText } from "../dist/code/world/MissReasons.js";
import { settle, spellGoPacket, spellLogMissPacket, travelClient } from "./fixtures/world-packets.mjs";

// 1.18. `SpellMissInfo` (shared/SharedDefines.h:1543-1556): 1 MISS, 2 RESIST, 3 DODGE, 4 PARRY,
// 5 BLOCK, 6 EVADE, 7 IMMUNE, 8 IMMUNE2 ("one of these 2 is MISS_TEMPIMMUNE"), 9 DEFLECT,
// 10 ABSORB, 11 REFLECT. There is no 12. The old table ran one step behind from 8 on: an immunity
// floated as «отражено», an absorb as «отражено» and a reflect as «не в цель».
const EXPECTED = new Map([
  [1, "промах"], [2, "сопротивление"], [3, "уклонение"], [4, "парирование"], [5, "блок"],
  [6, "уклонение"], [7, "иммунитет"], [8, "иммунитет"], [9, "отклонено"], [10, "поглощено"],
  [11, "отражено"],
]);

test("every SpellMissInfo value has its own word, and anything else is a plain miss", () => {
  for (const [missInfo, word] of EXPECTED) assert.equal(missReasonText(missInfo), word, `missInfo ${missInfo}`);
  assert.equal(missReasonText(0), "промах", "SPELL_MISS_NONE never reaches a miss log, but it is not a word of its own");
  assert.equal(missReasonText(12), "промах", "there is no twelfth reason in this core");
  assert.equal(missReasonText(255), "промах");
});

test("four miss logs float the words of their own reasons", async () => {
  const self = 0x1234n;
  const caster = 0xf130_0000_0000_0042n;
  const { client, connection } = await travelClient([], self);
  const floating = [];
  client.events.on("FLOATING_TEXT", (text) => floating.push(text));
  try {
    // The core writes one SMSG_SPELLLOGMISS per target (Object.cpp:2775) — only for a miss decided
    // when the spell lands (Spell.cpp:2467-2471) — so four reasons are four packets.
    for (const missInfo of [8, 9, 10, 11]) {
      connection.push(OPCODES.SMSG_SPELLLOGMISS, spellLogMissPacket({ spellId: 133, caster, target: self, missInfo }));
    }
    await settle();
    assert.deepEqual(floating.map((text) => [text.guid, text.kind, text.text]), [
      [self, "miss", "иммунитет"],
      [self, "miss", "отклонено"],
      [self, "miss", "поглощено"],
      [self, "miss", "отражено"],
    ]);
  } finally {
    client.close();
  }
});

test("misses decided at cast time come in SMSG_SPELL_GO, and float and reach the hit indicator too", async () => {
  // Resist, dodge, parry, deflect, absorb, reflect and immunity are rolled when the spell goes off
  // and written only into SPELL_GO's miss list (Spell::UpdateSpellCastDataTargets,
  // Spell.cpp:4677-4708); no SPELLLOGMISS follows for them (:2445-2476). Nothing read that list but
  // the spell visuals, so the words above were almost never seen.
  const self = 0x1234n;
  const creature = 0xf130_0000_0000_0042n;
  const [hit, reflected, absorbed, immune, deflected] = [0x51n, 0x52n, 0x53n, 0x54n, 0x55n];
  const { client, connection } = await travelClient([], self);
  const floating = [];
  const combat = [];
  const casts = [];
  client.events.on("FLOATING_TEXT", (text) => floating.push(text));
  client.events.on("UNIT_COMBAT", (event) => combat.push(event));
  client.events.on("SPELL_GO", (cast) => casts.push(cast));
  const misses = [
    { guid: reflected, reason: 11, reflect: 0 }, { guid: absorbed, reason: 10 },
    { guid: immune, reason: 7 }, { guid: deflected, reason: 9 },
  ];
  try {
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: self, castId: 3, spellId: 133, hits: [hit], misses }));
    // Another caster's cast is told the same way, as the miss log is: the overlay and the portraits
    // decide whom they show.
    connection.push(OPCODES.SMSG_SPELL_GO, spellGoPacket({ caster: creature, spellId: 9053, misses: [{ guid: self, reason: 2 }] }));
    await settle();
    assert.deepEqual(floating.map((text) => [text.guid, text.kind, text.amount, text.text]), [
      [reflected, "miss", 0, "отражено"],
      [absorbed, "miss", 0, "поглощено"],
      [immune, "miss", 0, "иммунитет"],
      [deflected, "miss", 0, "отклонено"],
      [self, "miss", 0, "сопротивление"],
    ], "a word per miss and none for the hit");
    assert.deepEqual(combat, [
      { source: "miss", casterGuid: self, targetGuid: reflected, spellId: 133, missInfo: 11 },
      { source: "miss", casterGuid: self, targetGuid: absorbed, spellId: 133, missInfo: 10 },
      { source: "miss", casterGuid: self, targetGuid: immune, spellId: 133, missInfo: 7 },
      { source: "miss", casterGuid: self, targetGuid: deflected, spellId: 133, missInfo: 9 },
      { source: "miss", casterGuid: creature, targetGuid: self, spellId: 9053, missInfo: 2 },
    ]);
    // The spell visuals still read the whole cast, misses included (SpellVisualLifecycle.ts).
    assert.deepEqual(casts[0]?.hits, [hit]);
    assert.deepEqual(casts[0]?.misses.map((miss) => [miss.guid, miss.reason]),
      [[reflected, 11], [absorbed, 10], [immune, 7], [deflected, 9]]);
  } finally {
    client.close();
  }
});
