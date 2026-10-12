// 5.14 (owner, 12.10): a character's camera starts where Wow.exe starts it — cameraSavedDistance and
// cameraSavedPitch (0x5ff3e0), view 2's 5.55 yards and 10° until the character has saved its own — and
// is written back (0x5ff320) when the world changes and every few seconds while it lasts.

import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMERA_SAVE_INTERVAL_MS, CAMERA_SAVED_DISTANCE_DEFAULT, CAMERA_SAVED_DISTANCE_MAX, CAMERA_SAVED_PITCH_DEFAULT,
  CameraSaved, cameraSavedStorageKey, parseCameraSaved,
} from "../dist/code/browser/game/CameraSaved.js";

const DEG = Math.PI / 180;

function memory() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

function rig() {
  return { distance: 21.31, pitch: -0.4, zoom: 21.31, view: 21.31, viewPitch: -0.4 };
}

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);

test("5.14 the defaults are view 2's row of Wow.exe's table", () => {
  assert.equal(CAMERA_SAVED_DISTANCE_DEFAULT, 5.55);
  assert.equal(CAMERA_SAVED_PITCH_DEFAULT, 10);
  assert.equal(CAMERA_SAVED_DISTANCE_MAX, 50);
});

test("5.14 a character without a saved camera starts at 5.55 yards and 10° down, without a glide", () => {
  const saved = new CameraSaved(memory());
  const camera = rig();
  const world = {};
  saved.frame(camera, 0, world, "Owner", "Realm", 7n, false);
  close(camera.distance, 5.55, "distance");
  close(camera.zoom, 5.55, "the eased distance too");
  close(camera.view, 5.55, "and the wall-limited one");
  close(camera.pitch, -10 * DEG, "pitch, looking down");
  close(camera.viewPitch, -10 * DEG, "the floor-limited pitch too");
  assert.equal(saved.key, cameraSavedStorageKey("owner", "Realm", 7n), "the account folds its Latin letters");
});

test("5.14 the camera waits for the character's guid", () => {
  const saved = new CameraSaved(memory());
  const camera = rig();
  const world = {};
  saved.frame(camera, 0, world, "owner", "Realm", undefined, false);
  assert.equal(camera.distance, 21.31, "nothing to load yet");
  saved.frame(camera, 16, world, "owner", "Realm", 0n, false);
  assert.equal(camera.distance, 21.31, "a zero guid is no character either");
  saved.frame(camera, 32, world, "owner", "Realm", 9n, false);
  close(camera.distance, 5.55, "loaded once known");
});

test("5.14 the camera is kept per character: written every few seconds and when the world changes", () => {
  const storage = memory();
  const saved = new CameraSaved(storage);
  const camera = rig();
  const first = {};
  saved.frame(camera, 0, first, "owner", "Realm", 7n, false);
  camera.distance = 12.5;
  camera.pitch = -25 * DEG;
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS - 1, first, "owner", "Realm", 7n, false);
  assert.equal(storage.values.size, 0, "not before the interval");
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS, first, "owner", "Realm", 7n, false);
  assert.deepEqual(parseCameraSaved(storage.getItem(cameraSavedStorageKey("owner", "Realm", 7n))), { distance: 12.5, pitch: 25 });

  camera.distance = 14;
  const second = {};
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS + 16, second, "owner", "Realm", 8n, false);
  assert.deepEqual(parseCameraSaved(storage.getItem(cameraSavedStorageKey("owner", "Realm", 7n))), { distance: 14, pitch: 25 },
    "the character being left keeps where its camera was");
  close(camera.distance, 5.55, "the next character starts at its own (the default)");

  const third = {};
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS + 32, third, "owner", "Realm", 7n, false);
  close(camera.distance, 14, "back on the first character: its distance");
  close(camera.pitch, -25 * DEG, "and its pitch");
});

test("5.14 nothing is kept while the vehicle distance is in force", () => {
  const storage = memory();
  const saved = new CameraSaved(storage);
  const camera = rig();
  const world = {};
  saved.frame(camera, 0, world, "owner", "Realm", 7n, false);
  camera.distance = 40;
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS, world, "owner", "Realm", 7n, true);
  saved.frame(camera, CAMERA_SAVE_INTERVAL_MS + 16, {}, "owner", "Realm", 7n, true);
  assert.equal(storage.values.size, 0, "the vehicle's 40 yards are not the character's");
});

test("5.14 a saved distance is held to 0…50 on the way in, a broken record is the default", () => {
  const storage = memory();
  const key = cameraSavedStorageKey("owner", "Realm", 7n);
  const camera = rig();
  storage.setItem(key, "80,5");
  new CameraSaved(storage).frame(camera, 0, {}, "owner", "Realm", 7n, false);
  assert.equal(camera.distance, 50);
  storage.setItem(key, "-3,5");
  new CameraSaved(storage).frame(camera, 0, {}, "owner", "Realm", 7n, false);
  assert.equal(camera.distance, 0, "below zero: first person, as 0x5ff3e0's clamp");
  storage.setItem(key, "far,away");
  new CameraSaved(storage).frame(camera, 0, {}, "owner", "Realm", 7n, false);
  close(camera.distance, 5.55, "unreadable: the default");
  assert.equal(parseCameraSaved("5"), undefined);
  assert.equal(parseCameraSaved(""), undefined);
});

test("5.14 no storage at all still starts at the default and never throws", () => {
  const camera = rig();
  const saved = new CameraSaved(null);
  saved.frame(camera, 0, {}, "owner", "Realm", 7n, false);
  close(camera.distance, 5.55, "default");
  camera.distance = 9;
  assert.doesNotThrow(() => saved.frame(camera, CAMERA_SAVE_INTERVAL_MS, {}, "owner", "Realm", 7n, false));
});
