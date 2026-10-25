#!/usr/bin/env node
// 25.10 (7.47, neural maps): builds the ground textures' neural height maps (tools/neural-relief.py) into
// NEURAL_RELIEF_DIR (default .runtime/neural-relief), which the gateway serves as `/terrain-relief/<id>.bin`.
//
//   node tools/neural-relief.mjs [--layers <dir>] [--out <dir>]
//
// Needs `.runtime/tools/deepbump/` (owner's approval 25.10): `src/deepbump256.onnx` (DeepBump v8, GPL-3, not in
// this repository) and `venv/` (Python 3.10 with onnxruntime, numpy, pillow). CPU only. 25.10: 543 layers took ≈ 70 min (3–8 s a layer at the lowest priority, another game running).
// The layers are whatever `/terrain-layer` has published so far (TERRAIN_LAYER_DIR, default data/terrain-layers);
// a layer not yet published gets its map on the next run, and until then the browser derives it from brightness.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, setPriority } from "node:os";
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
const layers = resolve(root, option("--layers") ?? process.env.TERRAIN_LAYER_DIR ?? "data/terrain-layers");
const out = resolve(root, option("--out") ?? process.env.NEURAL_RELIEF_DIR ?? ".runtime/neural-relief");

for (const [what, path] of [["model", model], ["Python environment", python], ["layers", layers]]) {
  if (!existsSync(path)) {
    console.error(`neural relief: no ${what} at ${path}`);
    process.exit(1);
  }
}

// `-I`: the script's own directory is not put on the module path, and no user site-packages. The network takes
// every core, so it runs at the lowest priority: the owner may be playing on this machine.
const child = spawn(python, ["-I", join(root, "tools", "neural-relief.py"), model, layers, join(out, "terrain")], {
  stdio: "inherit",
});
try {
  setPriority(child.pid, constants.priority.PRIORITY_LOW);
} catch {
  // Not allowed here: it runs at the normal priority.
}
child.on("exit", (code) => process.exit(code ?? 1));
