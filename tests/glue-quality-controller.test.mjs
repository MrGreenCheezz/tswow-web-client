import test from "node:test";
import assert from "node:assert/strict";
import {
  GLUE_QUALITY_STEPS,
  GLUE_QUALITY_TARGET_MS,
  GlueQualityController,
  glueQualityEffectiveStep,
  glueQualityStepChangesWork,
} from "../dist/code/browser/glue/GlueModelStage.js";

function moveDown(controller, now = 0) {
  let moved;
  for (let index = 0; index < 8; index += 1) {
    now += 260;
    moved = controller.sample(GLUE_QUALITY_TARGET_MS * 8, now);
  }
  assert.ok(moved, "the hot representative samples should move the controller");
  return now;
}

test("quality steering ignores no-due/scenery-skip samples until a representative redraw", () => {
  const controller = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  let now = moveDown(controller);
  const beforeSkips = controller.step;

  // A static scene can run hundreds of cheap clock passes without another model draw. Those passes
  // must not look like headroom and trigger the fast-up lane by themselves.
  for (let index = 0; index < 120; index += 1) {
    now += 33;
    assert.equal(controller.sample(1, now, { representative: false }), undefined);
  }
  assert.equal(controller.step, beforeSkips);

  // Once the animated/actor view actually redraws, normal recovery is allowed to start. It still
  // takes the controller's representative window rather than one cheap no-due tick.
  for (let index = 0; index < 180; index += 1) {
    now += 33;
    controller.sample(1, now, { representative: true });
  }
  assert.ok(controller.step < beforeSkips, `${controller.step} should recover after representative work`);
  assert.ok(controller.step >= 0 && controller.step < GLUE_QUALITY_STEPS.length);
});

test("a rare static dirty redraw cannot lower quality permanently", () => {
  const controller = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  let now = 0;
  // The static backdrop is expensive once when a texture settles, but it has no moving work to
  // steer. Repeated dirty/no-due observations therefore leave the quality rung at native.
  for (let index = 0; index < 120; index += 1) {
    now += 33;
    controller.sample(40, now, { representative: false });
  }
  assert.equal(controller.step, 0);
  assert.equal(controller.current.name, GLUE_QUALITY_STEPS[0].name);
});

test("quality skips no-op rungs for the two native-sized login subjects", () => {
  const views = [{
    boxWidth: 1280, boxHeight: 720, subject: true, moving: true, somebody: true,
  }, {
    boxWidth: 1280, boxHeight: 720, subject: true, moving: true, somebody: true,
  }];
  const options = { dpr: 1, subjects: 2 };
  assert.equal(glueQualityStepChangesWork(GLUE_QUALITY_STEPS[0], GLUE_QUALITY_STEPS[1], views, options), false);
  assert.equal(glueQualityStepChangesWork(GLUE_QUALITY_STEPS[0], GLUE_QUALITY_STEPS[7], views, options), false);
  assert.equal(glueQualityStepChangesWork(GLUE_QUALITY_STEPS[0], GLUE_QUALITY_STEPS[8], views, options), true);
  assert.equal(glueQualityEffectiveStep(0, 1, views, options), 8,
    "degradation jumps to the first rung that lowers subject pixels");
  assert.equal(glueQualityEffectiveStep(8, -1, views, options), 7,
    "recovery takes the immediately sharper subject rung");
  assert.equal(glueQualityEffectiveStep(7, -1, views, options), 0,
    "native-equivalent intermediate labels collapse to native");
});

test("a finite cold shader burst is ignored, but sustained representative load degrades effectively", () => {
  const controller = new GlueQualityController(GLUE_QUALITY_TARGET_MS);
  let now = 0;
  for (let index = 0; index < 30; index += 1) {
    now += 33;
    controller.sample(GLUE_QUALITY_TARGET_MS * 8, now, { steeringReady: false });
  }
  assert.equal(controller.step, 0, "cold outliers do not steer before the renderer settles");

  // Once settled, a continuously expensive representative window still moves to the first rung
  // the stage found effective; this is a measured workload response, not a warning suppression.
  for (let index = 0; index < 10; index += 1) {
    now += 33;
    controller.sample(GLUE_QUALITY_TARGET_MS * 8, now, { downStep: 8 });
  }
  assert.equal(controller.step, 8);
  assert.equal(controller.current.name, GLUE_QUALITY_STEPS[8].name);
});
