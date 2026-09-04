import assert from "node:assert/strict";
import test from "node:test";

const { createFrameXmlMerchantMetadataCoordinator } = await import(
  "../dist/code/browser/framexml/FrameXmlMerchantMetadata.js",
);

function vendor() {
  return {
    guid: 0x600n,
    items: [
      { slot: 1, itemId: 100, displayId: 1, leftInStock: 3, price: 25, maxDurability: 0, buyCount: 1, extendedCost: 0 },
      { slot: 4, itemId: 200, displayId: 2, leftInStock: 3, price: 25, maxDurability: 0, buyCount: 1, extendedCost: 7 },
    ],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("merchant metadata prefetch repaints once, coalesces wire/http, and ignores unsupported rows", async () => {
  let currentVendor = vendor();
  const cache = new Map();
  const loads = [];
  const pending = [];
  let coordinator;
  const updates = [];
  const metadata = {
    get(entry) { return cache.get(entry); },
    load(entries) {
      loads.push([...entries]);
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
  };
  coordinator = createFrameXmlMerchantMetadataCoordinator({
    vendor: () => currentVendor,
    itemMetadata: () => metadata,
    itemTemplate: () => undefined,
    onMetadataLoaded() {
      const result = coordinator.refresh("metadata");
      if (result.changed) updates.push(result.signature);
    },
  });

  const initial = coordinator.refresh("vendor");
  assert.equal(initial.changed, true);
  assert.deepEqual(loads, [[100]], "only the supported money row is prefetched");
  cache.set(100, { entry: 100, name: "Зелье", displayId: 11, quality: 1, inventoryType: 0, stackable: 20, iconId: 22 });
  pending.shift().resolve(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 1, "HTTP-only completion causes one relevant repaint");

  // The wire callback may arrive after the HTTP promise. The signature is already current.
  const wire = coordinator.refresh("metadata");
  assert.equal(wire.changed, false, "wire+HTTP completion does not duplicate UPDATE");
  cache.set(200, { entry: 200, name: "Неподдерживаемый предмет", displayId: 12, quality: 1, inventoryType: 0, stackable: 1, iconId: 23 });
  assert.equal(coordinator.refresh("metadata").changed, false,
    "metadata for an unsupported extended-cost row is invisible to this slice");
  cache.set(999, { entry: 999, name: "Чужой предмет", displayId: 13, quality: 1, inventoryType: 0, stackable: 1, iconId: 24 });
  assert.equal(coordinator.refresh("metadata").changed, false,
    "unrelated metadata does not repaint the merchant");

  currentVendor = {
    ...currentVendor,
    items: [...currentVendor.items, {
      slot: 8, itemId: 300, displayId: 3, leftInStock: 1, price: 30, maxDurability: 0, buyCount: 1, extendedCost: 0,
    }],
  };
  coordinator.refresh("vendor");
  assert.deepEqual(loads, [[100], [300]], "a new supported row starts one new prefetch");
  pending.shift().reject(new Error("gateway down"));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(updates.length, 1, "failed prefetch does not recurse into merchant updates");

  // Once the failure backoff expires in the real cache, a later vendor refresh may retry; the
  // coordinator must not permanently latch the failed request key.
  coordinator.refresh("vendor");
  assert.deepEqual(loads, [[100], [300], [300]], "failed request is released for a later retry");
  pending.shift().reject(new Error("gateway still down"));
});

test("merchant observes metadata completed by another pending loader on the next refresh", () => {
  const currentVendor = vendor();
  const cache = new Map();
  let loadCalls = 0;
  let ownerUpdates = 0;
  const metadata = {
    get(entry) { return cache.get(entry); },
    // A shared AssetWarmup request owns the HTTP work.  This client receives no completion
    // callback, so its bounded metadata refresh must discover the cache entry itself.
    load() {
      loadCalls += 1;
      return Promise.resolve(false);
    },
  };
  const coordinator = createFrameXmlMerchantMetadataCoordinator({
    vendor: () => currentVendor,
    itemMetadata: () => metadata,
    itemTemplate: () => undefined,
    onMetadataLoaded() { ownerUpdates += 1; },
  });

  const initial = coordinator.refresh("vendor");
  assert.equal(initial.changed, true);
  assert.equal(loadCalls, 1);
  cache.set(100, { entry: 100, name: "Зелье из общего запроса", displayId: 11, quality: 1,
    inventoryType: 0, stackable: 20, iconId: 22 });
  const arrived = coordinator.refresh("metadata");
  assert.equal(arrived.changed, true, "cache arrival is visible without a client-owned callback");
  assert.equal(ownerUpdates, 0, "shared-loader completion does not fabricate a callback");
});
