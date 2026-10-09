import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { AssetWorker } from "../dist/code/gateway/AssetWorker.js";
import { SOURCE_MISSING_EXIT } from "../dist/code/gateway/Gateway.js";
import { repositoryRoot } from "../tools/paths.mjs";
import { stampSidecar } from "../tools/source-stamp.mjs";
import { textureId } from "../tools/generate-texture.mjs";

/** A 2x2 palette BLP2, the smallest thing `tools/blp.mjs` decodes (same as the restamp fixture). */
function blp() {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 1;
  header[11] = 1;
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(148 + 1024, 20);
  header.writeUInt32LE(4, 84);
  for (const [index, entry] of [[10, 20, 30, 255], [200, 100, 50, 255]].entries()) {
    for (let channel = 0; channel < 4; channel++) header[148 + index * 4 + channel] = entry[channel];
  }
  return Buffer.concat([header, Buffer.from([0, 1, 1, 0])]);
}

/**
 * A client whose whole chain is one loose patch directory with one texture in it, and an empty
 * cache: the worker is the real `tools/asset-worker.mjs`, forked the way the gateway forks it.
 */
async function machine() {
  const client = await mkdtemp(join(tmpdir(), "webclient-worker-client-"));
  const textures = await mkdtemp(join(tmpdir(), "webclient-worker-textures-"));
  const source = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Tileset", "Test", "Grass.blp");
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(source, blp());
  const spawned = [];
  const options = (extra = {}) => ({
    script: resolve(repositoryRoot, "tools/asset-worker.mjs"),
    cwd: repositoryRoot,
    env: { ...process.env, CLIENT_DIR: client, TEXTURE_DIR: textures, CLIENT_PACK_DIR: "" },
    label: "texture",
    track: (child) => { spawned.push(child); return child; },
    ...extra,
  });
  return {
    textures, spawned, options,
    async remove() {
      for (const child of spawned) if (child.exitCode === null && child.signalCode === null) child.kill();
      await rm(client, { recursive: true, force: true });
      await rm(textures, { recursive: true, force: true });
    },
  };
}

const exited = (child) => new Promise((done) => {
  if (child.exitCode !== null || child.signalCode !== null) done();
  else child.once("exit", () => done());
});

test("one worker publishes texture after texture out of one chain, and says «missing» the way a child's exit code did", async () => {
  // The point of the worker (tools/asset-worker.mjs): a cold texture was 387 ms as a process of its
  // own and 18 ms out of a chain already open, and the owner's session of 2026-09-28 published one
  // every 412 ms for 226 s on arriving in Dalaran. The route above it must not be able to tell the
  // difference: published bytes and stamp as before, and «not in the client» still a 404.
  const box = await machine();
  const worker = new AssetWorker(box.options());
  try {
    await worker.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    const published = join(box.textures, `${textureId("Tileset\\Test\\Grass.blp")}.png`);
    await access(published);
    const stamp = JSON.parse(await readFile(stampSidecar(published), "utf8"));
    assert.equal(stamp.sources[0].path, "Tileset\\Test\\Grass.blp", "stamped with what it was built from");

    const failure = await worker.run({ kind: "texture", path: "Tileset\\Test\\Absent.blp" }).catch((error) => error);
    assert.ok(failure instanceof Error);
    assert.equal(failure.exitCode, SOURCE_MISSING_EXIT, "a missing source is the route's 404, as a child's exit 3 was");

    await worker.run({ kind: "texture", path: "tileset/test/GRASS.blp" });
    assert.equal(box.spawned.length, 1, "three jobs, one process");
  } finally {
    worker.close();
    await box.remove();
  }
});

test("the gateway retires a worker when it goes idle and when told the archives changed", async () => {
  const box = await machine();
  const idle = new AssetWorker(box.options({ idleMs: 150 }));
  // Idle retirement far away, so only `recycle` can end this one inside the test.
  const busy = new AssetWorker(box.options({ idleMs: 600_000 }));
  try {
    await idle.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    await exited(box.spawned[0]);
    assert.equal(box.spawned.length, 1, "idle: the chain is closed and the process gone, nothing new started");
    await idle.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    assert.equal(box.spawned.length, 2, "the next job starts a fresh worker");

    await busy.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    const held = box.spawned[2];
    busy.recycle();
    const gone = await Promise.race([
      exited(held).then(() => true),
      new Promise((done) => setTimeout(() => done(false), 5_000)),
    ]);
    assert.equal(gone, true, "a changed client closes the chain the worker holds");
    await busy.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    assert.equal(box.spawned.length, 4, "and the next job reads through a new one");
  } finally {
    idle.close();
    busy.close();
    await box.remove();
  }
});

