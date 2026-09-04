import assert from "node:assert/strict";
import test from "node:test";

const { CannedWorldSeam, CANNED_HONOR } =
  await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

function api(seam, name, ...args) {
  const binding = FRAMEXML_SEAM_BINDINGS[name];
  assert.equal(typeof binding, "function", `${name} seam binding exists`);
  return [...binding(seam, args)];
}

test("Canned Honor answers exact stock PvP tuples without retired rank data", () => {
  const seam = new CannedWorldSeam();
  assert.deepEqual(api(seam, "GetPVPSessionStats"), [
    CANNED_HONOR.todayHonorableKills,
    CANNED_HONOR.todayContribution,
  ]);
  assert.deepEqual(api(seam, "GetPVPYesterdayStats"), [
    CANNED_HONOR.yesterdayHonorableKills,
    CANNED_HONOR.yesterdayContribution,
  ]);
  assert.deepEqual(api(seam, "GetPVPLifetimeStats"), [
    CANNED_HONOR.lifetimeHonorableKills,
    undefined,
  ]);
  assert.deepEqual(api(seam, "GetPVPRankInfo", undefined), [undefined, 0]);
  assert.deepEqual(api(seam, "UnitPVPRank", "player"), []);
  assert.deepEqual(api(seam, "UnitPVPRank", "target"), []);
  assert.deepEqual(api(seam, "GetPVPRankProgress"), [0]);
});

test("Canned Honor seeds one update edge and detaches silently", () => {
  const seam = new CannedWorldSeam();
  const events = [];
  const pump = {
    now: () => 100,
    fire(event, ...args) {
      events.push([event, ...args]);
      return 1;
    },
  };
  seam.attach(pump);
  assert.equal(events.filter(([event]) =>
    event === FRAMEXML_SEAM_EVENTS.pvpKillsChanged).length, 1);
  seam.detach();
  events.length = 0;
  seam.tick(101);
  assert.deepEqual(events, []);
});
