// Т7: the gateway decides which spelling of a component texture to offer, against the archives.
//
// `ItemDisplayInfo` names a component texture's stem and the artist decided whether it shipped as
// `_M`/`_F` or as `_U`; the gateway used to offer the gendered spelling first and be wrong three
// times in four. Everything measured below comes off this machine: the archives under
// The configured client's Data directory and the DBCs of the TSWoW dataset.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CharacterTextureIndex, loadCharacterTextures, parseCharacterTextures,
} from "../dist/code/gateway/CharacterTextures.js";
import { CharacterAppearanceIndex } from "../dist/code/gateway/CharacterAppearance.js";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import { CHARACTER_APPEARANCE_VERSION } from "../dist/code/browser/CharacterAtlas.js";
import { CHARACTER_TEXTURE_PREFIXES } from "../tools/character-textures.mjs";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };
const withBoth = { skip: archives && dbcDirectory ? false : "no 3.3.5a client and dataset on this machine" };
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

/** The real listing, built once for every test below that needs it. */
let listing;
async function realTextures() {
  if (!listing) {
    const paths = [];
    for (const prefix of CHARACTER_TEXTURE_PREFIXES) for (const path of await archives.list(prefix)) paths.push(path);
    listing = CharacterTextureIndex.from(paths);
  }
  return listing;
}

let indexes;
async function both() {
  indexes ??= {
    guessing: await CharacterAppearanceIndex.load(dbcDirectory),
    knowing: await CharacterAppearanceIndex.load(dbcDirectory, realTextures()),
  };
  return indexes;
}

test("the index answers about paths however they are spelt, and knows what it never saw", () => {
  const index = CharacterTextureIndex.from([
    "Item\\TextureComponents\\LegUpperTexture\\Leather_A_03Black_Pant_LU_U.blp",
    "Textures/BakedNpcTextures/CreatureDisplayExtra-99.blp",
  ]);
  assert.equal(index.size, 2);
  // MPQ paths are case-insensitive and slash-agnostic, and the DBCs are not consistent about
  // either: four of the 74 appearance-less displays spell their first component `CHARACTER\`.
  assert.equal(index.has("ITEM/TEXTURECOMPONENTS/LEGUPPERTEXTURE/LEATHER_A_03BLACK_PANT_LU_U.BLP"), true);
  assert.equal(index.has("Textures\\BakedNpcTextures\\CreatureDisplayExtra-99.blp"), true);
  assert.equal(index.has("Item\\TextureComponents\\LegUpperTexture\\Leather_A_03Black_Pant_LU_M.blp"), false);

  // And the difference between "not there" and "never shown that shelf". An archive answers an
  // enumeration out of its `(listfile)`; one built by hand need not carry one, and a module's
  // textures would then all be declared missing.
  assert.equal(index.knows("Item\\TextureComponents\\LegUpperTexture\\Anything.blp"), true);
  assert.equal(index.knows("Item\\TextureComponents\\FootTexture\\Anything.blp"), false);
  assert.equal(index.knows("Anything.blp"), false);
});

test("the listing is read the way the child writes it, and a failed listing is no index at all", async () => {
  const paths = parseCharacterTextures(
    "item\\texturecomponents\\handtexture\\a_u.blp\n\nItem/TextureComponents/HandTexture/B_U.BLP\n  \n");
  assert.deepEqual([...paths], [
    "item\\texturecomponents\\handtexture\\a_u.blp",
    "item\\texturecomponents\\handtexture\\b_u.blp",
  ]);

  // Undefined rather than an empty index, and that is the whole safety of this slice: an empty one
  // says every file is missing, and every reader takes "missing" as "do not offer this".
  assert.equal(await loadCharacterTextures(undefined), undefined);
  assert.equal(await loadCharacterTextures(async () => []), undefined);
  assert.equal(await loadCharacterTextures(async () => { throw new Error("no client"); }), undefined);
  const index = await loadCharacterTextures(async () => ["Item\\TextureComponents\\HandTexture\\A_U.blp"]);
  assert.equal(index?.size, 1);
});

