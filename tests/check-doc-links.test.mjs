import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// 13.02 (L14): the documents' relative links resolve; `.runtime/` links are local artefacts, listed apart.
const { checkDocLinks, docLinkFiles, formatDocLinkReport, markdownLinks } = await import("../tools/check-doc-links.mjs");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "check-doc-links.mjs");

function fixture(files) {
  const folder = mkdtempSync(join(tmpdir(), "doc-links-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  return folder;
}

const SYNTHETIC = {
  "docs/a.md": [
    "# A",                                             // 1
    "[ok](b.md) and [missing](missing.md)",           // 2
    "[artefact](../.runtime/x/report.md)",            // 3
    "[web](https://example.com/nothing) [mail](mailto:x@example.com)", // 4
    "```",                                             // 5
    "[fenced](nope.md)",                               // 6
    "```",                                             // 7
    "`[inline](nope2.md)` and [`code text`](b.md)",   // 8
    "[anchor ok](b.md#title) [anchor bad](b.md#nope) [self](#local-heading)", // 9
    "[angle](<b.md>) ![img](img/missing.png)",         // 10
    "## Local heading",                                // 11
    "",
  ].join("\n"),
  "docs/b.md": "# Title\n",
  "docs/sub/c.md": "[up](../a.md) [root](../../README.md)\r\n[gone up](../../nowhere.md)\r\n",
  "README.md": "[docs](docs/a.md) [gone](docs/gone.md)\n",
  "AGENTS.md": "~~~\n[tilde fenced](nope.md)\n~~~\n",
  // Not one of the checked documents: never reported.
  "research/x.md": "[bad](zzz.md)\n",
  "web/notes.md": "[bad](zzz.md)\n",
};

test("13.02: the real documents have no broken relative link", () => {
  const result = checkDocLinks({ root });
  assert.deepEqual(result.broken, [], formatDocLinkReport(result));
  for (const file of ["docs/WORK_PLAN.ru.md", "README.md", "AGENTS.md", "bench/README.md"]) {
    assert.ok(result.files.includes(file), `${file} is checked`);
  }
  assert.ok(result.links > 0);
  assert.ok(result.localArtifacts.every((link) => /(^|\/)\.runtime\//.test(link.target)), "only .runtime links are artefacts");
});

test("13.02: a synthetic tree — broken links found, code and schemes skipped, .runtime listed apart", () => {
  const folder = fixture(SYNTHETIC);
  try {
    assert.deepEqual(docLinkFiles(folder).map((file) => file.slice(folder.length + 1).replaceAll("\\", "/")),
      ["AGENTS.md", "README.md", "docs/a.md", "docs/b.md", "docs/sub/c.md"]);
    const result = checkDocLinks({ root: folder });
    assert.deepEqual(result.broken, [
      { file: "README.md", line: 1, target: "docs/gone.md" },
      { file: "docs/a.md", line: 2, target: "missing.md" },
      { file: "docs/a.md", line: 10, target: "img/missing.png" },
      { file: "docs/sub/c.md", line: 2, target: "../../nowhere.md" },
    ]);
    assert.deepEqual(result.localArtifacts, [
      { file: "docs/a.md", line: 3, target: "../.runtime/x/report.md", exists: false },
    ]);
    // a.md: ok, missing, artefact, code text, anchor ok/bad, self, angle, img = 9; README 2; c.md 3.
    assert.equal(result.links, 14);
    assert.deepEqual(result.brokenAnchors, [], "anchors are checked only on request");
    const withAnchors = checkDocLinks({ root: folder, anchors: true });
    assert.deepEqual(withAnchors.brokenAnchors, [{ file: "docs/a.md", line: 9, target: "b.md#nope" }]);
    assert.match(formatDocLinkReport(result), /broken=4 localArtifacts=1 \(absent here: 1\)/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("13.02: link extraction keeps line numbers and unwraps <targets>", () => {
  assert.deepEqual(markdownLinks("x\n```\n[a](b)\n```\n[c](<d e.md>) `[f](g)` [h](i \"title\")"), [
    { line: 5, target: "d e.md" },
    { line: 5, target: "i" },
  ]);
});

test("13.02: the command exits 1 on a broken link and 0 on a clean tree", () => {
  const broken = fixture(SYNTHETIC);
  const clean = fixture({ "docs/a.md": "[b](b.md) [artefact](../.runtime/gone.md)\n", "docs/b.md": "# B\n" });
  try {
    const run = (folder, ...args) => spawnSync(process.execPath, [tool, "--root", folder, ...args], { encoding: "utf8" });
    const bad = run(broken);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /docs\/a\.md:2: missing\.md/);
    const good = run(clean);
    assert.equal(good.status, 0, good.stderr + good.stdout);
    assert.match(good.stdout, /broken=0 localArtifacts=1 \(absent here: 1\)/);
    assert.match(good.stdout, /\[absent on this machine\]/);
  } finally {
    rmSync(broken, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});
