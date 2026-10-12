// 12.10 6.25 — «есть проблемы рендера парусов». A ship's sails are not WMO geometry: they are an M2
// doodad of its WMO's set 0 (TransportShip_Sails.m2 on transportship.wmo, ZepAnimation.m2 on the
// zeppelin, Icebreaker_Paddlewheel.m2 on the icebreaker). A WMO an ADT places gets its doodads from the
// tile; a game object's WMO got none, so every transport sailed bare-masted. The generator now writes
// the set beside the WMO artifact, the gateway serves it at `/visual/doodads`, and the renderer hangs
// each doodad under the object's node where the tile generator would have put it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as THREE from "three";
import { encodeWmoDoodadList } from "../tools/wmo-doodad-list.mjs";
import { worldDoodad } from "../tools/generate-visual-tile.mjs";
import { wmoDependencies } from "../tools/wmo-visual.mjs";
import { gameObjectDoodadsFor, placeWmoDoodad } from "../dist/code/browser/GameObjectDoodads.js";
import { WmoDoodadClient, parseWmoDoodadList, wmoDoodadsUrl } from "../dist/code/browser/WmoDoodadClient.js";
import { placeEnvironmentNode } from "../dist/code/browser/WorldRenderer3D.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

function chunk(tag, payload) {
  const header = Buffer.alloc(8);
  header.write([...tag].reverse().join(""), 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** A WMO root with two doodad sets: set 0 holds the sail, set 1 a crate that must not be listed. */
function twoSetRoot() {
  const sets = Buffer.alloc(64);
  sets.write("Set_$DefaultGlobal", 0, "latin1");
  sets.writeUInt32LE(0, 20);
  sets.writeUInt32LE(1, 24);
  sets.write("Set_Cargo", 32, "latin1");
  sets.writeUInt32LE(1, 52);
  sets.writeUInt32LE(1, 56);
  const names = Buffer.from("World\\Sails.mdx\0World\\Crate.mdx\0", "latin1");
  const placements = Buffer.alloc(80);
  const record = (index, nameOffset, position, rotation, scale) => {
    const at = index * 40;
    placements.writeUInt32LE(nameOffset, at);
    position.forEach((value, axis) => placements.writeFloatLE(value, at + 4 + axis * 4));
    rotation.forEach((value, axis) => placements.writeFloatLE(value, at + 16 + axis * 4));
    placements.writeFloatLE(scale, at + 32);
  };
  record(0, 0, [3, -4, 12], [0, 0, Math.SQRT1_2, Math.SQRT1_2], 1.25);
  record(1, 16, [1, 1, 1], [0, 0, 0, 1], 1);
  return Buffer.concat([chunk("MODS", sets), chunk("MODN", names), chunk("MODD", placements)]);
}

test("6.25: the doodad list is the WMO's set 0, as M2 paths in model space", () => {
  const body = JSON.parse(encodeWmoDoodadList(twoSetRoot(), []).toString());
  assert.equal(body.version, 1);
  assert.equal(body.doodads.length, 1, "set 1 (the crate) is not the set a placement draws");
  const [sail] = body.doodads;
  assert.equal(sail.name.toLowerCase(), "world\\sails.m2", "an .mdx name is the .m2 the client ships");
  assert.deepEqual(sail.position, [3, -4, 12]);
  assert.ok(Math.abs(sail.rotation[2] - Math.SQRT1_2) < 1e-6 && Math.abs(sail.rotation[3] - Math.SQRT1_2) < 1e-6);
  assert.equal(sail.scale, 1.25);
  // And the browser reads back exactly what was written.
  const parsed = parseWmoDoodadList(body);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].position, [3, -4, 12]);
  // A root that is not one lists nothing rather than failing the whole publish.
  assert.deepEqual(JSON.parse(encodeWmoDoodadList(Buffer.alloc(3), []).toString()).doodads, []);
});

/** A WMO group file: MOGP with its flags, MOCV when coloured, and the MODR references. */
function groupFile(flags, references, coloured) {
  const header = Buffer.alloc(68);
  header.writeUInt32LE(flags, 8);
  const modr = Buffer.alloc(references.length * 2);
  references.forEach((reference, index) => modr.writeUInt16LE(reference, index * 2));
  return chunk("MOGP", Buffer.concat([header, ...(coloured ? [chunk("MOCV", Buffer.alloc(4))] : []), chunk("MODR", modr)]));
}

