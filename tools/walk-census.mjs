// 2.11: spreads out from every instance portal over the floors of the client's own data, and on each step between two cells walks a
// body with the client's own physics towards the portal (the way a player comes). A place where the body stops, the floor goes on
// nearly level and nothing in the collision world is in front of it is the kind of invisible wall the owner found at the Deadmines'
// way in on 04.11. The spreading itself asks only for a floor and for room at the waist, so that a corner a straight walk cannot take
// does not end the search. A verdict "open" says the map's open ground was reached that way, not that every step was walked.
//
// Needs a running gateway and a built dist/code. No server, no browser, no account; the world database is only read.
//   node tools/walk-census.mjs [--ids 78,2848] [--limit 10] [--gateway http://127.0.0.1:8090] [--physics <Physics.js>]
//     [--out .runtime/walk-census]
//
// The body is the one movement code steps (Physics.ts stepCharacter, Movement.ts createTerrainProbe, CollisionSource, TerrainClient);
// game objects are not in it, so a closed door is reported beside the path instead of stopping it.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dbcDirectory, mysqlBinary, worldserverConf } from "./paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const GATEWAY = option("gateway", "http://127.0.0.1:8090");
const OUT = resolve(root, option("out", ".runtime/walk-census"));
const ORIGIN = option("origin", "http://127.0.0.1:5173");

// The gateway answers only an allowed page; these clients were written for one.
const pageFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => pageFetch(input, { ...init, headers: { ...init.headers, Origin: ORIGIN } });

const code = (path) => pathToFileURL(join(root, "dist/code", path)).href;
const { TerrainClient } = await import(code("browser/Terrain.js"));
const { CollisionSource } = await import(code("browser/game/CollisionSource.js"));
const { createTerrainProbe } = await import(code("browser/input/Movement.js"));
const physicsPath = option("physics", undefined);
const { newCharacterMotion, stepCharacter, DEFAULT_COLLISION_HEIGHT, STEP_HEIGHT } = await import(
  physicsPath ? pathToFileURL(resolve(physicsPath)).href : code("browser/game/Physics.js"));

/** Yards between cells: a tunnel is wider than this, a corner of one is walked by the next cell. */
const CELL = 1.5;
const RUN_SPEED = 7;
const STEP_SECONDS = 1 / 30;
/** How far over and under this cell a neighbour's floor may lie: a roof over the tunnel is not a neighbour. */
const CLIMB = 2;
const DROP = 4;
/** How far along the way a portal counts as walled in when nothing further is reached. */
const WALLED_YARDS = 40;
const MAX_CELLS = 25000;
const MAX_YARDS = 420;
const MAX_SECONDS = Number(option("seconds", "300"));
/** A closed door this near a walked cell is on the way. */
const DOOR_YARDS = 8;
const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const INPUT = {
  forward: 1, strafe: 0, ascend: false, descend: false, pitch: 0, runSpeed: RUN_SPEED, swimSpeed: 4.72, flightSpeed: 7,
  collisionHeight: DEFAULT_COLLISION_HEIGHT, radius: 0.389, rooted: false, waterWalking: false, featherFall: false,
  hovering: false, hoverHeight: 0, canFly: false, gravityDisabled: false,
};

/** One SELECT on the realm's world database; the password goes by the environment and is never printed. */
function worldQuery(sql) {
  const conf = readFileSync(worldserverConf(), "utf8");
  const line = /^WorldDatabaseInfo\s*=\s*"([^"]*)"/m.exec(conf)?.[1];
  if (!line) throw new Error("no WorldDatabaseInfo in worldserver.conf");
  const [host, port, user, password, database] = line.split(";");
  const out = execFileSync(mysqlBinary(), ["-h", host, "-P", port, "-u", user, "-D", database, "-N", "-B", "-e", sql],
    { env: { ...process.env, MYSQL_PWD: password }, encoding: "utf8", maxBuffer: 1 << 26 });
  return out.split(/\r?\n/).filter(Boolean).map((row) => row.split("\t"));
}

