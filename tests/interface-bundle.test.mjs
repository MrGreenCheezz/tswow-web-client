// 25.10 (serve S3): the interface corpus in one gateway answer; the browser reads it first and /client/file for the rest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import { startGateway } from "../dist/code/gateway/Gateway.js";
import {
  interfaceTocEntries, interfaceXmlReferences, resolveInterfacePath, walkInterfaceCorpus,
} from "../dist/code/gateway/InterfaceBundle.js";
import {
  createBundledFileProvider, interfaceBundleUrl, parseInterfaceBundle, resetInterfaceBundles,
} from "../dist/code/browser/glue/InterfaceBundleClient.js";
import { resolveGluePath } from "../dist/code/browser/glue/GlueLoader.js";

const ORIGIN = "http://127.0.0.1:5173";

test("paths, TOC lines and XML references resolve as the browser's loaders resolve them", () => {
  for (const [base, reference] of [["interface/gluexml/", "..\\SharedXML\\X.lua"], ["interface/framexml/", "A.xml"],
    ["interface/", "..\\..\\x.lua"], ["interface/framexml/", "/Interface/FrameXML/B.lua"], ["interface/a/", "./b/../c.xml"]]) {
    assert.equal(resolveInterfacePath(base, reference), resolveGluePath(base, reference), `${base} + ${reference}`);
  }
  assert.deepEqual(interfaceTocEntries("﻿## Title: x\r\nGlueParent.xml\r\n#Commented.lua\r\n\r\n..\\SharedXML\\S.lua\r\nart.blp\r\n",
    "interface/gluexml/gluexml.toc"), ["interface/gluexml/glueparent.xml", "interface/sharedxml/s.lua"]);
  assert.deepEqual(interfaceXmlReferences(`<Ui><Script file="A.lua"/><!-- <Include file="Old.xml"/> -->
    <Frame name="x"><Scripts><OnLoad>Include()</OnLoad></Scripts></Frame><Include  file='Sub\\B.xml' />
    <Script>print(1)</Script></Ui>`, "interface/framexml/framexml.xml"),
  ["interface/framexml/a.lua", "interface/framexml/sub/b.xml"]);
});

test("the walk follows TOCs and XML references once each, reads TOC-only entries alone, and sorts out absent and failed", async () => {
  const files = {
    "interface/framexml/framexml.toc": "A.lua\nB.xml\nMissing.lua\nBroken.lua\n",
    "interface/framexml/a.lua": "a = 1",
    "interface/framexml/b.xml": '<Ui><Include file="C.xml"/><Script file="A.lua"/></Ui>',
    "interface/framexml/c.xml": '<Ui><Include file="B.xml"/></Ui>',
    "interface/addons/x/x.toc": "X.lua\n",
    "interface/addons/x/x.lua": "x = 1",
  };
  const asked = [];
  const read = async (path) => {
    asked.push(path);
    if (path.endsWith("broken.lua")) throw new Error("500");
    return files[path];
  };
  const corpus = await walkInterfaceCorpus(["interface/framexml/framexml.toc"], { read }, ["interface/addons/x/x.toc"]);
  assert.deepEqual([...corpus.files.keys()].sort(), ["interface/addons/x/x.toc", "interface/framexml/a.lua",
    "interface/framexml/b.xml", "interface/framexml/c.xml", "interface/framexml/framexml.toc"]);
  assert.deepEqual(corpus.absent, ["interface/framexml/missing.lua"]);
  assert.deepEqual(corpus.failed, ["interface/framexml/broken.lua"]);
  assert.equal(asked.length, new Set(asked).size, "each path read once, a cycle included");
  assert.equal(asked.includes("interface/addons/x/x.lua"), false, "a TOC-only add-on is not followed");
});

/** Publishes `files` into a client-file cache the way generate-client-file.mjs names them. */
async function publish(directory, files) {
  for (const [path, text] of Object.entries(files)) {
    const lower = path.replaceAll("/", "\\").toLowerCase();
    const id = createHash("sha1").update(`client-file-v1\0${lower}`).digest("hex");
    await writeFile(join(directory, `${id}${lower.slice(lower.lastIndexOf("."))}`), text);
  }
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject);
    request.end();
  });
}

