import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { blpToPng } from "../tools/blp-png.mjs";
import { textureId } from "../tools/generate-texture.mjs";
import { publishWmoTexture } from "../tools/generate-visual-model.mjs";
import { openClientArchives } from "../tools/mpq.mjs";

// 10.20 slice 3: a WMO's textures come out of the shared texture cache — decoded once for every
// building that uses them — and land beside the artifact under the WMO's own name.

function blp(colour) {
  const header = Buffer.alloc(148 + 1024);
  header.write("BLP2", 0, "latin1");
  header.writeUInt32LE(1, 4);
  header[8] = 1;
  header[11] = 1;
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(2, 16);
  header.writeUInt32LE(148 + 1024, 20);
  header.writeUInt32LE(4, 84);
  for (const [index, entry] of [colour, [200, 100, 50, 255]].entries()) {
    for (let channel = 0; channel < 4; channel++) header[148 + index * 4 + channel] = entry[channel];
  }
  return Buffer.concat([header, Buffer.from([0, 1, 1, 0])]);
}

const WALL = "World\\Test\\Wall.blp";

test("the second building that uses a texture links the shared picture instead of decoding it again", async () => {
  const box = await mkdtemp(join(tmpdir(), "webclient-wmo-textures-"));
  const previous = process.env.TEXTURE_DIR;
  process.env.TEXTURE_DIR = join(box, "textures");
  let archives;
  try {
    const loose = join(box, "client", "Data", "ruRU", "patch-ruRU-A.MPQ", "World", "Test");
    await mkdir(loose, { recursive: true });
    const original = blp([10, 20, 30, 255]);
    await writeFile(join(loose, "Wall.blp"), original);
    const models = join(box, "visual-models");
    await mkdir(models, { recursive: true });
    archives = await openClientArchives(join(box, "client"));

    const first = join(models, "aaaa-0.png");
    assert.deepEqual(await publishWmoTexture(WALL, first, archives), { ok: true, shared: true });
    const shared = join(box, "textures", `${textureId(WALL)}.png`);
    const expected = blpToPng(original);
    assert.ok((await readFile(shared)).equals(expected), "the shared cache holds the decoded picture");
    assert.ok((await readFile(first)).equals(expected), "the building's copy is the same bytes");
    const sharedBefore = await stat(shared, { bigint: true });

    const second = join(models, "bbbb-3.png");
    assert.deepEqual(await publishWmoTexture(WALL, second, archives), { ok: true, shared: true });
    const sharedAfter = await stat(shared, { bigint: true });
    assert.equal(sharedAfter.mtimeNs, sharedBefore.mtimeNs, "the shared picture was not written again");
    assert.equal(sharedAfter.ino, sharedBefore.ino);
    assert.equal((await stat(second, { bigint: true })).ino, sharedBefore.ino, "the second building's file is a link to it");
    assert.ok((await readFile(second)).equals(expected));
    const leftovers = (await import("node:fs/promises")).readdir;
    assert.deepEqual((await leftovers(models)).filter((name) => name.endsWith(".tmp")), [], "no temporary left behind");

    // Asking again for a file that is already that link changes nothing.
    assert.deepEqual(await publishWmoTexture(WALL, second, archives), { ok: true, shared: true });

    // A module replaces the wall. The shared picture is now stale (its stamp names the old file),
    // and `publishTexture` would skip it because it has a stamp at all: the building must not be
    // published from it — it decodes the new wall into place as before.
    const replaced = blp([250, 250, 0, 255]);
    await writeFile(join(loose, "Wall.blp"), replaced);
    const later = new Date(Date.now() + 10_000);
    await utimes(join(loose, "Wall.blp"), later, later);
    const third = join(models, "cccc-1.png");
    const outcome = await publishWmoTexture(WALL, third, archives);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.shared, undefined, "a stale shared picture is not used");
    assert.ok((await readFile(third)).equals(blpToPng(replaced)), "the new wall, not the cached old one");

    // A texture the client does not hold: the old reason, from the old path.
    const absent = await publishWmoTexture("World\\Test\\Absent.blp", join(models, "dddd-0.png"), archives);
    assert.deepEqual(absent, { ok: false, reason: "the texture is not in the client" });
  } finally {
    archives?.close();
    if (previous === undefined) delete process.env.TEXTURE_DIR;
    else process.env.TEXTURE_DIR = previous;
    await rm(box, { recursive: true, force: true });
  }
});