test("a worker that dies under a job fails it as retryable, and the next job gets a new worker", async () => {
  // Without the «missing» code, so the route answers 500 and the browser's retry ladder asks again,
  // instead of a 404 it would take as final. A worker that never answers stands in for one that is
  // busy, so the death lands under the job every time.
  const box = await machine();
  const hang = join(box.textures, "hang.mjs");
  await writeFile(hang, "process.on('message', () => {});\n");
  const worker = new AssetWorker(box.options({ script: hang }));
  try {
    const pending = worker.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    await new Promise((done) => setTimeout(done, 300));
    box.spawned[0].kill();
    const failure = await pending.catch((error) => error);
    assert.ok(failure instanceof Error, "the job fails rather than hanging for the life of the lane");
    assert.notEqual(failure.exitCode, SOURCE_MISSING_EXIT);
    const next = worker.run({ kind: "texture", path: "Tileset\\Test\\Grass.blp" });
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(box.spawned.length, 2, "the next job is sent to a new worker");
    box.spawned[1].kill();
    await next.catch(() => undefined);
  } finally {
    worker.close();
    await box.remove();
  }
});

/** A stand-in worker: answers each job after a pause, and fails any job that arrives while it is busy. */
async function scriptedWorker(box) {
  const script = join(box.textures, "scripted.mjs");
  await writeFile(script, [
    "let busy = false;",
    "process.on('message', (job) => {",
    "  if (busy) { process.send({ id: job.id, ok: false, message: 'overlap', rss: 0 }); return; }",
    "  busy = true;",
    "  setTimeout(() => { busy = false; process.send({ id: job.id, ok: true, rss: 0 }); }, 40);",
    "});",
    "process.on('disconnect', () => process.exit(0));",
  ].join("\n"));
  return script;
}

test("10.20: the child gets one job at a time, the most urgent waiting one next, equal ones in arrival order", async () => {
  const box = await machine();
  const worker = new AssetWorker(box.options({ script: await scriptedWorker(box) }));
  try {
    const finished = [];
    const job = (name, priority) => worker.run({ kind: "texture", path: name }, priority).then(() => finished.push(name));
    const all = [
      job("first", 0),
      job("low", 0),
      job("high", 2),
      job("middle", 1),
      job("high-later", 2),
    ];
    assert.equal(worker.waiting, 4, "one job is with the child, four wait on this side");
    await Promise.all(all);
    assert.deepEqual(finished, ["first", "high", "high-later", "middle", "low"]);
    assert.equal(box.spawned.length, 1, "one process for all of them");
  } finally {
    worker.close();
    await box.remove();
  }
});

test("10.20: recycle with jobs waiting sends them to a new child; close rejects them as retryable", async () => {
  const box = await machine();
  const worker = new AssetWorker(box.options({ script: await scriptedWorker(box) }));
  try {
    const first = worker.run({ kind: "texture", path: "a" }, 0);
    const second = worker.run({ kind: "texture", path: "b" }, 0);
    worker.recycle();
    await first;
    await second;
    assert.equal(box.spawned.length, 2, "the waiting job went to a fresh child after the old one finished");

    const running = worker.run({ kind: "texture", path: "c" }, 0);
    const waiting = worker.run({ kind: "texture", path: "d" }, 0);
    worker.close();
    for (const outcome of await Promise.allSettled([running, waiting])) {
      assert.equal(outcome.status, "rejected");
      assert.notEqual(outcome.reason.exitCode, SOURCE_MISSING_EXIT, "closing is not «no such file»");
    }
  } finally {
    worker.close();
    await box.remove();
  }
});

test("10.20 review: a job the child never answers times out, the child is killed, and the waiting job gets a fresh one", async () => {
  // Every family shares one child, so one hung job would otherwise stall every icon, texture and
  // glue-screen file behind it for the life of the gateway.
  const box = await machine();
  const hang = join(box.textures, "hang.mjs");
  await writeFile(hang, "process.on('message', () => {});\n");
  const worker = new AssetWorker(box.options({ script: hang, jobTimeoutMs: 300 }));
  try {
    const started = Date.now();
    const stuck = worker.run({ kind: "texture", path: "a" }, 0);
    const waiting = worker.run({ kind: "texture", path: "b" }, 0);
    const failure = await stuck.catch((error) => error);
    assert.ok(failure instanceof Error, "the hung job fails");
    assert.match(failure.message, /timed out/);
    assert.notEqual(failure.exitCode, SOURCE_MISSING_EXIT, "a 500 the browser retries, not a final 404");
    assert.ok(Date.now() - started < 5_000);
    await Promise.race([exited(box.spawned[0]), new Promise((done) => setTimeout(done, 5_000))]);
    assert.ok(box.spawned[0].exitCode !== null || box.spawned[0].signalCode !== null, "the hung child is killed");
    await new Promise((done) => setTimeout(done, 100));
    assert.equal(box.spawned.length, 2, "the waiting job went to a new child");
    assert.equal((await waiting.catch((error) => error)).message.includes("timed out"), true, "and times out there too");
  } finally {
    worker.close();
    await box.remove();
  }
});