const CORPUS = {
  "Interface/GlueXML/GlueXML.toc": "GlueStrings.lua\nGlueParent.xml\n..\\SharedXML\\Absent.lua\n",
  "Interface/GlueXML/GlueStrings.lua": `LOGIN = "Вход"\n${"-- padding\n".repeat(300)}`,
  "Interface/GlueXML/GlueParent.xml": '<Ui><Script file="GlueParent.lua"/><Frame name="GlueParent"/></Ui>',
  "Interface/GlueXML/GlueParent.lua": "function GlueParent_OnLoad() end",
  "Interface/FrameXML/FrameXML.toc": "Constants.lua\n",
  "Interface/FrameXML/Constants.lua": "PI = 3.14",
  "Interface/AddOns/Blizzard_TrainerUI/Blizzard_TrainerUI.toc": "Blizzard_TrainerUI.lua\n",
  "Interface/AddOns/Blizzard_TrainerUI/Blizzard_TrainerUI.lua": "TRAINER = 1",
  "Interface/AddOns/Blizzard_TalentUI/Blizzard_TalentUI.toc": "## Title: Talents\nBlizzard_TalentUI.lua\n",
  "Interface/AddOns/Blizzard_TalentUI/Blizzard_TalentUI.lua": "TALENT = 1",
};

async function withGateway(clientFilesDirectory, run) {
  const gateway = await startGateway({
    host: "127.0.0.1", port: 0, auth: { host: "127.0.0.1", port: 1 }, world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: [ORIGIN], datasetPollMs: 0, clientFilesDirectory,
  });
  try {
    return await run(`http://127.0.0.1:${gateway.port}`);
  } finally {
    await gateway.close();
  }
}

