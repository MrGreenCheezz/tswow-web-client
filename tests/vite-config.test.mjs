import assert from "node:assert/strict";
import test from "node:test";
import { isLocalProvenanceRequest } from "../vite.config.mjs";

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
