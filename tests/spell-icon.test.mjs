import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { blpToPng } from "../tools/blp-png.mjs";
import { openClientArchives } from "../tools/mpq.mjs";
import { repositoryRoot } from "../tools/paths.mjs";
import { sourceStamp, stampSidecar, writeSourceStamp } from "../tools/source-stamp.mjs";

const encoder = new TextEncoder();
const ORIGIN = "http://127.0.0.1:5173";
const CUSTOM_ICON = "Interface\\Icons\\Custom_Fire";

function stringBlock(values) {
  const offsets = new Map();
  const bytes = [0];
  for (const value of values) {
    offsets.set(value, bytes.length);
    bytes.push(...encoder.encode(value), 0);
  }
  return { bytes: Uint8Array.from(bytes), offsets };
}

function dbcFixture(fields, rows, strings) {
  const result = new Uint8Array(20 + rows.length * fields * 4 + strings.byteLength);
  result.set(encoder.encode("WDBC"));
  const view = new DataView(result.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint32(8, fields, true);
  view.setUint32(12, fields * 4, true);
  view.setUint32(16, strings.byteLength, true);
  for (let row = 0; row < rows.length; row++) {
    for (let field = 0; field < fields; field++) view.setUint32(20 + (row * fields + field) * 4, rows[row][field] ?? 0, true);
  }
  result.set(strings, 20 + rows.length * fields * 4);
  return result;
}

/** A 2x2 palette BLP2, which is the smallest thing `tools/blp.mjs` will decode. */
function blp() {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 1;
  header[9] = 0;
  header[10] = 0;
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
 * A dataset as a module leaves it: two custom `SpellIcon` rows and one custom `CreatureFamily`,
 * and the picture one of them names sitting loose in a patch directory.
 *
 * `Missing_Fire` is named by a row and is in no archive, which is the shape 22 of the 3,226 stock
 * rows have on this machine — that is what the route has to answer 404 for.
 */
async function customDataset({ withPicture = true } = {}) {
  const client = await mkdtemp(join(tmpdir(), "webclient-icon-client-"));
  const dbc = await mkdtemp(join(tmpdir(), "webclient-icon-dbc-"));
  const icons = await mkdtemp(join(tmpdir(), "webclient-icon-cache-"));
  const families = await mkdtemp(join(tmpdir(), "webclient-family-cache-"));
  const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ");
  await mkdir(join(patch, "Interface", "Icons"), { recursive: true });
  if (withPicture) await writeFile(join(patch, "Interface", "Icons", "Custom_Fire.blp"), blp());

  const strings = stringBlock([CUSTOM_ICON, "Interface\\Icons\\Missing_Fire"]);
  await writeFile(join(dbc, "SpellIcon.dbc"), dbcFixture(2, [
    [80900, strings.offsets.get(CUSTOM_ICON)],
    [80901, strings.offsets.get("Interface\\Icons\\Missing_Fire")],
  ], strings.bytes));
  // 28 fields, and `IconFile` is the last of them; `Name_lang` before it is seventeen slots wide.
  const family = Array(28).fill(0);
  family[0] = 61;
  family[27] = strings.offsets.get(CUSTOM_ICON);
  await writeFile(join(dbc, "CreatureFamily.dbc"), dbcFixture(28, [family], strings.bytes));
  return { client, dbc, icons, families };
}

async function removeDataset({ client, dbc, icons, families }) {
  for (const directory of [client, dbc, icons, families]) await rm(directory, { recursive: true, force: true });
}

/**
 * The gateway as `main.ts` wires it, with the real generator behind the two routes and a count of
 * how many times it was actually spawned.
 */
async function iconGateway({ client, dbc, icons, families }, { restamp = false, holdRestamp = false } = {}) {
  const spawns = [];
  // The pass runs off every request path on purpose, so a test that wants to see what it did has
  // to be able to wait for it — and a test that wants to prove a request does *not* wait for it
  // has to be able to hold it, or "served as it stands" and "served what the pass left" are the
  // same bytes and neither assertion says anything.
  let restampFinished;
  const restamped = new Promise((done) => { restampFinished = done; });
  let release;
  const held = new Promise((go) => { release = go; });
  const generate = async (args) => {
    spawns.push(args.join(" "));
    try {
      if (args[0] === "--restamp" && holdRestamp) await held;
      await promisify(execFile)(
        process.execPath,
        [resolve(repositoryRoot, "tools/generate-spell-icons.mjs"), ...args],
        { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: client, DBC_DIR: dbc, SPELL_ICON_DIR: icons, CREATURE_ICON_DIR: families } },
      );
    } finally {
      if (args[0] === "--restamp") restampFinished();
    }
  };
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN],
    dbcDirectory: dbc,
    clientDirectory: client,
    datasetPollMs: 0,
    spellIconsDirectory: icons,
    generateSpellIcon: (iconId) => generate([String(iconId)]),
    creatureIconsDirectory: families,
    generateCreatureIcon: (familyId) => generate(["--family", String(familyId)]),
    // Off unless a test asks for it: `main.ts` always wires it, but a gateway that starts one more
    // child would put `--restamp` at the head of every `spawns` list in this file for tests that
    // are about the routes and not about the pass.
    ...(restamp ? { restampCaches: () => generate(["--restamp"]) } : {}),
  });
  return {
    gateway, spawns, restamped, release,
    get: (path) => fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers: { origin: ORIGIN } }),
  };
}

