import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { CLIENT_FILE_EXTENSIONS, clientFileContentType, validClientFilePath } from "../dist/code/gateway/Gateway.js";
import { validClientFilePath as generatorValidClientFilePath } from "../tools/generate-client-file.mjs";
import { MAX_ASSET_PATH } from "../dist/code/gateway/AssetPath.js";
import { tswowInstall } from "../tools/paths.mjs";

let archives;
try {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { clientDirectory } = await import("../tools/paths.mjs");
  archives = await clientArchives(clientDirectory());
} catch {
  archives = undefined;
}
const withClient = { skip: archives ? false : "no 3.3.5a client on this machine" };

test("/client/file serves an interface and nothing else", () => {
  // The four the route exists for. Case is the client's own — `GlueXML.toc` is spelt with capitals
  // inside the archives and a module writes whatever its author typed — so the gate cannot be
  // case-sensitive without refusing files the chain really holds.
  assert.equal(validClientFilePath("Interface\\GlueXML\\GlueXML.toc"), true);
  assert.equal(validClientFilePath("Interface\\GlueXML\\AccountLogin.lua"), true);
  assert.equal(validClientFilePath("Interface\\GlueXML\\AccountLogin.XML"), true);
  assert.equal(validClientFilePath("Fonts\\FRIZQT__.TTF"), true);
  // A forward-slash caller has not normalised yet and must not be told its path is malformed; the
  // route normalises before it asks.
  assert.equal(validClientFilePath("Interface/FrameXML/UIParent.lua"), true);
  // A module author names files in their own language, and it is their own patch directory this
  // reads out of — the same reason `AssetPath` is Unicode rather than ASCII.
  assert.equal(validClientFilePath("Interface\\Модуль\\Окно.xml"), true);
  // WoW add-on folders and files can begin with `!`; the selected client actually ships both.
  assert.equal(validClientFilePath("Interface\\AddOns\\!WCollectionsLoader\\!WCollectionsLoader.toc"), true);
  assert.equal(validClientFilePath("Interface\\AddOns\\WCollections\\Core\\!Util.lua"), true);
  for (const path of [
    "Interface\\AddOns\\!WCollectionsLoader\\!WCollectionsLoader.toc",
    "Interface\\AddOns\\WCollections\\Core\\!Util.lua",
    "Interface\\..\\!secret.lua",
  ]) assert.equal(generatorValidClientFilePath(path), validClientFilePath(path), path);

  // Everything else in the archives. These are not hypotheticals: the chain this route reads
  // includes real directories on disk that a tswow build writes into, so a DBC, a map and the
  // client's own configuration all sit one path away from the files above.
  for (const refused of [
    "DBFilesClient\\ChrRaces.dbc",
    "World\\Maps\\Azeroth\\Azeroth_32_32.adt",
    "Interface\\Glues\\Common\\Glues-Background.blp",
    "Interface\\Glues\\Models\\UI_Human\\UI_Human.m2",
    "Sound\\Music\\GlueScreenMusic\\wow_main_theme.mp3",
    "realmlist.wtf",
    "WTF\\Config.wtf",
    // No extension at all, and an extension with nothing in front of it at all.
    "Interface\\GlueXML\\GlueParent",
    ".lua",
  ]) assert.equal(validClientFilePath(refused), false, refused);
  // `Interface\GlueXML\.lua` passes, and that is `AssetPath`'s shared rule rather than this route's
  // choice: the "something in front of the dot" test is over the whole path, not the basename, for
  // all six callers. It names no file in any archive, so the chain answers nothing and the route
  // answers 404 — a shape question settled by the client rather than by the validator.
  assert.equal(validClientFilePath("Interface\\GlueXML\\.lua"), true);

  // The shape rules `AssetPath` owns, checked here because this route is the one that hands back
  // raw bytes: a traversal out of a patch directory would be a file read rather than a texture.
  assert.equal(validClientFilePath("Interface\\..\\..\\..\\Windows\\System32\\config\\SAM.lua"), false);
  assert.equal(validClientFilePath("..\\AccountLogin.lua"), false);
  assert.equal(validClientFilePath("C:\\Windows\\win.ini.lua"), false);
  assert.equal(validClientFilePath("\\\\server\\share\\AccountLogin.lua"), false);
  assert.equal(validClientFilePath("/etc/passwd.lua"), false);
  assert.equal(validClientFilePath("Interface\\GlueXML\\Account\u0000Login.lua"), false);
  assert.equal(validClientFilePath("Interface\\..\\!secret.lua"), false);
  assert.equal(validClientFilePath(""), false);
  assert.equal(validClientFilePath(`${"a".repeat(MAX_ASSET_PATH - 4)}.lua`), true);
  assert.equal(validClientFilePath(`${"a".repeat(MAX_ASSET_PATH - 3)}.lua`), false);
});

