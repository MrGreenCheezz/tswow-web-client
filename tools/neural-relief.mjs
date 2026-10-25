#!/usr/bin/env node
// 25.10 (7.47, neural maps): builds the neural height maps (tools/neural-relief.py) into NEURAL_RELIEF_DIR
// (default .runtime/neural-relief), which the gateway serves (gateway/NeuralReliefRoute.ts):
//
// - terrain/<layer id>.bin — every ground layer `/terrain-layer` has published (TERRAIN_LAYER_DIR, default
//   data/terrain-layers; the `_s` masks beside them skipped), as `/terrain-relief/<id>.bin`; made again when its
//   layer PNG is newer;
// - content/<sha1>.bin — every building texture `/visual/texture` has published (VISUAL_MODEL_DIR, default
//   data/visual-models) and every scenery texture `/texture` has (TEXTURE_DIR, default data/textures: paths under
//   world\ and dungeons\), by the SHA-1 of the PNG served, as `/neural-relief/<sha1>.bin`. One texture published
//   by many buildings is one map; a map that exists is never made again (its name is its content).
//
//   node tools/neural-relief.mjs [--only terrain|content] [--limit N] [--out <dir>]
//
// Needs `.runtime/tools/deepbump/` (owner's approval 25.10): `src/deepbump256.onnx` (DeepBump v8, GPL-3, not in
// this repository) and `venv/` (Python 3.10 with onnxruntime, numpy, pillow). CPU only, at the lowest priority (the
// owner may be playing on this machine). 25.10: 543 ground layers took ≈ 70 min (3–8 s a layer, another game
// running).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./env.mjs";
import { repositoryRoot } from "./paths.mjs";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const root = repositoryRoot;
const toolDirectory = join(root, ".runtime", "tools", "deepbump");
const model = join(toolDirectory, "src", "deepbump256.onnx");
const python = join(toolDirectory, "venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const layers = resolve(root, process.env.TERRAIN_LAYER_DIR ?? "data/terrain-layers");
const visualModels = resolve(root, process.env.VISUAL_MODEL_DIR ?? "data/visual-models");
const textures = resolve(root, process.env.TEXTURE_DIR ?? "data/textures");
const out = resolve(root, option("--out") ?? process.env.NEURAL_RELIEF_DIR ?? ".runtime/neural-relief");
const only = option("--only");
const limit = Number(option("--limit") ?? Infinity);

for (const [what, path] of [["model", model], ["Python environment", python]]) {
  if (!existsSync(path)) {
    console.error(`neural relief: no ${what} at ${path}`);
    process.exit(1);
  }
}

const list = (directory) => (existsSync(directory) ? readdirSync(directory) : []);
const stampPaths = (file) => {
  try {
    const stamp = JSON.parse(readFileSync(file, "utf8"));
    return (stamp.sources ?? []).map((source) => String(source?.path ?? "").replaceAll("/", "\\").toLowerCase());
  } catch {
    return [];
  }
};
const newer = (target, source) => existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs;

const jobs = [];
if (only !== "content") {
  for (const name of list(layers)) {
    if (!/^[0-9a-f]{40}\.png$/.test(name)) continue;
    const png = join(layers, name);
    const paths = stampPaths(`${png}.src`);
    if (paths.length === 0 || paths.some((path) => path.endsWith("_s.blp"))) continue;
    const target = join(out, "terrain", name.replace(/\.png$/, ".bin"));
    if (!newer(target, png)) jobs.push({ png, out: target, wrap: true });
  }
}
if (only !== "terrain") {
  /** sha1 → job; a building's copy (repeating) wins over a doodad's (an atlas) for the same content. */
  const content = new Map();
  const add = (png, wrap) => {
    const digest = createHash("sha1").update(readFileSync(png)).digest("hex");
    const target = join(out, "content", `${digest}.bin`);
    if (existsSync(target)) return;
    const known = content.get(digest);
    if (!known || (wrap && !known.wrap)) content.set(digest, { png, out: target, wrap });
  };
  for (const name of list(visualModels)) if (/^[0-9a-f]{40}-\d{1,3}\.png$/.test(name)) add(join(visualModels, name), true);
  for (const name of list(textures)) {
    if (!/^[0-9a-f]{40}\.png$/.test(name)) continue;
    const [path] = stampPaths(join(textures, `${name}.src`));
    if (path && /^(?:world|dungeons)\\/.test(path) && !/^world\\(?:minimaps|maps)\\/.test(path)) add(join(textures, name), false);
  }
  jobs.push(...content.values());
}
const chosen = jobs.slice(0, limit);
console.log(`neural relief: ${chosen.length} to make${jobs.length > chosen.length ? ` (of ${jobs.length})` : ""}`);
if (chosen.length === 0) process.exit(0);
const jobsFile = join(tmpdir(), `neural-relief-${process.pid}.json`);
writeFileSync(jobsFile, JSON.stringify(chosen));

// `-I`: the script's own directory is not put on the module path, and no user site-packages. The network takes
// every core, so it runs at the lowest priority.
const child = spawn(python, ["-I", join(root, "tools", "neural-relief.py"), model, jobsFile], { stdio: "inherit" });
try {
  setPriority(child.pid, constants.priority.PRIORITY_LOW);
} catch {
  // Not allowed here: it runs at the normal priority.
}
child.on("exit", (code) => process.exit(code ?? 1));