test("a SpellIcon row a module added is served without anyone rerunning the asset build", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  try {
    const response = await get("/spell-icon/80900");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    const png = Buffer.from(await response.arrayBuffer());
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the answer has to be a PNG");
    assert.deepEqual(spawns, ["80900"], "one miss, one generator");

    // And it is published beside the others, with a stamp that names where it came from — so the
    // next gateway serves it from disk, and a rebuilt dataset invalidates it.
    assert.deepEqual(await readFile(join(dataset.icons, "80900.png")), png);
    const stamp = JSON.parse(await readFile(stampSidecar(join(dataset.icons, "80900.png")), "utf8"));
    assert.equal(stamp.sources[0].path, `${CUSTOM_ICON}.blp`);
    assert.equal(stamp.sources[0].name, "patch-ruRU-A.MPQ");
    assert.ok(stamp.files.some((file) => file.file.endsWith("SpellIcon.dbc")),
      "the table that said which picture this is has to be in the stamp too");

    // Second request: the file is there and its stamp still matches, so nothing is spawned.
    assert.equal((await get("/spell-icon/80900")).status, 200);
    assert.deepEqual(spawns, ["80900"]);

    // The same rule as every other route on this port: no Origin, no answer.
    assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/spell-icon/80900`)).status, 403);
  } finally {
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("a pet family's own icon comes from the same generator on its own route", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  try {
    // Both tables count from 1, and both routes run on one lane, so the lane's keys have to say
    // which table they mean. Spell icon 61 does not exist and its failure is remembered; family
    // 61 does, and must not inherit that answer.
    assert.equal((await get("/spell-icon/61")).status, 404);
    assert.deepEqual(spawns, ["61"]);

    const response = await get("/creature-icon/61");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.deepEqual(spawns, ["61", "--family 61"]);
    await access(join(dataset.families, "61.png"));
  } finally {
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("an icon id that names no picture answers 404, once, and is remembered", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  try {
    assert.equal((await get("/spell-icon/80901")).status, 404, "the row names a file no archive holds");
    assert.deepEqual(spawns, ["80901"]);

    // Without the lane's failure memory this is a generator process per request per player, and
    // it starves the icons that would have succeeded.
    assert.equal((await get("/spell-icon/80901")).status, 404);
    assert.deepEqual(spawns, ["80901"], "a failure that was just seen is not tried again");

    // An id no row mentions at all is the same answer by a different road, and is remembered the
    // same way: the generator finding nothing to do is not the generator succeeding.
    assert.equal((await get("/spell-icon/70000")).status, 404);
    assert.deepEqual(spawns, ["80901", "70000"]);
    assert.equal((await get("/spell-icon/70000")).status, 404);
    assert.deepEqual(spawns, ["80901", "70000"]);
  } finally {
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("a stamped picture is handed over untouched and costs no extraction", async () => {
  const dataset = await customDataset();
  const chain = await openClientArchives(dataset.client);
  try {
    const published = Buffer.from("PNG-published-by-the-bulk-pass");
    await writeFile(join(dataset.icons, "80900.png"), published);
    await writeSourceStamp(join(dataset.icons, "80900.png"), await sourceStamp(chain, {
      paths: [`${CUSTOM_ICON}.blp`],
      files: [join(dataset.dbc, "SpellIcon.dbc")],
    }));
    chain.close();

    const { gateway, spawns, get } = await iconGateway(dataset);
    try {
      const warm = await get("/spell-icon/80900");
      assert.equal(warm.status, 200);
      assert.deepEqual(Buffer.from(await warm.arrayBuffer()), published,
        "a stamped picture is handed over untouched");
      assert.deepEqual(spawns, [], "and costs no extraction at all");
    } finally {
      await gateway.close();
    }
  } finally {
    await removeDataset(dataset);
  }
});

test("the warm cache is answered at once and stamped in one pass, not one process a picture", async () => {
  const dataset = await customDataset();
  try {
    // What `build-assets.bat` left on this machine: 3,204 pictures and not one sidecar. Д0 asked
    // for an entry with no stamp to be rebuilt once so that it gains one, and taken literally here
    // that is 3,204 child processes on the one lane both icon routes share — measured against the
    // real dataset, sixteen already-published icons asked for at once took 5,921 ms and sixteen
    // processes, one every 370 ms with nothing overlapping. So the picture is served as it stands
    // and the whole cache is stamped in one pass, started when the gateway comes up.
    const correct = blpToPng(blp());
    await writeFile(join(dataset.icons, "80900.png"), correct);
    // And one that is not what this dataset decodes to: 80901's row names a file no archive holds.
    await writeFile(join(dataset.icons, "80901.png"), Buffer.from("PNG-from-before-stamps-existed"));

    // Held, so that both requests below are answered while the pass is still running: it is the
    // only way to tell "served as it stands" from "served whatever the pass left behind".
    const { gateway, spawns, restamped, release, get } = await iconGateway(dataset, { restamp: true, holdRestamp: true });
    try {
      assert.deepEqual(spawns, ["--restamp"], "one pass for the whole cache, and it starts at startup");
      const first = await get("/spell-icon/80900");
      assert.equal(first.status, 200);
      assert.deepEqual(Buffer.from(await first.arrayBuffer()), correct, "served as it stands");
      const second = await get("/spell-icon/80901");
      assert.equal(second.status, 200);
      assert.equal(await second.text(), "PNG-from-before-stamps-existed");
      assert.deepEqual(spawns, ["--restamp"], "and no picture waited for the pass, or started another");

      release();
      await restamped;
      // The one that matches keeps its bytes, gains a stamp, and is never asked about again.
      assert.deepEqual(await readFile(join(dataset.icons, "80900.png")), correct);
      const stamp = JSON.parse(await readFile(stampSidecar(join(dataset.icons, "80900.png")), "utf8"));
      assert.equal(stamp.sources[0].path, `${CUSTOM_ICON}.blp`);
      assert.equal((await get("/spell-icon/80900")).status, 200);
      assert.deepEqual(spawns, ["--restamp"]);

      // The one that does not is gone rather than repainted under a reader, and the route says so
      // by the ordinary road: a miss, one generator, 404.
      assert.equal((await get("/spell-icon/80901")).status, 404);
      assert.deepEqual(spawns, ["--restamp", "80901"]);
    } finally {
      release();
      await gateway.close();
    }
  } finally {
    await removeDataset(dataset);
  }
});

test("a picture that really is missing does not queue behind the pass", async () => {
  // The pass reads every family, so it cannot share a lane with any of them: a lane is one child
  // at a time, and the module's genuinely new icon — the case these routes exist for — would then
  // wait for the whole cache to be stamped before it was even started. That is the stall this
  // slice removes, arriving by the back door.
  const dataset = await customDataset();
  const { gateway, spawns, restamped, release, get } = await iconGateway(dataset, { restamp: true, holdRestamp: true });
  try {
    assert.deepEqual(spawns, ["--restamp"]);
    // Raced rather than awaited: on one lane this request never completes at all, and a test that
    // hangs reports nothing. Two seconds against a pass that is held until the line after.
    const answered = await Promise.race([
      get("/creature-icon/61").then((response) => response.status),
      new Promise((slow) => setTimeout(() => slow("queued behind the pass"), 2_000)),
    ]);
    assert.equal(answered, 200, "a family icon nothing has published yet has to be built now");
    assert.deepEqual(spawns, ["--restamp", "--family 61"]);
  } finally {
    release();
    // Raced here too, so that a build in which the pass never starts fails on the assertion above
    // instead of waiting for ever on a promise nothing will settle.
    await Promise.race([restamped, new Promise((give) => setTimeout(give, 5_000))]);
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("an id spelt with leading zeros is the same picture and the same failure", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  try {
    // `\d{1,8}` spells one id up to eight ways. The lane key used to be the digits that were
    // typed, so every spelling had a failure memory of its own and each one spawned the generator
    // again for a picture already known not to exist — while `ensureCurrent`, keyed on the
    // filename, thought the question was settled. `/item-icon` keys on the parsed number.
    assert.equal((await get("/spell-icon/80901")).status, 404);
    assert.deepEqual(spawns, ["80901"]);
    assert.equal((await get("/spell-icon/080901")).status, 404);
    assert.deepEqual(spawns, ["80901"], "the same id spelt longer is the same failure");
    assert.equal((await get("/spell-icon/00080901")).status, 404);
    assert.deepEqual(spawns, ["80901"]);

    // And on the way that succeeds, both spellings are the same file.
    assert.equal((await get("/spell-icon/80900")).status, 200);
    assert.deepEqual(spawns, ["80901", "80900"]);
    assert.equal((await get("/spell-icon/00080900")).status, 200);
    assert.deepEqual(spawns, ["80901", "80900"]);
  } finally {
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("a generator that fails says why, once, instead of being swallowed whole", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  const warnings = [];
  const spoke = console.warn;
  console.warn = (...parts) => warnings.push(parts.join(" "));
  try {
    // The 404 is right — 22 stock rows name a file no archive holds — but the catch that produces
    // it is the only reader of the generator's stderr, so a mis-set `DBC_DIR` or a full disk used
    // to look exactly like one of those 22: coloured squares and nothing written anywhere.
    assert.equal((await get("/spell-icon/80901")).status, 404);
    assert.equal(warnings.length, 1, `expected one line, got ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /spell:80901/);
    assert.match(warnings[0], /No icon found for SpellIcon 80901/);

    // And once per key, not once per request: the next five minutes of requests are answered from
    // the lane's memory without running anything, and there is nothing new to say about them.
    assert.equal((await get("/spell-icon/80901")).status, 404);
    assert.deepEqual(spawns, ["80901"]);
    assert.equal(warnings.length, 1, "the same failure is not repeated for every player");
  } finally {
    console.warn = spoke;
    await gateway.close();
    await removeDataset(dataset);
  }
});

