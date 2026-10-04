import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { describeFailure, WORLD_CONNECTION_LOST } from "../dist/code/browser/glue/GlueMessages.js";
import { enterWorldRefusal } from "../dist/code/browser/glue/GlueEnterGate.js";
import { TransportClosedError } from "../dist/code/transport/WebSocketByteStream.js";

/**
 * 10.06 review, items 3 and 4: the way back from the world speaks in coded messages, never an
 * exception's text; a lost connection in the world is DISCONNECTED; and both front doors refuse a
 * character the core would kick with the client's own gate (FUN_004d9bd0), in its order.
 */

const enterWorldSource = new URL("../src/browser/app/EnterWorld.ts", import.meta.url);
const loginSource = new URL("../src/browser/app/Login.ts", import.meta.url);
const frontDoorHostSource = new URL("../src/browser/glue/FrontDoorHost.ts", import.meta.url);

test("a read that failed in the world is DISCONNECTED, whatever broke it", () => {
  assert.equal(WORLD_CONNECTION_LOST.key, "DISCONNECTED");
  assert.equal(WORLD_CONNECTION_LOST.dialog, "OKAY");
  // What describeFailure says for a connection phase is not what the world loop says: a stream
  // error there is a login that failed, here it is a dropped connection.
  assert.equal(describeFailure(new Error("stream error"), "world").key, "CHAR_LOGIN_FAILED");
});

test("a failed enter is coded: a dropped socket is DISCONNECTED, anything else CHAR_LOGIN_FAILED", () => {
  assert.equal(describeFailure(new TransportClosedError(1006, "", false), "world").key, "DISCONNECTED");
  assert.equal(describeFailure(new Error("Worldserver did not send opcode 0x236"), "world").key, "CHAR_LOGIN_FAILED");
  assert.ok(!describeFailure(new Error("Worldserver did not send opcode 0x236"), "world").text?.includes("opcode"));
});

test("the enter gate: 0x4 → 84, 0x01000000 → 85, both before 0x4000", () => {
  assert.equal(enterWorldRefusal(0), undefined);
  assert.equal(enterWorldRefusal(0x2000 | 0x400), undefined, "ghost and hidden helm are no reason");
  assert.equal(enterWorldRefusal(0x4 | 0x4000 | 0x01000000)?.code, 84);
  assert.equal(enterWorldRefusal(0x4 | 0x4000 | 0x01000000)?.key, "CHAR_LOGIN_LOCKED_FOR_TRANSFER");
  assert.equal(enterWorldRefusal(0x01000000 | 0x4000)?.code, 85);
  assert.equal(enterWorldRefusal(0x01000000 | 0x4000)?.key, "CHAR_LOGIN_LOCKED_BY_BILLING");
  assert.equal(enterWorldRefusal(0x4000)?.kind, "rename");
  assert.equal(enterWorldRefusal(0x4000)?.key, "CHAR_RENAME_DESCRIPTION");
});

test("the DOM entry is guarded before anything is sent, and says why on the card panel", async () => {
  const source = await readFile(enterWorldSource, "utf8");
  assert.match(source,
    /export async function enterWorld\([^)]*\): Promise<void> \{\s*if \(!game\.world\) return;[\s\S]{0,700}?const refusal = enterWorldRefusal\(character\.flags\);\s*if \(refusal\) \{[\s\S]{0,200}?return;\s*\}\s*const world = game\.world;/,
    "the gate runs before the world is touched");
  // Login.ts's card button reaches the world only through this function.
  const login = await readFile(loginSource, "utf8");
  assert.match(login, /enter\.addEventListener\("click", \(\) => void enterWorld\(character, enter\)\);/);
});

test("the world's two ways out carry coded messages, never error.message", async () => {
  const source = await readFile(enterWorldSource, "utf8");
  assert.match(source, /world\.onWorldError = \(error\) => \{[\s\S]{0,700}?const lost = WORLD_CONNECTION_LOST;[\s\S]{0,700}?leaveWorld\("connection-lost", lost\);/);
  assert.match(source, /const message = describeFailure\(error, "world"\);[\s\S]{0,900}?leaveWorld\("enter-failed", message\);/);
  assert.doesNotMatch(source, /characterStatus\.textContent = message;/, "no raw exception text on the panel");
  assert.doesNotMatch(source, /const message = error instanceof Error \? error\.message/);
  const host = await readFile(frontDoorHostSource, "utf8");
  assert.match(host, /if \(message\) handle\?\.runtime\.api\.showMessage\(message\);/);
  assert.doesNotMatch(host, /fireEvent\("OPEN_STATUS_DIALOG", "OKAY", message\)/);
});
