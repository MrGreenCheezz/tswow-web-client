import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLoweredPrivateMembers, LOWERED_MEMBER_NEEDLES } from "../tools/check-dist-target.mjs";

const SCRIPT = "tools/check-dist-target.mjs";

// esbuild's class-member helpers as `vite build` minifies them (from dist/web/assets of 29.09).
// The access check prepends "Cannot " at run time, so only the tails below are literal.
const ACCESS_CHECK = 'var B1=(s,e,t)=>e.has(s)||KL("Cannot "+t);';
const PRIVATE_GET = 'var n=(s,e,t)=>(B1(s,e,"read from private field"),t?t.call(s):e.get(s));';
const PRIVATE_SET = 'var p=(s,e,t,i)=>(B1(s,e,"write to private field"),i?i.call(s,t):e.set(s,t),t);';
const PRIVATE_ADD = 'var m=(s,e,t)=>e.has(s)?KL("Cannot add the same private member more than once"):e instanceof WeakSet?e.add(s):e.set(s,t);';
const PRIVATE_METHOD = 'var w=(s,e,t)=>(B1(s,e,"access private method"),t);';
const PUBLIC_FIELD = 'var mi=(et,tt,ut)=>tt in et?xi(et,tt,{enumerable:!0,configurable:!0,writable:!0,value:ut}):et[tt]=ut;'
  + 'var lt=(et,tt,ut)=>mi(et,typeof tt!="symbol"?tt+"":tt,ut);';
// The same helper as esbuild prints it unminified (the benchmark bundle).
const PUBLIC_FIELD_READABLE = 'var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "dist-target-check-"));
  const web = join(directory, "web"), clean = join(directory, "clean");
  await mkdir(join(web, "assets", "nested"), { recursive: true });
  await mkdir(join(clean, "assets"), { recursive: true });
  const native = 'class A{#x=1;static #n=0;get x(){return this.#x++}}throw new Error("Cannot read from nothing");';
  await writeFile(join(web, "assets", "main-abc.js"), native);
  await writeFile(join(web, "assets", "get-only-abc.js"), ACCESS_CHECK + PRIVATE_GET + native);
  await writeFile(join(web, "assets", "nested", "Pose.worker-abc.js"),
    ACCESS_CHECK + PRIVATE_GET + PRIVATE_SET + PRIVATE_ADD + PRIVATE_METHOD + PUBLIC_FIELD);
  await writeFile(join(web, "assets", "public-only-abc.js"), PUBLIC_FIELD);
  await writeFile(join(web, "assets", "readable.js"), PUBLIC_FIELD_READABLE);
  // Not JavaScript: a source map or a stylesheet may quote anything.
  await writeFile(join(web, "assets", "main-abc.js.map"), JSON.stringify({ sourcesContent: [PRIVATE_GET] }));
  await writeFile(join(web, "assets", "style-abc.css"), `/* ${PRIVATE_GET} */`);
  await writeFile(join(clean, "assets", "main-def.js"), native);
  return { directory, web, clean };
}

function cli(...dirs) {
  return spawnSync(process.execPath, [SCRIPT, ...dirs], { encoding: "utf8" });
}

test("finds esbuild's lowered class-member helpers in every .js file under the directories", async () => {
  const { directory, web, clean } = await fixture();
  try {
    assert.deepEqual([...LOWERED_MEMBER_NEEDLES], ["read from private field", "write to private field",
      "Cannot add the same private member more than once", "access private method"]);
    const found = await findLoweredPrivateMembers(web, clean);
    assert.deepEqual(found.map((entry) => [entry.file.slice(web.length + 1).replaceAll("\\", "/"), entry.count]), [
      ["assets/get-only-abc.js", 1],
      ["assets/nested/Pose.worker-abc.js", 5],
      ["assets/public-only-abc.js", 1],
      ["assets/readable.js", 1],
    ]);
    const worker = found.find((entry) => entry.file.endsWith("Pose.worker-abc.js"));
    assert.deepEqual(worker.matches, { "read from private field": 1, "write to private field": 1,
      "Cannot add the same private member more than once": 1, "access private method": 1, "public class field helper": 1 });
    assert.deepEqual(found.find((entry) => entry.file.endsWith("get-only-abc.js")).matches, { "read from private field": 1 });
    assert.deepEqual(await findLoweredPrivateMembers(clean), [], "native #private members and fields are not lowering");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the command exits 1 with the files it found, 0 for a clean build and 2 for a missing directory", async () => {
  const { directory, web, clean } = await fixture();
  try {
    const dirty = cli(web);
    assert.equal(dirty.status, 1, dirty.stderr);
    assert.match(dirty.stdout, /get-only-abc\.js: 1/);
    assert.match(dirty.stdout, /Pose\.worker-abc\.js: 5/);
    assert.match(dirty.stdout, /4 of 5 JS files/);
    const ok = cli(clean);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /0 of 1 JS files/);
    // A mistyped or missing build directory must not pass the gate as "nothing found".
    const missing = cli(join(directory, "does-not-exist"));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /does-not-exist/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