test("/client/interface-bundle answers a set's closure with the very texts /client/file serves, compressed and revalidated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-interface-bundle-"));
  try {
    await publish(directory, CORPUS);
    let tag;
    await withGateway(directory, async (base) => {
      const glue = await get(`${base}/client/interface-bundle?v=1&set=glue`, { origin: ORIGIN, "accept-encoding": "gzip" });
      assert.equal(glue.status, 200);
      assert.equal(glue.headers["content-encoding"], "gzip");
      assert.equal(glue.headers["cache-control"], "public, max-age=0, must-revalidate");
      assert.match(glue.headers.vary ?? "", /Origin/);
      tag = glue.headers.etag;
      assert.match(tag ?? "", /^W\/"ib1-[0-9a-f]{20}"$/);
      const body = JSON.parse(zlib.gunzipSync(glue.body).toString("utf8"));
      assert.equal(body.schema, "interface-bundle-1");
      assert.deepEqual(Object.keys(body.files).sort(), ["interface/gluexml/glueparent.lua", "interface/gluexml/glueparent.xml",
        "interface/gluexml/gluestrings.lua", "interface/gluexml/gluexml.toc"]);
      assert.deepEqual(body.absent, ["interface/sharedxml/absent.lua"]);
      for (const [path, text] of Object.entries(body.files)) {
        const single = await fetch(`${base}/client/file?path=${encodeURIComponent(path.replaceAll("/", "\\"))}`, { headers: { origin: ORIGIN } });
        assert.equal(await single.text(), text, `${path} is what /client/file serves`);
      }
      assert.equal((await fetch(`${base}/client/file?path=Interface\\SharedXML\\Absent.lua`, { headers: { origin: ORIGIN } })).status, 404,
        "absent means the route's 404");

      const again = await get(`${base}/client/interface-bundle?v=1&set=glue`, { origin: ORIGIN, "if-none-match": tag });
      assert.equal(again.status, 304);
      const br = await get(`${base}/client/interface-bundle?v=1&set=glue`, { origin: ORIGIN, "accept-encoding": "br" });
      assert.equal(br.headers["content-encoding"], "br");
      assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(br.body).toString("utf8")), body);

      const world = await (await fetch(`${base}/client/interface-bundle?v=1&set=world&addons=Blizzard_TrainerUI&tocs=Blizzard_TalentUI`,
        { headers: { origin: ORIGIN } })).json();
      assert.deepEqual(Object.keys(world.files).sort(), [
        "interface/addons/blizzard_talentui/blizzard_talentui.toc", "interface/addons/blizzard_trainerui/blizzard_trainerui.lua",
        "interface/addons/blizzard_trainerui/blizzard_trainerui.toc", "interface/framexml/constants.lua", "interface/framexml/framexml.toc"]);

      for (const query of ["v=2&set=glue", "v=1&set=other", "v=1", "v=1&set=world&addons=../x", `v=1&set=world&tocs=${"a,".repeat(200)}`]) {
        assert.equal((await fetch(`${base}/client/interface-bundle?${query}`, { headers: { origin: ORIGIN } })).status, 400, query);
      }
      assert.equal((await fetch(`${base}/client/interface-bundle?v=1&set=glue`, { headers: { origin: "http://evil.test" } })).status, 403);
    });
    // A restart over the same files: the same tag, so a player's copy is a 304.
    await withGateway(directory, async (base) => {
      assert.equal((await get(`${base}/client/interface-bundle?v=1&set=glue`, { origin: ORIGIN, "if-none-match": tag })).status, 304);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the browser reads the bundle once, settles its files and absences from it, and asks /client/file for the rest", async () => {
  resetInterfaceBundles();
  const origin = "http://gateway.test:8090";
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/client/interface-bundle") {
      return new Response(JSON.stringify({ schema: "interface-bundle-1", set: "world",
        files: { "interface/framexml/framexml.toc": "A.lua\n", "interface/framexml/a.lua": "a = 1", "interface/framexml/empty.xml": "" },
        absent: ["interface/framexml/missing.lua"] }), { status: 200 });
    }
    if (parsed.searchParams.get("path")?.toLowerCase() === "interface\\addons\\later\\later.toc") return new Response("Later.lua\n", { status: 200 });
    return new Response("", { status: 404 });
  };
  const provider = createBundledFileProvider({ gatewayOrigin: origin, fetch: fakeFetch, retryDelaysMs: [],
    bundle: { set: "world", addons: ["Blizzard_TrainerUI", "blizzard_trainerui", "bad name"], tocs: ["B"] } });
  assert.deepEqual(await Promise.all([provider.read("Interface\\FrameXML\\FrameXML.toc"), provider.read("interface/framexml/a.lua")]),
    ["A.lua\n", "a = 1"]);
  assert.equal(await provider.read("interface/framexml/empty.xml"), "", "a zero-byte file stays zero bytes");
  assert.equal(await provider.read("interface/framexml/missing.lua"), undefined, "an absence is settled by the bundle");
  assert.equal(await provider.read("interface/addons/later/later.toc"), "Later.lua\n", "anything else takes the old route");
  assert.equal(calls.filter((url) => url.includes("/client/interface-bundle")).length, 1, "one bundle request");
  assert.equal(calls.filter((url) => url.includes("/client/file")).length, 1, "and one file request, for the file it lacked");
  assert.equal(new URL(calls[0]).search, "?v=1&set=world&addons=blizzard_trainerui&tocs=b");
  assert.equal(interfaceBundleUrl(origin, { set: "glue", addons: ["x"] }), `${origin}/client/interface-bundle?v=1&set=glue`);

  // An older gateway (404 for the bundle): every read takes /client/file, exactly as before.
  resetInterfaceBundles();
  const old = [];
  const oldFetch = async (url) => {
    old.push(url);
    return new URL(url).pathname === "/client/file" ? new Response("text", { status: 200 }) : new Response("", { status: 404 });
  };
  const fallback = createBundledFileProvider({ gatewayOrigin: origin, fetch: oldFetch, retryDelaysMs: [], bundle: { set: "glue" } });
  assert.equal(await fallback.read("interface/gluexml/gluexml.toc"), "text");
  assert.equal(await fallback.read("interface/gluexml/a.lua"), "text");
  assert.equal(old.filter((url) => url.includes("interface-bundle")).length, 1, "the missing bundle is asked for once");
  assert.equal(parseInterfaceBundle({ schema: "interface-bundle-0", files: {}, absent: [] }), undefined);
  assert.equal(parseInterfaceBundle({ schema: "interface-bundle-1", files: { a: 1 }, absent: [] }), undefined);
});