test("the restamp pass proves what is published, and writes stamps rather than pictures", async () => {
  const dataset = await customDataset();
  try {
    const correct = blpToPng(blp());
    await writeFile(join(dataset.icons, "80900.png"), correct);
    await writeFile(join(dataset.icons, "80901.png"), Buffer.from("PNG-from-before-stamps-existed"));
    const before = await stat(join(dataset.icons, "80900.png"));

    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [resolve(repositoryRoot, "tools/generate-spell-icons.mjs"), "--restamp"],
      { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: dataset.client, DBC_DIR: dataset.dbc, SPELL_ICON_DIR: dataset.icons, CREATURE_ICON_DIR: dataset.families } },
    );
    // On stderr, because the gateway spawns this pass at startup and relays exactly that stream:
    // StormLib's banner and every heap resize land on the child's stdout, which `main.ts` drops.
    // A report written to stdout is a report no operator ever reads.
    assert.match(stderr, /Stamped 1 published icon/);
    assert.match(stderr, /Dropped 1/);
    assert.doesNotMatch(stdout, /Stamped 1 published icon/, "and not on the stream the gateway throws away");

    // The pass runs while the gateway is serving this very directory — and `public/icons` is what
    // the dev server watches — so a picture that is already right must not be written again.
    const after = await stat(join(dataset.icons, "80900.png"));
    assert.equal(after.mtimeMs, before.mtimeMs, "a picture that matches is stamped, not rewritten");
    assert.deepEqual(await readFile(join(dataset.icons, "80900.png")), correct);
    const stamp = JSON.parse(await readFile(stampSidecar(join(dataset.icons, "80900.png")), "utf8"));
    assert.equal(stamp.sources[0].path, `${CUSTOM_ICON}.blp`);
    assert.ok(stamp.files.some((file) => file.file.endsWith("SpellIcon.dbc")));

    // The one that is not what this dataset decodes to is dropped rather than left unstamped: an
    // entry nothing can vouch for would make the route ask for this whole pass again on every
    // request for it.
    await assert.rejects(() => access(join(dataset.icons, "80901.png")));

    // Nothing left to prove the second time, and nothing spent proving it.
    const second = await promisify(execFile)(
      process.execPath,
      [resolve(repositoryRoot, "tools/generate-spell-icons.mjs"), "--restamp"],
      { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: dataset.client, DBC_DIR: dataset.dbc, SPELL_ICON_DIR: dataset.icons, CREATURE_ICON_DIR: dataset.families } },
    );
    assert.match(second.stderr, /Stamped 0 published icon/);
  } finally {
    await removeDataset(dataset);
  }
});