test("6.25: a doodad an exterior group also names is sky-lit, not lit by its black MODD colour", () => {
  const INDOOR = 0x2000, OUTDOOR = 0x8;
  const root = twoSetRoot();
  // Only an indoor, vertex-coloured room names the sail: the room's MODD colour lights it.
  const indoorOnly = JSON.parse(encodeWmoDoodadList(root, [groupFile(INDOOR, [0], true)]).toString());
  assert.deepEqual(indoorOnly.doodads[0].localLight, [0, 0, 0, 0]);
  // The ship's case: the indoor rooms and the outdoor deck both name it. Exterior wins.
  const both = JSON.parse(encodeWmoDoodadList(root, [groupFile(INDOOR, [0], true), groupFile(OUTDOOR, [0], false)]).toString());
  assert.equal(both.doodads[0].localLight, undefined);
});

test("6.25: a list that does not parse is refused whole", () => {
  const good = { name: "World\\Sails.m2", position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 };
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [good] }).length, 1);
  assert.equal(parseWmoDoodadList({ version: 2, doodads: [good] }), undefined);
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [{ ...good, name: "World\\Sails.wmo" }] }), undefined);
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [{ ...good, position: [0, 0] }] }), undefined);
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [{ ...good, rotation: [0, 0, Number.NaN, 1] }] }), undefined);
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [{ ...good, scale: 0 }] }), undefined);
  assert.equal(parseWmoDoodadList({ version: 1, doodads: [{ ...good, localLight: [1, 2, 3] }] }), undefined);
  assert.deepEqual(parseWmoDoodadList({ version: 1, doodads: [{ ...good, localLight: [1, 2, 3, 255] }] })[0].localLight,
    [1, 2, 3, 255]);
});

test("6.25: a game object's doodad lands where the tile generator puts a placed WMO's", () => {
  // The same WMO placed by an ADT (tile generator `worldDoodad`, then `placeEnvironmentNode`) and
  // drawn as a game object (its node, then the doodad hung under it) must put the doodad's M2 frame
  // in one place: the doodad mesh itself carries `ADT_MODEL_TO_SCENE` in both paths.
  const placement = { id: 7, kind: "wmo", name: "World\\Ship.wmo", x: 812.5, y: -3141.25, z: 6.5,
    rotationX: 4, rotationY: 137, rotationZ: -9, scale: 1.3 };
  const rotation = new THREE.Quaternion(0.12, -0.31, 0.57, 0.75).normalize();
  const doodad = { name: "World\\Sails.m2", x: 3.5, y: -11, z: 18.25,
    quaternionX: rotation.x, quaternionY: rotation.y, quaternionZ: rotation.z, quaternionW: rotation.w, scale: 0.8 };

  const tile = placeEnvironmentNode(new THREE.Object3D(), worldDoodad(placement, doodad, 0));
  tile.updateMatrixWorld(true);

  const node = placeEnvironmentNode(new THREE.Group(), placement);
  const hung = placeWmoDoodad({
    position: [doodad.x, doodad.y, doodad.z],
    rotation: [doodad.quaternionX, doodad.quaternionY, doodad.quaternionZ, doodad.quaternionW],
    scale: doodad.scale,
  }, new THREE.Group());
  node.add(hung);
  node.updateMatrixWorld(true);

  const expected = tile.matrixWorld.elements, actual = hung.matrixWorld.elements;
  for (let index = 0; index < 16; index++) {
    assert.ok(Math.abs(expected[index] - actual[index]) < 1e-4,
      `matrix element ${index}: tile ${expected[index]}, game object ${actual[index]}`);
  }
});

test("6.25: the list is asked for once; a 404 is final, a failure retries on the ladder", async () => {
  let clock = 0;
  const asked = [];
  const answers = new Map([
    ["ship", () => new Response(JSON.stringify({ version: 1, doodads: [
      { name: "World\\Sails.m2", position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: 1 },
    ] }), { status: 200 })],
    ["missing", () => new Response("", { status: 404 })],
    ["broken", () => new Response("", { status: 500 })],
  ]);
  const client = new WmoDoodadClient("http://gateway", async (url) => {
    asked.push(String(url));
    const key = [...answers.keys()].find((name) => String(url).includes(name));
    return answers.get(key)();
  }, () => clock);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(client.doodads("World\\ship.wmo"), undefined, "on its way");
  assert.equal(client.doodads("World\\SHIP.wmo"), undefined, "and not asked twice while it is");
  await settle();
  assert.equal(client.doodads("World\\ship.wmo")?.[0]?.name, "World\\Sails.m2");
  assert.equal(asked.length, 1);
  assert.equal(asked[0], wmoDoodadsUrl("http://gateway", "World/ship.wmo"));
  assert.match(asked[0], /\/visual\/doodads\?path=World%5Cship\.wmo&v=/);

  client.doodads("World\\missing.wmo");
  await settle();
  assert.equal(client.doodads("World\\missing.wmo"), null, "the client does not ship it: final");

  client.doodads("World\\broken.wmo");
  await settle();
  assert.equal(client.doodads("World\\broken.wmo"), undefined, "a 500 waits for its retry");
  assert.equal(asked.filter((url) => url.includes("broken")).length, 1);
  clock = 2_001;
  client.doodads("World\\broken.wmo");
  await settle();
  assert.equal(asked.filter((url) => url.includes("broken")).length, 2, "and asks again after 2 s");

  const state = gameObjectDoodadsFor(client.doodads("World\\ship.wmo"));
  assert.equal(state.pending, 1);
  assert.equal(state.entries[0].node, undefined);
  assert.equal(gameObjectDoodadsFor(null).pending, 0, "no list, nothing to wait for");
});

