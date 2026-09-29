import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LatestConnection } from "../dist/code/browser/app/LatestConnection.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function connection(name) {
  return { name, closed: 0, close() { this.closed++; } };
}

test("an older socket and an older authenticated world cannot replace the latest realm", async () => {
  const attempts = new LatestConnection();
  const firstSocket = deferred();
  const first = attempts.begin();
  const oldSocketResult = attempts.accept(first, firstSocket.promise);

  const second = attempts.begin();
  const socket = connection("new socket");
  assert.equal(await attempts.accept(second, Promise.resolve(socket)), socket);
  const obsoleteSocket = connection("old socket");
  firstSocket.resolve(obsoleteSocket);
  const staleSocket = await oldSocketResult;
  assert.equal(staleSocket, undefined);
  assert.equal(obsoleteSocket.closed, 1);

  const firstWorld = deferred();
  const oldWorldResult = attempts.accept(second, firstWorld.promise);
  const third = attempts.begin();
  const world = connection("new world");
  assert.equal(await attempts.accept(third, Promise.resolve(world)), world);
  const obsoleteWorld = connection("old world");
  firstWorld.resolve(obsoleteWorld);
  assert.equal(await oldWorldResult, undefined);
  assert.equal(obsoleteWorld.closed, 1, "a late authenticated world must release its socket");
  assert.equal(world.closed, 0, "the accepted realm still owns its connection");
});

test("signing in again invalidates a world authentication still in flight", async () => {
  const attempts = new LatestConnection();
  const pending = deferred();
  const attempt = attempts.begin();
  const result = attempts.accept(attempt, pending.promise);
  attempts.invalidate();
  const oldWorld = connection("previous account");
  pending.resolve(oldWorld);
  assert.equal(await result, undefined);
  assert.equal(oldWorld.closed, 1);
  assert.equal(attempts.isCurrent(attempt), false);
});

test("legacy login applies the guard at both awaits and before redrawing characters", async () => {
  const source = await readFile(new URL("../src/browser/app/Login.ts", import.meta.url), "utf8");
  assert.match(source, /realmConnections\.accept\(attempt, WebSocketByteStream\.connect\(/);
  assert.match(source, /realmConnections\.accept\(attempt, WorldClient\.connect\(/);
  assert.match(source, /realmConnections\.invalidate\(\);\s*game\.world\?\.close\(\);/);
  assert.match(source, /const world = game\.world;[\s\S]*?const list = await world\.characters\(\);\s*if \(game\.world === world\) showCharacters\(list\);/);
});