test("the bulk pass publishes both tables from one archive chain and sweeps what is stale", async () => {
  const dataset = await customDataset();
  try {
    // The icon of a dataset that is no longer in use, and a stamp beside it. Both have to go, or
    // the directory serves pictures the server has never heard of.
    await writeFile(join(dataset.icons, "424242.png"), Buffer.from("PNG-from-an-older-dataset"));
    await writeSourceStamp(join(dataset.icons, "424242.png"), { chain: "gone", sources: [], files: [] });

    const { stdout } = await promisify(execFile)(
      process.execPath,
      [resolve(repositoryRoot, "tools/generate-spell-icons.mjs"), "--all"],
      { cwd: repositoryRoot, env: { ...process.env, CLIENT_DIR: dataset.client, DBC_DIR: dataset.dbc, SPELL_ICON_DIR: dataset.icons, CREATURE_ICON_DIR: dataset.families } },
    );
    // One spell icon of the two rows resolves, and the family does. The family half is the half
    // that would be empty if the chain were closed after the first table — every source is shared
    // and closing it takes the sources out from under the second pass.
    assert.match(stdout, /Generated 1 spell icons and 1 creature-family icons/);
    assert.match(stdout, /Removed 1 icon/);
    await access(join(dataset.icons, "80900.png"));
    await access(join(dataset.families, "61.png"));
    assert.deepEqual(JSON.parse(await readFile(join(dataset.icons, "index.json"), "utf8")), [80900]);
    assert.deepEqual(JSON.parse(await readFile(join(dataset.families, "index.json"), "utf8")), [61]);
    await assert.rejects(() => access(join(dataset.icons, "424242.png")));
    await assert.rejects(() => access(stampSidecar(join(dataset.icons, "424242.png"))),
      "a stamp for a picture that is gone names nothing");
  } finally {
    await removeDataset(dataset);
  }
});

test("a module replacing the picture behind an id gets the new one without a restart", async () => {
  const dataset = await customDataset();
  const { gateway, spawns, get } = await iconGateway(dataset);
  try {
    const first = Buffer.from(await (await get("/spell-icon/80900")).arrayBuffer());
    assert.deepEqual(spawns, ["80900"]);

    // The author edits the picture in their patch directory. Nothing about the request changes —
    // same id, same path, same file name — so without the stamp the old PNG would be served for
    // the life of the process, which is what `data/` did before Д0.
    const wider = Buffer.from(blp());
    wider.writeUInt32LE(4, 12);
    wider.writeUInt32LE(1, 16);
    await writeFile(join(dataset.client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Interface", "Icons", "Custom_Fire.blp"), wider);

    const second = await get("/spell-icon/80900");
    assert.equal(second.status, 200);
    const repainted = Buffer.from(await second.arrayBuffer());
    assert.deepEqual(spawns, ["80900", "80900"], "the edit has to be noticed and rebuilt");
    assert.ok(!repainted.equals(first), "and the new picture is the one that reaches the browser");
  } finally {
    await gateway.close();
    await removeDataset(dataset);
  }
});