test("Т7 the archives' listing agrees with asking them path by path", withClient, async () => {
  // The listing is the cheap half of a trade and it is only worth having if it is the same answer.
  // Measured over the whole of `Item\TextureComponents\`: 57,540 spellings, 57,540 agreements.
  const index = await realTextures();
  const sample = [];
  for (const path of await archives.list("Item\\TextureComponents\\LegUpperTexture\\")) {
    sample.push(path);
    if (sample.length >= 400) break;
  }
  assert.ok(sample.length >= 400, "the leg component directory has to be in this client");
  for (const path of sample) {
    assert.equal(index.has(path), true, path);
    assert.equal(await archives.has(path), true, `${path} is enumerated but not held`);
  }
  // And the other direction: a name nothing holds is absent from both.
  const absent = "Item\\TextureComponents\\LegUpperTexture\\Generic_DwPr_01_Pants_LU_M.blp";
  assert.equal(index.has(absent), false);
  assert.equal(await archives.has(absent), false);
});

test("Т7 the first path offered for a leg exists, for two hundred leg displays", withBoth, async () => {
  // The plan's acceptance. It asks for 200 real `INVTYPE_LEGS` items; the sample here is 200
  // displays that name a `LegUpperTexture`, worn as `INVTYPE_LEGS`, because the world database's
  // item dump is machine-local and git-ignored and a test that skips on this machine is no test.
  // It is the same code path to the character: `SLOT_APPEARANCE[7]` paints components 5 and 6 for
  // whatever display it is handed. Taken by hand over the real dump for the record — 2,243
  // `INVTYPE_LEGS` items, 1,498 distinct displays, 1,494 `LegUpperTexture` layers over 948 names,
  // 1,291 first-request 404s before and 5 after. The 200 sampled here, out of the 11,089 rows that
  // name an upper leg, come to 178 before and 4 after.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const table = await openDbcFile(dbcDirectory, "ItemDisplayInfo");
  const displays = [];
  for (const row of table.rows()) {
    const id = table.id(row);
    // Component 5 is `LegUpperTexture`; the order of the eight is the table's own.
    if (id > 0 && table.string(row, "Texture", 5)) displays.push(id);
  }
  assert.ok(displays.length >= 200, `expected at least 200 leg displays, got ${displays.length}`);
  // Spread across the table rather than the first two hundred rows, which are all vanilla cloth.
  const step = Math.floor(displays.length / 200);
  const sample = Array.from({ length: 200 }, (_, index) => displays[index * step]);

  const { guessing, knowing } = await both();
  const index = await realTextures();
  const legUpper = (appearance) =>
    appearance.body.filter((layer) => layer.path.toLowerCase().includes("leguppertexture"));
  let before = 0;
  let after = 0;
  let layers = 0;
  const stillMissing = [];
  for (const displayId of sample) {
    const worn = [{ slot: 6, inventoryType: 7, displayId }];
    for (const layer of legUpper(guessing.forPlayer(1, 0, 0, 0, 0, 0, 0, worn))) {
      layers++;
      if (!index.has(layer.path)) before++;
    }
    for (const layer of legUpper(knowing.forPlayer(1, 0, 0, 0, 0, 0, 0, worn))) {
      if (!index.has(layer.path)) { after++; stillMissing.push(layer.path); }
      // Whichever spelling it chose, the pair is still on the wire for a page built before Т7.
      assert.equal(layer.candidates[0], layer.path);
    }
  }
  assert.equal(layers, 200, "every one of the sampled displays paints its upper leg");
  assert.ok(before > layers * 0.8, `the fault being fixed is ~87% of first requests, measured ${before}/${layers}`);
  // The only names left are the ones no spelling of which is in the client. The listing never
  // removes a spelling, only reorders, so those keep the two 404s they always paid.
  assert.ok(after <= 5, `${after} first paths still missing: ${stillMissing.join(", ")}`);
});