test("6.25: the gateway serves the list beside the WMO artifact and refuses it for an M2", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-doodads-"));
  const path = "World\\wmo\\transports\\transport_ship\\transportship.wmo";
  const hash = createHash("sha1").update(`visual-wmo-v25\0${path.toLowerCase()}`).digest("hex");
  let generated = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    visualModelsDirectory: directory,
    generateVisualModel: async (modelPath, key) => {
      generated++;
      assert.equal(modelPath, path);
      assert.equal(key, hash, "the list is the same artifact's, keyed as the WMO is");
      await writeFile(join(directory, `${key}.bin`), Buffer.from("WWM2-ship"));
      await writeFile(join(directory, `${key}.doodads.json`), JSON.stringify({ version: 1, doodads: [] }));
    },
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/visual/doodads?path=${encodeURIComponent(path)}`, { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { version: 1, doodads: [] });
    assert.equal(generated, 1);
    const m2 = await fetch(`http://127.0.0.1:${gateway.port}/visual/doodads?path=${encodeURIComponent("World\\Sails.m2")}`, { headers });
    assert.equal(m2.status, 400, "an M2 has no doodads");
    assert.equal(generated, 1);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("6.25: the renderer hangs, poses, pins and releases a game object's doodads", () => {
  const source = readFileSync(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
  // Asked for right after the object's own rooms, only while its model is the WMO it was built from.
  assert.match(source, /#updateWmoGroups\(rendered\.wmo, viewer, rendered\.node, client, false,\s*transportShell \? GAMEOBJECT_TRANSPORT_SHELL_RANGE : undefined\);\s*this\.#updateGameObjectDoodads\(rendered, client, elapsed\);/);
  // Each doodad under the object's node, at its MODD transform.
  assert.match(source, /const wrapper = placeWmoDoodad\(entry\.placement, new THREE\.Group\(\)\);/);
  assert.match(source, /rendered\.node\.add\(wrapper\);/);
  // Its build is pinned against the cache's eviction like the object's own.
  assert.match(source, /if \(rendered\.doodads\) for \(const doodad of rendered\.doodads\.entries\) if \(doodad\.built\) modelPins\.add\(doodad\.built\);/);
  // And it goes with the object.
  assert.match(source, /this\.#disposeGameObjectDoodads\(rendered\);[^\n]*\n\s*this\.#gameObjectGroup\.remove\(rendered\.node\);/);
});

test("6.25: every transport WMO in the client carries its moving parts in set 0", withClient, async () => {
  const expected = [
    ["World\\wmo\\transports\\transport_ship\\transportship.wmo", /transportship_sails\.m2$/i],
    ["World\\wmo\\transports\\transport_ship_ne\\transportship_ne.wmo", /transportship_ne_doodadsmoving\.m2$/i],
    ["World\\wmo\\transports\\transport_zeppelin\\transport_zeppelin.wmo", /zepanimation\.m2$/i],
    ["World\\wmo\\transports\\icebreaker\\transport_icebreaker_ship.wmo", /icebreaker_paddlewheel\.m2$/i],
  ];
  for (const [path, part] of expected) {
    const root = await archives.read(path);
    const groups = [];
    for (const group of wmoDependencies(root, path).groups) groups.push(await archives.read(group));
    const list = parseWmoDoodadList(JSON.parse(encodeWmoDoodadList(root, groups).toString()));
    assert.ok(list, path);
    const moving = list.find((doodad) => part.test(doodad.name));
    assert.ok(moving, `${path} lists ${part}`);
    // The sails and the propellers carry a black MODD colour and are named by the outdoor deck too.
    assert.equal(moving.localLight, undefined, `${path}: ${moving.name} is sky-lit`);
    if (/transportship\.wmo$/i.test(path)) {
      assert.ok(list.filter((doodad) => doodad.localLight).length >= 100,
        "the cabin's furniture keeps its room light");
    }
  }
});
