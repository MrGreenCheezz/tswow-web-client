import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import {
  BROWSER_OPTIMIZED_DEPENDENCIES,
  DEV_SERVER_WATCH_IGNORES,
  isLocalProvenanceRequest,
  viteCacheDirectory,
} from "../vite.config.mjs";

test("development isolates dependency caches and ignores generator-scale trees", () => {
  assert.deepEqual(BROWSER_OPTIMIZED_DEPENDENCIES, ["three"]);
  for (const ignored of [
    "**/data/**",
    "**/CPPClientExample/**",
    "**/.runtime/**",
    "**/.vite-cache/**",
    "**/dist/**",
    "**/public/icons/**",
    "**/public/creature-icons/**",
    "**/public/portraits/**",
  ]) assert.equal(DEV_SERVER_WATCH_IGNORES.includes(ignored), true, ignored);

  assert.equal(viteCacheDirectory(5173, ["node", "vite"]), ".vite-cache/5173");
  assert.equal(viteCacheDirectory(5173, ["node", "vite", "--port", "4179"]), ".vite-cache/4179");
  assert.equal(viteCacheDirectory(5173, ["node", "vite", "--port=5180"]), ".vite-cache/5180");
  assert.equal(viteCacheDirectory(5173, ["node", "vite", "--port", "bad"]), ".vite-cache/5173");
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("explicit optimizer list covers every browser bare import", async () => {
  const dependencies = new Set();
  const record = (specifier) => {
    if (specifier.startsWith(".") || specifier.startsWith("/")) return;
    dependencies.add(specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0]);
  };
  for (const file of await sourceFiles(new URL("../src/browser/", import.meta.url))) {
    const source = await readFile(file, "utf8");
    const parsed = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
        && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        record(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        record(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  assert.deepEqual([...dependencies].sort(), [...BROWSER_OPTIMIZED_DEPENDENCIES].sort());
});

test("development never serves provenance sidecars through spelling variants", () => {
  for (const url of [
    "/icons/1.png.src",
    "/icons/1.png.SRC",
    "/icons/1.png%2Esrc",
    "/icons/1.png%2es%72c?cache=1",
    "http://localhost:5173/portraits/unit.SrC#ignored",
  ]) {
    assert.equal(isLocalProvenanceRequest(url), true, url);
  }

  for (const url of ["/icons/1.png", "/icons/source", "/icons/file.src.png", "/src/main.ts"]) {
    assert.equal(isLocalProvenanceRequest(url), false, url);
  }
});

test("malformed URL encoding fails closed", () => {
  for (const url of ["/icons/file%", "/icons/file%2", "/icons/file%GG", "/icons/%E0%A4%A"]) {
    assert.equal(isLocalProvenanceRequest(url), true, url);
  }
});
