import assert from "node:assert/strict";
import test from "node:test";
import {
  MOUSE_CLICK_INTERACT, MOUSE_CLICK_NONE, MOUSE_CLICK_SELECT, MouseCommandClick, mouseCommandDragged,
} from "../dist/code/browser/input/MouseCommandClick.js";

/*
 * 5.09 (13.10): the click a released mouse command makes, as Wow.exe 3.3.5a 12340 keeps it — the mode at input+0x18
 * (TurnOrActionStart 0x005fc610: 2, CameraOrSelectOrMoveStart 0x005fc6c0: 1, Mouselook 0x005fcc10/0x005fc890: 0), the
 * gesture restarted by 0x005fa170, the moves summed by 0x005fba60, and 0x005fa450 → 0x005f9600 → 0x004f7880.
 */

const RIGHT = 1;
const LEFT = 2;

test("0x005f9600: a drag is held 800 ms, or moved 8 on an axis and held 200 ms", () => {
  const cases = [
    [0, 0, 0, false], [799, 7.9, 7.9, false], [800, 0, 0, true], [199, 50, 50, false],
    [200, 8, 0, true], [300, 0, 8, true], [300, 7.99, 7.99, false], [5000, 0, 0, true],
  ];
  for (const [ms, dx, dy, dragged] of cases) assert.equal(mouseCommandDragged(ms, dx, dy), dragged, `${ms} ms, ${dx}, ${dy}`);
});

test("TurnOrAction interacts, CameraOrSelectOrMove selects, on a quick still release", () => {
  const click = new MouseCommandClick();
  click.down(RIGHT, 0, RIGHT, 1000, false);
  assert.equal(click.mode, MOUSE_CLICK_INTERACT);
  assert.equal(click.up(RIGHT, 0, 1100, false), MOUSE_CLICK_INTERACT);
  assert.equal(click.mode, MOUSE_CLICK_NONE, "the mode goes back to none");
  click.down(LEFT, 0, LEFT, 2000, false);
  assert.equal(click.up(LEFT, 0, 2100, false), MOUSE_CLICK_SELECT);
});

test("held long, or moved and held, is a drag; a quick flick is still a click", () => {
  const click = new MouseCommandClick();
  click.down(RIGHT, 0, RIGHT, 0, false);
  assert.equal(click.up(RIGHT, 0, 900, false), MOUSE_CLICK_NONE, "held 900 ms");
  click.down(RIGHT, 0, RIGHT, 1000, false);
  click.moved(-6, 1);
  click.moved(-5, 1);
  assert.equal(click.up(RIGHT, 0, 1300, false), MOUSE_CLICK_NONE, "11 px left and held 300 ms");
  click.down(RIGHT, 0, RIGHT, 2000, false);
  click.moved(30, 0);
  assert.equal(click.up(RIGHT, 0, 2150, false), MOUSE_CLICK_INTERACT, "30 px in 150 ms");
  click.down(RIGHT, 0, RIGHT, 3000, false);
  assert.equal(click.up(RIGHT, 0, 3300, false), MOUSE_CLICK_INTERACT, "a new gesture starts its sums over (still, 300 ms)");
});

test("Mouselook clicks nothing; two commands together click nothing; only the last release clicks", () => {
  const click = new MouseCommandClick();
  click.down(RIGHT, 0, RIGHT, 0, true);
  assert.equal(click.up(RIGHT, 0, 50, true), MOUSE_CLICK_NONE, "MouselookStart/Stop");
  // MoveAndSteerStart: CameraOrSelectOrMove then TurnOrAction.
  click.down(LEFT, 0, LEFT, 100, false);
  click.down(RIGHT, LEFT, LEFT | RIGHT, 100, false);
  assert.equal(click.up(LEFT | RIGHT, RIGHT, 150, false), MOUSE_CLICK_NONE, "one still down: no click yet");
  assert.equal(click.up(RIGHT, 0, 160, false), MOUSE_CLICK_NONE, "two commands are no click");
  click.down(RIGHT, 0, RIGHT, 200, false);
  click.down(RIGHT, RIGHT, RIGHT, 210, true);
  assert.equal(click.up(RIGHT, 0, 220, false), MOUSE_CLICK_NONE, "a MouselookStart on top cleared the mode");
  click.down(LEFT, 0, LEFT, 300, false);
  click.reset();
  assert.equal(click.up(LEFT, 0, 310, false), MOUSE_CLICK_NONE, "focus lost: nothing");
});
