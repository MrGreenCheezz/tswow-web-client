import assert from "node:assert/strict";
import test from "node:test";

const {
  CannedWorldSeam,
  CANNED_SKILL_ROWS,
} = await import("../dist/code/browser/framexml/CannedWorldSeam.js");
const { FRAMEXML_SEAM_BINDINGS, FRAMEXML_SEAM_EVENTS } =
  await import("../dist/code/browser/framexml/FrameXmlWorldSeam.js");

const call = (name, seam, ...args) => FRAMEXML_SEAM_BINDINGS[name](seam, args);

test("Canned SkillFrame answers exact rows, signed bonuses, selection and collapse", () => {
  for (const name of [
    "GetNumSkillLines", "GetSkillLineInfo", "GetAdjustedSkillPoints", "GetSelectedSkill",
    "SetSelectedSkill", "ExpandSkillHeader", "CollapseSkillHeader", "AddSkillUp",
    "RemoveSkillUp", "BuySkillTier", "CancelSkillUps",
  ]) assert.equal(typeof FRAMEXML_SEAM_BINDINGS[name], "function", name);
  assert.equal(FRAMEXML_SEAM_EVENTS.skillLinesChanged, "SKILL_LINES_CHANGED");

  const seam = new CannedWorldSeam();
  const fired = [];
  seam.attach({ now: () => 1, fire: (event, ...args) => {
    fired.push([event, ...args]);
    return 1;
  } });
  fired.length = 0;

  assert.deepEqual(call("GetNumSkillLines", seam), [CANNED_SKILL_ROWS.length]);
  assert.deepEqual(call("GetSkillLineInfo", seam, 1), [
    "Профессии", true, true, 0, 0, 0, 0, false, undefined, undefined, 0, 0, "",
  ]);
  assert.deepEqual(call("GetSkillLineInfo", seam, 2), [
    "Кузнечное дело", false, true, 412, -5, 10, 450, false,
    undefined, undefined, 0, 0, "",
  ]);
  assert.deepEqual(call("GetAdjustedSkillPoints", seam), [0]);
  assert.deepEqual(call("GetSelectedSkill", seam), [0]);

  call("SetSelectedSkill", seam, 2);
  assert.deepEqual(call("GetSelectedSkill", seam), [2]);
  call("SetSelectedSkill", seam, 2);
  assert.deepEqual(fired, [], "selection is immediate UI state, not a world mutation event");

  call("CollapseSkillHeader", seam, 1);
  assert.deepEqual(call("GetNumSkillLines", seam), [3]);
  assert.deepEqual(call("GetSkillLineInfo", seam, 2), [
    "Второстепенные", true, true, 0, 0, 0, 0, false, undefined, undefined, 0, 0, "",
  ]);
  assert.deepEqual(call("GetSelectedSkill", seam), [0],
    "hidden selected skill is retained internally and becomes visible again on expand");
  assert.deepEqual(fired, [["SKILL_LINES_CHANGED"]]);
  fired.length = 0;

  call("CollapseSkillHeader", seam, 1);
  assert.deepEqual(fired, [], "repeating collapse is silent");
  call("ExpandSkillHeader", seam, 1);
  assert.deepEqual(call("GetNumSkillLines", seam), [5]);
  assert.deepEqual(call("GetSelectedSkill", seam), [2]);
  assert.deepEqual(fired, [["SKILL_LINES_CHANGED"]]);
  fired.length = 0;

  // The current protocol has no skill-training request. All four stock entry points are inert.
  call("AddSkillUp", seam, 2);
  call("RemoveSkillUp", seam, 2);
  call("BuySkillTier", seam, 2);
  call("CancelSkillUps", seam);
  assert.deepEqual(fired, [], "unsupported training operations do not fabricate events");
  seam.detach();
});
