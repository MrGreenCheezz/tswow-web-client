import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

/**
 * 1.29 — the Electron shell's recovery decisions, as plain modules (no `electron` needed), plus
 * source pins for the wiring in main.cjs, which cannot run outside Electron.
 */

const require = createRequire(import.meta.url);
const { createRenderRecovery, parsePolicyOutput } = require("../electron/recovery.cjs");
const { parseServerConfig } = require("../electron/server-config.cjs");

test("the CPU policy output is read without ever throwing", () => {
  assert.deepEqual(parsePolicyOutput(""), { applied: [], ok: false });
  assert.deepEqual(parsePolicyOutput("WARNING: execution policy"), { applied: [], ok: false });
  assert.deepEqual(parsePolicyOutput(undefined), { applied: [], ok: false });
  assert.deepEqual(parsePolicyOutput("null"), { applied: [], ok: false });
  assert.deepEqual(parsePolicyOutput('{"applied":[1,2]}'), { applied: [1, 2], ok: true });
  assert.deepEqual(parsePolicyOutput('{"applied":[1,"x",3.5]}'), { applied: [1], ok: true });
});

test("a crashed renderer is reloaded a few times, then the window stays on the message", () => {
  let clock = 0;
  const recovery = createRenderRecovery({ now: () => clock, maxReloads: 3, windowMs: 60_000, delayMs: 1500 });
  assert.equal(recovery.onGone("clean-exit").action, "ignore", "a clean exit is not a crash");
  for (let crash = 0; crash < 3; crash++) {
    const decision = recovery.onGone("crashed");
    assert.equal(decision.action, "reload");
    assert.equal(decision.delayMs, 1500);
    clock += 1000;
  }
  const fourth = recovery.onGone("oom");
  assert.equal(fourth.action, "stay", "the fourth crash within a minute stops the loop");
  assert.match(fourth.text, /oom/);
  clock += 61_000;
  assert.equal(recovery.onGone("killed").action, "reload", "a minute later the count starts over");
});

test("server.json errors say which file and what is wrong", () => {
  assert.deepEqual(parseServerConfig('{"url":"http://203.0.113.10:8091/"}'), { url: "http://203.0.113.10:8091/" });
  assert.throws(() => parseServerConfig("{broken", "C:/app/server.json"), /C:\/app\/server\.json: не читается как JSON/);
  assert.throws(() => parseServerConfig("[]"), /ожидался объект/);
  assert.throws(() => parseServerConfig('{"url":"file:///x"}'), /url must be http/);
});

test("main.cjs wires the recovery, and the packaged app carries the new modules", async () => {
  const main = await readFile(new URL("../electron/main.cjs", import.meta.url), "utf8");
  assert.match(main, /webContents\.on\("render-process-gone"/);
  assert.match(main, /parsePolicyOutput\(stdout\)/);
  assert.doesNotMatch(main, /JSON\.parse\(stdout\)/, "the bare parse in the execFile callback is gone");
  assert.match(main, /parseServerConfig\(/);
  assert.match(main, /getURL\(\)\.startsWith\("data:"\)\) window\.loadURL\(pageUrl\)/,
    "Ctrl+R on a status page goes back to the game");
  const build = await readFile(new URL("../electron/build.mjs", import.meta.url), "utf8");
  const files = /const APP_FILES = \[([^\]]*)\]/.exec(build)?.[1] ?? "";
  for (const file of ["recovery.cjs", "server-config.cjs"]) {
    assert.ok(files.includes(`"${file}"`), `${file} must be in APP_FILES or the packaged app cannot require it`);
  }
});
