import assert from "node:assert/strict";
import test from "node:test";

// GetInventoryAlertStatus and UPDATE_INVENTORY_ALERTS by the client's own rules (Wow.exe 3.3.5a
// 12340, read 2026-09-30): the status of one slot 0x005e8fe0, the recompute 0x005e90d0 (event id
// 0x1b5, then 0x1b6 UPDATE_INVENTORY_DURABILITY regardless), the Lua answer 0x005e7fa0.
const {
  FRAMEXML_INVENTORY_ALERTS_EVENT, FRAMEXML_INVENTORY_ALERT_COUNT, createFrameXmlInventoryAlerts,
  frameXmlAmmoAlertStatus, frameXmlItemAlertStatus,
} = await import("../dist/code/browser/framexml/FrameXmlInventoryAlerts.js");

test("an item's status: broken at 0, low at an absolute 5 or less, and the two flags", () => {
  assert.equal(frameXmlItemAlertStatus(0, 40, 40), 0);
  assert.equal(frameXmlItemAlertStatus(0, 8, 40), 0, "a fifth is not the client's mark");
  assert.equal(frameXmlItemAlertStatus(0, 6, 40), 0);
  assert.equal(frameXmlItemAlertStatus(0, 5, 40), 1);
  assert.equal(frameXmlItemAlertStatus(0, 1, 120), 1);
  assert.equal(frameXmlItemAlertStatus(0, 0, 40), 2);
  assert.equal(frameXmlItemAlertStatus(0, undefined, 40), 2, "an unset durability reads 0");
  assert.equal(frameXmlItemAlertStatus(0, 3, 0), 0, "no maximum: no durability at all");
  assert.equal(frameXmlItemAlertStatus(0, 3, undefined), 0);
  assert.equal(frameXmlItemAlertStatus(0x08, 0, 40), 0, "wrapped");
  assert.equal(frameXmlItemAlertStatus(0x10, 40, 40), 2, "ITEM_FIELD_FLAGS 0x10 is broken whatever the wear");
  assert.equal(frameXmlItemAlertStatus(0x18, 40, 40), 2, "0x10 is tested before the wrapping");
  assert.equal(frameXmlItemAlertStatus(0x01, 4, 40), 1, "soulbound changes nothing");
});

test("the ammo's status: 20 or fewer carried is low, no ammo entry is sound", () => {
  assert.equal(frameXmlAmmoAlertStatus(2512, 21), 0);
  assert.equal(frameXmlAmmoAlertStatus(2512, 20), 1);
  assert.equal(frameXmlAmmoAlertStatus(2512, 0), 1);
  assert.equal(frameXmlAmmoAlertStatus(undefined, 0), 0);
  assert.equal(frameXmlAmmoAlertStatus(0, 0), 0);
});

function pumpAt() {
  const fired = [];
  let now = 0;
  return {
    pump: { fire: (event, ...args) => { fired.push([event, ...args]); return 1; }, now: () => now },
    fired,
    advance: (seconds) => { now += seconds; },
  };
}

test("UPDATE_INVENTORY_ALERTS fires once when any of the twelve statuses changes, never otherwise", () => {
  const statuses = new Array(FRAMEXML_INVENTORY_ALERT_COUNT + 1).fill(0);
  const asked = new Set();
  const alerts = createFrameXmlInventoryAlerts((index) => { asked.add(index); return statuses[index]; });
  const { pump, fired, advance } = pumpAt();
  alerts.tick();
  assert.equal(asked.size, 0, "detached: nothing is read");
  alerts.attach(pump);
  alerts.tick();
  assert.deepEqual(fired, [], "all sound at the start: no event");
  assert.deepEqual([...asked].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "1-based, the ammo twelfth included");
  statuses[4] = 1;
  alerts.tick();
  assert.deepEqual(fired, [], "within the poll interval");
  advance(0.25);
  alerts.tick();
  assert.deepEqual(fired, [[FRAMEXML_INVENTORY_ALERTS_EVENT]]);
  advance(0.25);
  alerts.tick();
  assert.equal(fired.length, 1, "the same statuses: no second event");
  statuses[4] = 2;
  statuses[12] = 1;
  advance(0.25);
  alerts.tick();
  assert.equal(fired.length, 2, "two changes in one pass: one event");
  statuses[4] = 0;
  statuses[12] = 0;
  advance(0.25);
  alerts.tick();
  assert.equal(fired.length, 3, "back to sound is a change too");
  alerts.detach();
  statuses[1] = 2;
  advance(1);
  alerts.tick();
  assert.equal(fired.length, 3, "detached: no event");
});

test("a new attach starts from zeros, so worn gear already on raises the event on the first poll", () => {
  const statuses = new Array(FRAMEXML_INVENTORY_ALERT_COUNT + 1).fill(0);
  statuses[9] = 2;
  const alerts = createFrameXmlInventoryAlerts((index) => statuses[index]);
  const first = pumpAt();
  alerts.attach(first.pump);
  alerts.tick();
  assert.deepEqual(first.fired, [[FRAMEXML_INVENTORY_ALERTS_EVENT]]);
  const second = pumpAt();
  alerts.attach(second.pump);
  alerts.tick();
  assert.deepEqual(second.fired, [[FRAMEXML_INVENTORY_ALERTS_EVENT]], "the late mount's DurabilityFrame learns of it too");
});