function areaTriggers() {
  const data = readFileSync(join(dbcDirectory(), "AreaTrigger.dbc"));
  const count = data.readUInt32LE(4);
  const size = data.readUInt32LE(12);
  const rows = new Map();
  for (let index = 0; index < count; index++) {
    const at = 20 + index * size;
    rows.set(data.readUInt32LE(at), {
      id: data.readUInt32LE(at), map: data.readUInt32LE(at + 4), x: data.readFloatLE(at + 8), y: data.readFloatLE(at + 12), z: data.readFloatLE(at + 16),
      radius: data.readFloatLE(at + 20), length: data.readFloatLE(at + 24), width: data.readFloatLE(at + 28), height: data.readFloatLE(at + 32),
    });
  }
  return rows;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const terrain = new TerrainClient(GATEWAY);
const collision = new CollisionSource(GATEWAY);

/** Everything around a point has answered, and the probe sees it. */
async function settle(map, x, y) {
  const deadline = Date.now() + 90_000;
  for (;;) {
    collision.refresh(map, x, y);
    if (terrain.isReady(map, x, y) && collision.isReady(map, x, y)) return true;
    if (Date.now() > deadline) return false;
    await sleep(15);
  }
}

/** The floor a cell stands on: the highest of the ground and the collision floors in reach of `nearZ`. */
function floorNear(probe, x, y, nearZ) {
  const solid = probe.floor?.(x, y, nearZ + CLIMB, nearZ - DROP);
  const ground = probe.hole(x, y) ? undefined : probe.ground(x, y);
  const usable = ground !== undefined && ground <= nearZ + CLIMB && ground >= nearZ - DROP ? ground : undefined;
  if (solid === undefined) return usable;
  return usable === undefined ? solid : Math.max(solid, usable);
}

/** Whether a body set down at `from` and walking at `to` gets there on its feet. */
function walks(probe, from, to) {
  const position = { x: from.x, y: from.y, z: from.z, orientation: Math.atan2(to.y - from.y, to.x - from.x) };
  const motion = newCharacterMotion();
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.ceil(((distance / RUN_SPEED) * 2.5) / STEP_SECONDS);
  let travelled = 0;
  for (let step = 0; step < steps; step++) {
    const beforeX = position.x;
    const beforeY = position.y;
    position.orientation = Math.atan2(to.y - position.y, to.x - position.x);
    stepCharacter(position, motion, INPUT, probe, STEP_SECONDS);
    travelled += Math.hypot(position.x - beforeX, position.y - beforeY);
    if (Math.hypot(to.x - position.x, to.y - position.y) < 0.9 && Math.abs(to.z - position.z) < 2.5) return { ok: true, position };
    if (motion.mode === "swim") return { ok: true, position, swam: true };
  }
  return { ok: false, position, travelled };
}

/**
 * What stopped a body: "geometry" at the knees, the waist or the head; "slope" when the floor ahead climbs faster than a body may;
 * "invisible" when the floor goes on nearly level and nothing is in the way. Only the last is a wall of air, and it is the owner's
 * case of 04.11: floor flat ahead, no ray hits, the map's ground overhead.
 */
function classify(world, probe, stoppedAt, to) {
  const angle = Math.atan2(to.y - stoppedAt.y, to.x - stoppedAt.x);
  for (const height of [0.4, 1, 1.8]) {
    const from = { x: stoppedAt.x, y: stoppedAt.y, z: stoppedAt.z + height };
    const end = { x: from.x + Math.cos(angle) * 1.2, y: from.y + Math.sin(angle) * 1.2, z: from.z };
    if (world?.firstHit(from, end)) return "geometry";
  }
  // The body is wider than a ray: a corner beside the line pushes it back as a wall does.
  const stepX = stoppedAt.x + Math.cos(angle) * 0.3;
  const stepY = stoppedAt.y + Math.sin(angle) * 0.3;
  const pushed = probe.pushOut?.(stepX, stepY, stoppedAt.z, INPUT.radius, INPUT.collisionHeight);
  if (pushed && Math.hypot(pushed.x - stepX, pushed.y - stepY) > 0.05) return "geometry";
  const x = stoppedAt.x + Math.cos(angle) * 0.6;
  const y = stoppedAt.y + Math.sin(angle) * 0.6;
  const ahead = floorNear(probe, x, y, stoppedAt.z);
  // The map's own ground rising in front is rock the player sees, though no ray of the collision world meets it.
  const feetGround = probe.hole(stoppedAt.x, stoppedAt.y) ? undefined : probe.ground(stoppedAt.x, stoppedAt.y);
  if (feetGround === undefined || feetGround - stoppedAt.z <= STEP_HEIGHT) {
    for (const reach of [0.3, 0.6, 1, 1.5]) {
      const groundX = stoppedAt.x + Math.cos(angle) * reach;
      const groundY = stoppedAt.y + Math.sin(angle) * reach;
      const rock = probe.hole(groundX, groundY) ? undefined : probe.ground(groundX, groundY);
      if (rock !== undefined && rock - stoppedAt.z > STEP_HEIGHT) return "rock";
    }
  }
  if (ahead === undefined) return "edge";
  return ahead - stoppedAt.z <= 0.4 ? "invisible" : "slope";
}

async function census(trigger, doors) {
  const map = trigger.map;
  if (!(await settle(map, trigger.x, trigger.y))) return { verdict: "no-data" };
  let probe = createTerrainProbe(terrain, collision, map);
  // Every floor inside the volume: a player enters it from any side, and its middle may hang in the air or inside a wall.
  const search = Math.max(trigger.radius, trigger.length / 2, trigger.width / 2, 3);
  // A box may be far taller than wide (Ulduar's way in is 160 high), and its floor is at the bottom of that.
  const tall = Math.max(search, (trigger.height ?? 0) / 2);
  const seen = new Set();
  const key = (cell) => `${Math.round(cell.x / CELL)}|${Math.round(cell.y / CELL)}|${Math.round(cell.z / 3)}`;
  const queue = [];
  for (let dx = -search; dx <= search; dx += CELL) {
    for (let dy = -search; dy <= search; dy += CELL) {
      if (trigger.radius > 0 && Math.hypot(dx, dy) > search) continue;
      const x = trigger.x + dx;
      const y = trigger.y + dy;
      const top = trigger.z + tall;
      const ground = probe.hole(x, y) ? undefined : probe.ground(x, y);
      // Each level under the volume's top that is inside it.
      for (let from = top; from > trigger.z - tall - 3;) {
        const floor = probe.floor?.(x, y, from, trigger.z - tall - 3);
        if (floor === undefined) break;
        const cell = { x, y, z: floor };
        if (!seen.has(key(cell))) {
          seen.add(key(cell));
          queue.push(cell);
        }
        from = floor - 2.5;
      }
      if (ground !== undefined && ground <= top && ground >= trigger.z - tall - 3) {
        const cell = { x, y, z: ground };
        if (!seen.has(key(cell))) {
          seen.add(key(cell));
          queue.push(cell);
        }
      }
    }
  }
  const start = queue[0];
  if (!start) return { verdict: "no-floor" };
  const stops = [];
  let farthest = 0;
  let outdoors;
  let settledAt = start;
  const nearDoors = new Map();
  const tally = {};
  const deadline = Date.now() + MAX_SECONDS * 1000;
  let timedOut = false;
  for (let head = 0; head < queue.length && seen.size < MAX_CELLS && !outdoors; head++) {
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    const cell = queue[head];
    if (Math.hypot(cell.x - settledAt.x, cell.y - settledAt.y) > 12) {
      await settle(map, cell.x, cell.y);
      settledAt = cell;
      probe = createTerrainProbe(terrain, collision, map);
    }
    for (const door of doors) {
      if (door.map === map && Math.hypot(door.x - cell.x, door.y - cell.y, door.z - cell.z) < DOOR_YARDS) nearDoors.set(door.guid, door);
    }
    for (const [dx, dy] of DIRECTIONS) {
      const x = cell.x + dx * CELL;
      const y = cell.y + dy * CELL;
      const z = floorNear(probe, x, y, cell.z);
      if (z === undefined) continue;
      const next = { x, y, z };
      if (seen.has(key(next))) continue;
      const away = Math.hypot(x - trigger.x, y - trigger.y);
      if (away > MAX_YARDS) continue;
      if (collision.world?.firstHit({ x: cell.x, y: cell.y, z: cell.z + 1.2 }, { x, y, z: z + 1.2 })) continue;
      // The game asks for a tile it is about to reach and waits for it; nothing here asks unless this does.
      if (probe.loaded && (!probe.loaded(x, y) || !probe.loaded(cell.x, cell.y))) await settle(map, x, y);
      const walk = walks(probe, next, cell);
      if (!walk.ok) {
        // A body that never left its cell was set down inside something; one that got over the cell but on another level climbed.
        const kind = walk.travelled < 0.25 ? "stuck"
          : Math.hypot(walk.position.x - cell.x, walk.position.y - cell.y) < 1.2 ? "level"
            : classify(collision.world, probe, walk.position, cell);
        tally[kind] = (tally[kind] ?? 0) + 1;
        if (kind === "invisible") {
          stops.push({ kind, x: +walk.position.x.toFixed(1), y: +walk.position.y.toFixed(1), z: +walk.position.z.toFixed(1),
            toward: [+cell.x.toFixed(1), +cell.y.toFixed(1)], ground: probe.ground(cell.x, cell.y), hole: probe.hole(next.x, next.y) });
        }
      }
      seen.add(key(next));
      queue.push(next);
      farthest = Math.max(farthest, away);
      const ground = probe.hole(x, y) ? undefined : probe.ground(x, y);
      // On the map's own ground, far enough from the portal not to be its doorstep: a player can come from here.
      if (ground !== undefined && Math.abs(ground - z) < 0.5 && away > 12 && !collision.world?.firstHit({ x, y, z: z + 2 }, { x, y, z: z + 30 })) {
        outdoors = next;
        break;
      }
    }
  }
  const verdict = outdoors ? "open" : timedOut ? "timeout" : seen.size >= MAX_CELLS ? "cell-limit" : farthest < WALLED_YARDS ? "walled-in" : "no-way-out";
  return {
    verdict, cells: seen.size, farthest: Math.round(farthest), start: [+start.x.toFixed(1), +start.y.toFixed(1), +start.z.toFixed(1)],
    outdoors: outdoors && [+outdoors.x.toFixed(1), +outdoors.y.toFixed(1), +outdoors.z.toFixed(1)],
    invisible: stops, invisibleCount: stops.length, stopped: tally,
    frontier: queue.slice(-8).map((cell) => [+cell.x.toFixed(1), +cell.y.toFixed(1), +cell.z.toFixed(1)]),
    doors: [...nearDoors.values()].map((door) => `${door.name} (${door.guid}, state ${door.state})`),
  };
}

const triggers = areaTriggers();
const ids = option("ids", undefined)?.split(",").map(Number);
const teleports = worldQuery("SELECT ID,Name,target_map FROM areatrigger_teleport ORDER BY ID");
const doors = worldQuery("SELECT g.guid,g.map,g.position_x,g.position_y,g.position_z,g.state,t.name FROM gameobject g JOIN gameobject_template t ON t.entry=g.id WHERE t.type=0 AND g.state=1")
  .map(([guid, map, x, y, z, state, name]) => ({ guid: Number(guid), map: Number(map), x: Number(x), y: Number(y), z: Number(z), state: Number(state), name }));
const limit = Number(option("limit", "100000"));
mkdirSync(OUT, { recursive: true });
const results = [];
const out = join(OUT, ids ? "report-partial.json" : "report.json");
for (const [id, name, targetMap] of teleports) {
  if (ids && !ids.includes(Number(id))) continue;
  if (results.length >= limit) break;
  const trigger = triggers.get(Number(id));
  if (!trigger) continue;
  const started = Date.now();
  let result;
  try {
    result = await census(trigger, doors);
  } catch (error) {
    result = { verdict: "error", error: String(error).slice(0, 200) };
  }
  const row = { id: Number(id), name, map: trigger.map, targetMap: Number(targetMap), seconds: Math.round((Date.now() - started) / 1000), ...result };
  results.push(row);
  console.log(`${String(id).padStart(5)} map ${String(trigger.map).padStart(3)} ${String(result.verdict).padEnd(10)} cells ${String(result.cells ?? 0).padStart(4)} far ${String(result.farthest ?? 0).padStart(3)} walls ${String(result.invisibleCount ?? 0).padStart(3)} doors ${result.doors?.length ?? 0} ${row.seconds}s ${name}`);
  writeFileSync(out, JSON.stringify(results, null, 1));
}
const tally = {};
for (const row of results) tally[row.verdict] = (tally[row.verdict] ?? 0) + 1;
console.log(tally);
process.exit(0);
