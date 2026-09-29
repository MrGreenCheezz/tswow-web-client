import assert from "node:assert/strict";
import test from "node:test";
import {
  LOADING_STAGE_PROGRESS, LOADING_WIDE_ASPECT, LoadingScreenArtTable, gatewayHttpOrigin,
  loadingProgressStep, loadingScreenPicture, loadingTextureUrl,
} from "../dist/code/browser/ui/LoadingScreenArt.js";
import { loadLoadingScreens, wideLoadingScreenPath } from "../dist/code/gateway/LoadingScreenMetadata.js";

let dbcDirectory;
try {
  dbcDirectory = (await import("../tools/paths.mjs")).dbcDirectory();
} catch {
  dbcDirectory = undefined;
}
const withDataset = { skip: dbcDirectory ? false : "no tswow dataset on this machine" };

test("a map's loading screen follows Map.LoadingScreenID into LoadingScreens.dbc", withDataset, async () => {
  const art = await loadLoadingScreens(dbcDirectory);
  // Continents carry HasWideScreen and ship a `Wide` twin; instances do not.
  assert.deepEqual(art[1], {
    file: "Interface\\Glues\\LoadingScreens\\LoadScreenKalimdor.blp",
    wide: "Interface\\Glues\\LoadingScreens\\LoadScreenKalimdorWide.blp",
  });
  assert.equal(art[0]?.file, "Interface\\Glues\\LoadingScreens\\LoadScreenEasternKingdom.blp");
  assert.equal(art[571]?.wide, "Interface\\Glues\\LoadingScreens\\LoadScreenNorthrendWide.blp");
  assert.deepEqual(art[36], { file: "Interface\\Glues\\LoadingScreens\\LoadScreenDeadmines.blp" });
  assert.equal(art[609]?.file, "Interface\\Glues\\LoadingScreens\\LoadScreenDeathKnight.blp");
  // A map whose LoadingScreenID is 0 names no picture rather than a guessed one.
  assert.ok(Object.values(art).every((row) => row.file.toLowerCase().endsWith(".blp")));
  assert.ok(Object.keys(art).length < 135, "maps without a loading screen are left out");
});

test("the Wide twin is the row's path with Wide before the extension", () => {
  assert.equal(wideLoadingScreenPath("Interface\\Glues\\LoadingScreens\\LoadScreenOutland.blp"),
    "Interface\\Glues\\LoadingScreens\\LoadScreenOutlandWide.blp");
  assert.equal(wideLoadingScreenPath("A.b\\LOADSCREEN.BLP"), "A.b\\LOADSCREENWide.BLP");
});

test("the wide picture is chosen only on a widescreen display and only when it ships", () => {
  const kalimdor = { file: "K.blp", wide: "KWide.blp" };
  assert.deepEqual(loadingScreenPicture(kalimdor, 16 / 9), { path: "KWide.blp", wide: true });
  assert.deepEqual(loadingScreenPicture(kalimdor, 16 / 10), { path: "KWide.blp", wide: true });
  assert.deepEqual(loadingScreenPicture(kalimdor, 4 / 3), { path: "K.blp", wide: false });
  assert.deepEqual(loadingScreenPicture(kalimdor, 5 / 4), { path: "K.blp", wide: false });
  assert.ok(LOADING_WIDE_ASPECT > 4 / 3 && LOADING_WIDE_ASPECT < 16 / 10);
  assert.deepEqual(loadingScreenPicture({ file: "D.blp" }, 16 / 9), { path: "D.blp", wide: false });
  assert.equal(loadingScreenPicture(undefined, 16 / 9), undefined);
});

test("gateway URLs: the texture route over the gateway's HTTP origin", () => {
  assert.equal(gatewayHttpOrigin("ws://127.0.0.1:8090/auth"), "http://127.0.0.1:8090");
  assert.equal(gatewayHttpOrigin("wss://example.test/auth"), "https://example.test");
  assert.equal(gatewayHttpOrigin("not a url"), undefined);
  assert.equal(loadingTextureUrl("http://127.0.0.1:8090", "Interface/Glues/LoadingBar/Loading-BarFill.blp"),
    "http://127.0.0.1:8090/texture?path=Interface%5CGlues%5CLoadingBar%5CLoading-BarFill.blp");
});

test("the bar creeps toward its stage ceiling and never goes back", () => {
  let value = 0;
  value = loadingProgressStep(value, LOADING_STAGE_PROGRESS.terrain, 900);
  assert.ok(value > 0.35 && value < LOADING_STAGE_PROGRESS.terrain, `${value}`);
  for (let frame = 0; frame < 600; frame++) value = loadingProgressStep(value, LOADING_STAGE_PROGRESS.terrain, 16);
  assert.ok(value <= LOADING_STAGE_PROGRESS.terrain && value > LOADING_STAGE_PROGRESS.terrain - 0.01);
  assert.equal(loadingProgressStep(0.7, 0.3, 1000), 0.7, "a lower ceiling does not pull the bar back");
  assert.equal(loadingProgressStep(Number.NaN, 0.5, 0), 0);
});

test("the art table is fetched once per origin, and a failure is retried", async () => {
  const calls = [];
  let fail = true;
  const table = new LoadingScreenArtTable(async (url) => {
    calls.push(url);
    if (fail) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ 1: { file: "K.blp", wide: "KWide.blp" }, 2: { bogus: 1 } }) };
  });
  assert.equal(await table.load("http://gw"), undefined, "an old gateway without the route answers nothing");
  assert.equal(table.get(1), undefined);
  fail = false;
  await table.load("http://gw");
  await table.load("http://gw");
  assert.deepEqual(calls, ["http://gw/dbc/loading-screens", "http://gw/dbc/loading-screens"]);
  assert.deepEqual(table.get(1), { file: "K.blp", wide: "KWide.blp" });
  assert.equal(table.get(2), undefined, "a malformed row is dropped");
});