test("the two content types are the ones the bytes actually are", () => {
  // Measured over this client rather than assumed: 1,101 `.lua`/`.xml`/`.toc` files across the six
  // stock ruRU archives decode as valid UTF-8 with a strict decoder and none carries a BOM, and so
  // do all 561 the live chain resolves. A ruRU 3.3.5a client is exactly the case where cp1251 was
  // the plausible answer, so declaring the charset is a claim this suite has to keep honest.
  for (const extension of [".lua", ".xml", ".toc"]) {
    assert.equal(clientFileContentType(extension), "text/plain; charset=utf-8");
  }
  assert.equal(clientFileContentType(".ttf"), "font/ttf");
  assert.equal(clientFileContentType(".TTF"), "font/ttf");
  assert.deepEqual([...CLIENT_FILE_EXTENSIONS], ["lua", "xml", "toc", "ttf"]);
});

test("GlueXML comes out of the patch chain the game reads, not the locale archive", withClient, async (t) => {
  // The whole reason this route resolves through `tools/mpq.mjs` instead of opening an archive.
  // This server's login screen is a tswow module whose assets are a *directory* named
  // `patch-ruRU-<letter>.MPQ`; the installer may assign a different letter when modules change.
  // Check the resolved file's actual junction target, so an unrelated later patch cannot pass.
  const moduleAssets = join(tswowInstall(), "modules", "LoginScreenModule", "assets");
  if (!existsSync(moduleAssets)) {
    t.skip("LoginScreenModule is not installed with this client");
    return;
  }
  for (const path of ["Interface\\GlueXML\\GlueXML.toc", "Interface\\GlueXML\\AccountLogin.lua"]) {
    const source = await archives.sourceOf(path);
    assert.match(source?.name ?? "", /^patch-(?:[a-z]{4}-)?[a-z]\.mpq$/i, `${path} must come from a lettered patch`);
    assert.equal(source.kind, "directory", `${path} must come from the module's loose overlay`);
    const expected = join(moduleAssets, ...path.split("\\"));
    assert.equal((await realpath(source.file)).toLowerCase(), (await realpath(expected)).toLowerCase(),
      `${path} must resolve to LoginScreenModule's installed asset`);
  }
  // And the other half of the ranking: what the module does not override falls to tswow's own
  // build directory, above the locale archives that also carry it. `locale-ruRU.MPQ` holds 50
  // GlueXML entries and wins none of them.
  assert.equal(await archives.locate("Interface\\GlueXML\\CharacterCreate.lua"), "patch-ruRU-A.MPQ");
  assert.equal(await archives.locate("Interface\\GlueXML\\CharacterCreate.xml"), "patch-ruRU-A.MPQ");

  // The bytes the runtime will execute, in the encoding the route promises for them.
  const toc = await archives.read("Interface\\GlueXML\\GlueXML.toc");
  assert.ok(toc && toc.length > 0, "the module ships a GlueXML.toc");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(toc);
  assert.match(text, /AccountLogin\.xml/i, "and it names the screen the module replaced");
});