test("Т7 the spelling the archives hold leads, and both are still offered", withBoth, async () => {
  const { knowing } = await both();
  const index = await realTextures();
  // A garment measured in the report as shipping only as `_U`, and one that ships as `_M` and `_F`
  // and not as `_U`. Both are read out of the archives here rather than taken on trust.
  const unisexOnly = "Item\\TextureComponents\\LegUpperTexture\\Leather_A_03Black_Pant_LU";
  assert.equal(index.has(`${unisexOnly}_U.blp`), true);
  assert.equal(index.has(`${unisexOnly}_M.blp`), false);

  let checked = 0;
  for (let displayId = 1; displayId < 60_000 && checked < 500; displayId++) {
    const worn = [{ slot: 6, inventoryType: 7, displayId }];
    for (const layer of knowing.forPlayer(1, 0, 0, 0, 0, 0, 0, worn).body) {
      if (!layer.candidates) continue;
      checked++;
      // Every candidate is a spelling of the same stem, and the first one is what `path` says.
      assert.equal(layer.path, layer.candidates[0]);
      assert.equal(layer.alternate, layer.candidates[1]);
      assert.ok(layer.candidates.length <= 2, "there are only ever two spellings to choose between");
      for (const candidate of layer.candidates) assert.match(candidate, /_[MFU]\.blp$/);
      // And the assertion the review found missing: everything above is true of the pre-Т7
      // ordering too, so this test used to pass on a `#paint` that never opened the listing at
      // all. Whenever any spelling of this stem is in the client, the one offered first has to be
      // one that is — the slice's whole claim, stated per layer rather than in aggregate.
      if (layer.candidates.some((candidate) => index.has(candidate))) {
        assert.ok(index.has(layer.path), `${layer.path} leads, and the archives do not hold it`);
      }
    }
  }
  assert.ok(checked >= 500, `expected 500 component layers to check, got ${checked}`);
});

test("Т6 an extended display whose bake is not in the client still gets a body", withBoth, async () => {
  // A bake replaces every other layer, so any missing bake used to leave a one-element body that
  // resolved to nothing — and the browser rebuilt that nothing sixty times a second. The exact
  // count is intentionally not fixed here: optional visual patches can add some of the files while
  // the fallback must keep working for whichever bakes this archive chain still lacks.
  const { openDbcFile } = await import("../tools/dbc.mjs");
  const { guessing, knowing } = await both();
  const index = await realTextures();
  const extra = await openDbcFile(dbcDirectory, "CreatureDisplayInfoExtra");

  let named = 0;
  const missing = [];
  for (const row of extra.rows()) {
    const id = extra.id(row);
    if (id <= 0) continue;
    const bake = extra.string(row, "BakeName").replaceAll("/", "\\");
    if (!bake) continue;
    named++;
    if (!index.has(`Textures\\BakedNpcTextures\\${bake}`)) missing.push(id);
  }
  assert.equal(named, 15_453, "the count the plan was written against");
  assert.ok(missing.length > 0, "this client needs at least one missing bake to exercise the fallback");

  // Counted layer by layer rather than body by body: the old form of this loop stopped at the first
  // layer that resolved, so it could pass while the rest of a fallback body was still unavailable.
  let layers = 0;
  let inClient = 0;
  const absent = [];
  for (const id of missing) {
    const guessed = guessing.forNpc(id);
    const known = knowing.forNpc(id);
    assert.equal(guessed.body.length, 1, "before: one layer, and it is the bake that is not there");
    assert.match(guessed.body[0].path, /BakedNpcTextures/);
    assert.ok(known.body.length >= 1, `display ${id} has to have a body`);
    assert.ok(!known.body.some((layer) => /BakedNpcTextures/.test(layer.path)),
      `display ${id} must not still be asking for the bake`);
    let held = 0;
    for (const layer of known.body) {
      layers++;
      if (await archives.has(layer.path)) { held++; inClient++; } else absent.push(layer.path);
    }
    // Whatever else is missing, every affected display paints: a fallback that resolved to nothing
    // would only have moved the fault from the bake to the skin.
    assert.ok(held > 0, `display ${id}: ${known.body.map((layer) => layer.path).join(", ")}`);
  }
  assert.ok(layers >= missing.length, "every missing bake was replaced with one or more body layers");
  assert.ok(inClient >= missing.length,
    `every missing bake has at least one drawable fallback; absent: ${absent.join(", ")}`);

  // And a display whose bake *is* there is untouched; that remains the common case.
  const baked = knowing.forNpc(21_099) ?? knowing.forNpc(15_376);
  assert.ok(baked);
  assert.equal(baked.body.length, 1);
  assert.match(baked.body[0].path, /BakedNpcTextures/);
});

