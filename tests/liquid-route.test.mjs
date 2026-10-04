import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startGateway } from "../dist/code/gateway/Gateway.js";

test("liquid metadata and strips conditionally revalidate their path-stable URLs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webclient-liquid-route-"));
  await writeFile(join(directory, "ocean.json"), JSON.stringify({ frames: 30 }));
  await writeFile(join(directory, "ocean.png"), Buffer.from("PNG-ocean"));
  const gateway = await startGateway({
    host: "127.0.0.1",
    port: 0,
    auth: { host: "127.0.0.1", port: 1 },
    world: { host: "127.0.0.1", port: 1 },
    allowedOrigins: ["http://localhost:5173"],
    liquidDirectory: directory,
  });
  const headers = { origin: "http://localhost:5173" };
  const metadataUrl = `http://127.0.0.1:${gateway.port}/liquid/ocean`;
  const imageUrl = `${metadataUrl}.png`;
  try {
    const metadata = await fetch(metadataUrl, { headers });
    const image = await fetch(imageUrl, { headers });
    assert.equal(metadata.status, 200);
    assert.equal(image.status, 200);
    assert.equal(metadata.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(image.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    const metadataTag = metadata.headers.get("etag");
    const imageTag = image.headers.get("etag");
    assert.match(metadataTag ?? "", /^"e1-[0-9a-f]+-[0-9a-f]+(-[0-9a-f]+)?"$/);
    assert.match(imageTag ?? "", /^"e1-[0-9a-f]+-[0-9a-f]+(-[0-9a-f]+)?"$/);
    await metadata.arrayBuffer();
    await image.arrayBuffer();

    assert.equal((await fetch(metadataUrl, {
      headers: { ...headers, "if-none-match": metadataTag },
    })).status, 304);
    assert.equal((await fetch(imageUrl, {
      headers: { ...headers, "if-none-match": imageTag },
    })).status, 304);

    await writeFile(join(directory, "ocean.json"), JSON.stringify({ frames: 31 }));
    const changed = await fetch(metadataUrl, {
      headers: { ...headers, "if-none-match": metadataTag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), metadataTag);
    assert.deepEqual(await changed.json(), { frames: 31 });
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true, force: true });
  }
});
