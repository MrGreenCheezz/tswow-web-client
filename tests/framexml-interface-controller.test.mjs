// 4.17 stage 3: the stock interface is the only one, so its failure is said and a world that ends cancels it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { FrameXmlInterfaceController } from "../dist/code/browser/framexml/FrameXmlInterfaceController.js";
import { frameXmlViewport } from "../dist/code/browser/framexml/FrameXmlWorldPolicy.js";
import { defaultSettings } from "../dist/code/browser/ui/SettingsModel.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function controller(load) {
  const reports = [];
  const failures = [];
  const instance = new FrameXmlInterfaceController(load,
    (message) => reports.push(message), (message) => failures.push(message));
  return { instance, reports, failures };
}

test("original Lua and CSS share the scaled viewport at every interface size", () => {
  for (const percent of [75, 100, 125]) {
    const logical = frameXmlViewport(1366, 768, percent);
    assert.ok(Math.abs(logical.width * logical.scale - 1366) <= logical.scale / 2);
    assert.ok(Math.abs(logical.height * logical.scale - 768) <= logical.scale / 2);
  }
});

test("a mount that succeeds is reported, once however often it is started", async () => {
  let mounts = 0;
  const { instance, reports, failures } = controller(async () => ({
    mount: async () => { mounts += 1; return { ok: true, message: "готово" }; },
    unmount() {},
  }));
  await instance.start();
  await instance.start();
  assert.equal(mounts, 1);
  assert.deepEqual(reports, ["Загрузка интерфейса…", "готово"]);
  assert.deepEqual(failures, []);
});

test("a mount that answers no is undone and said once, in its own words", async () => {
  let unmounts = 0;
  const { instance, failures } = controller(async () => ({
    mount: async () => ({ ok: false, message: "нет FrameXML.toc" }),
    unmount() { unmounts += 1; },
  }));
  await instance.start();
  assert.equal(unmounts, 1);
  assert.deepEqual(failures, ["нет FrameXML.toc"]);
});

test("code that will not load and a mount that throws are failures too", async () => {
  const noCode = controller(async () => { throw new Error("network unavailable"); });
  await noCode.instance.start();
  assert.deepEqual(noCode.failures, ["network unavailable"]);

  let unmounts = 0;
  const throws = controller(async () => ({
    mount: async () => { throw new Error("VM"); },
    unmount() { unmounts += 1; },
  }));
  await throws.instance.start();
  assert.equal(unmounts, 1);
  assert.deepEqual(throws.failures, ["VM"]);
});

test("a world that ends during the import never mounts and says nothing", async () => {
  const loading = deferred();
  let mounts = 0;
  const { instance, reports, failures } = controller(() => loading.promise);
  const started = instance.start();
  instance.dispose();
  loading.resolve({ mount: async () => { mounts += 1; return { ok: true, message: "" }; }, unmount() {} });
  await started;
  assert.equal(mounts, 0);
  assert.deepEqual(reports, ["Загрузка интерфейса…"]);
  assert.deepEqual(failures, []);
});

test("a world that ends during the mount takes it down and hears no failure", async () => {
  const mounting = deferred();
  let unmounts = 0;
  const { instance, failures } = controller(async () => ({
    mount: () => mounting.promise,
    unmount() { unmounts += 1; },
  }));
  const started = instance.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  instance.dispose();
  assert.equal(unmounts, 1);
  mounting.resolve({ ok: false, message: "cancelled" });
  await started;
  assert.deepEqual(failures, [], "a cancelled mount is not a broken interface");
});

test("a late failure after the world ended is not said", async () => {
  const loading = deferred();
  const { instance, failures } = controller(() => loading.promise);
  const started = instance.start();
  instance.dispose();
  loading.reject(new Error("network unavailable"));
  await started;
  assert.deepEqual(failures, []);
});

test("there is no switch left, and world entry covers the world when the interface fails", async () => {
  assert.equal("originalFrameXml" in defaultSettings(), false);
  const entry = await readFile(new URL("../src/browser/app/EnterWorld.ts", import.meta.url), "utf8");
  assert.match(entry, /new FrameXmlInterfaceController\(/);
  assert.match(entry, /showGlueLoadFailure\(\{\s*container: element\("world-viewport"\), heading: "Интерфейс не загрузился"/);
  assert.match(entry, /entryLifecycle\.track\(\(\) => stockInterface\.dispose\(\)\);/);
  assert.match(entry, /void stockInterface\.start\(\);/);
  assert.doesNotMatch(entry, /addonsOnly|frameXmlFlagEnabled|originalFrameXml/);
});