test("Т7 the listing is built once and read again when the archives move", withDataset, async () => {
  // Through the whole gateway, because the invalidation is the gateway's: Д0's fingerprint reports
  // a DBC change and an archive change separately, and until now nothing here was built out of an
  // archive at all.
  const client = await mkdtemp(join(tmpdir(), "webclient-chartex-"));
  const patch = join(client, "Data", "ruRU", "patch-ruRU-A.MPQ", "Item", "TextureComponents", "LegUpperTexture");
  await mkdir(patch, { recursive: true });
  await writeFile(join(patch, "Module_Pant_LU_U.blp"), "BLP2");

  let listings = 0;
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://127.0.0.1:5173"],
    dbcDirectory,
    clientDirectory: client,
    listCharacterTextures: async () => {
      listings++;
      return ["Item\\TextureComponents\\LegUpperTexture\\Module_Pant_LU_U.blp"];
    },
    // Every request, so the test does not have to sleep out the default two seconds.
    datasetPollMs: 0,
  });
  const headers = { origin: "http://127.0.0.1:5173" };
  const ask = async () => {
    const response = await fetch(
      `http://127.0.0.1:${gateway.port}/dbc/character-appearance`
      + `?v=${CHARACTER_APPEARANCE_VERSION}&race=1&sex=0&skin=2&face=3&hair=4&hairColor=2&facialHair=5`,
      { headers });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    const first = await ask();
    assert.ok(first.body.length > 0);
    await ask();
    await ask();
    assert.equal(listings, 1, "one child, however many requests");

    // And the creature-model index folds in the same one: it carries an appearance per display, so
    // it makes the same two decisions, and a second child for it would be a second 762 ms and a
    // second 62 MB of StormLib.
    const models = await fetch(`http://127.0.0.1:${gateway.port}/dbc/creature-models?ids=49`, { headers });
    assert.equal(models.status, 200);
    const [human] = await models.json();
    assert.equal(human.id, 49);
    assert.ok(human.appearance, "display 49 is the human male every player carries");
    assert.equal(listings, 1, "the two indexes pay for one listing between them");

    // A module drops a texture into a patch directory and the chain now spells a file differently.
    await writeFile(join(patch, "Module_Pant_LU_M.blp"), "BLP2");
    await ask();
    assert.equal(listings, 2, "an archive change is read again without a restart");
    await ask();
    assert.equal(listings, 2, "and only once for that change");
  } finally {
    await gateway.close();
    await rm(client, { recursive: true, force: true });
  }
});

test("Т7 the listing costs one child, and the gateway holds only its answer", withClient, async () => {
  // The trade this design is: 762 ms of a child process that dies with its 62 MB of StormLib heap,
  // against a gateway that opens the archives itself and carries that heap for days. The numbers
  // here are the ones in the comments, taken again.
  const started = performance.now();
  const paths = [];
  for (const prefix of CHARACTER_TEXTURE_PREFIXES) for (const path of await archives.list(prefix)) paths.push(path);
  const elapsed = performance.now() - started;
  const index = CharacterTextureIndex.from(paths);
  assert.ok(index.size > 30_000, `expected the real client's two subtrees, got ${index.size} paths`);
  assert.ok(elapsed < 4_000, `enumerating both subtrees took ${elapsed.toFixed(0)} ms, measured 424 ms`);
  // Two subtrees and not the whole client: enumerating everything is 244,000 paths and 15 MB down
  // a pipe for two questions about 36,000 of them, and a patch *directory* is walked rather than
  // asked, so the prefix has to be applied on that side too.
  for (const path of paths) {
    assert.ok(CHARACTER_TEXTURE_PREFIXES.some((prefix) => path.startsWith(prefix.toLowerCase())), path);
  }
  // Both shelves have to be there or `knows` would quietly turn every answer into "unknown".
  assert.equal(index.knows("Item\\TextureComponents\\LegUpperTexture\\Anything.blp"), true);
  assert.equal(index.knows("Textures\\BakedNpcTextures\\Anything.blp"), true);
});
