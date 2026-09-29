import assert from "node:assert/strict";
import test from "node:test";

let clientDirectory;
try {
  const paths = await import("../tools/paths.mjs");
  clientDirectory = paths.clientDirectory();
} catch {
  clientDirectory = undefined;
}
const withClient = { skip: clientDirectory ? false : "no 3.3.5a client on this machine" };

test("auth rejection remeasures the stock status dialog after it becomes visible", withClient, async () => {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const chain = await clientArchives(clientDirectory);
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder().decode(data) : undefined;
      },
    },
    api: {
      locale: "ruRU",
      screenWidth: 1024,
      screenHeight: 768,
      authUrl: "ws://fixture.invalid/auth",
      connect: async () => ({
        send() {},
        async readExactly(length) {
          assert.equal(length, 3);
          return Uint8Array.of(0, 0, 4);
        },
        close() {},
      }),
    },
  });
  try {
    await runtime.load();
    const dialog = runtime.bridge.getFrame("GlueDialog");
    const background = runtime.bridge.getFrame("GlueDialogBackground");
    const label = runtime.bridge.getFrame("GlueDialogText");
    assert.ok(dialog && background && label);
    // The host cannot measure a hidden FontString. Once shown, its actual height is available.
    runtime.bridge.setMeasure((frame) => frame === label
      ? { width: 450, height: dialog.visible ? 18 : 0 }
      : undefined);
    await runtime.api.login("NONEXISTENT", "irrelevant");
    assert.equal(dialog.visible, true);
    assert.equal(label.text, runtime.vm.globalString("AUTH_UNKNOWN_ACCOUNT"));
    assert.equal(Number(background.attributes.height), 114,
      "stock UPDATE_STATUS_DIALOG sizes its box from the visible text and button");
  } finally {
    runtime.close();
    chain.close();
  }
});
