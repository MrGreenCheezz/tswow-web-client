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

async function loadRuntime() {
  const { clientArchives } = await import("../tools/mpq.mjs");
  const chain = await clientArchives(clientDirectory);
  const { GlueRuntime } = await import("../dist/code/browser/glue/GlueRuntime.js");
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        const data = await chain.read(path.replaceAll("/", "\\"));
        return data ? new TextDecoder("utf-8").decode(data) : undefined;
      },
    },
    lua: { onError: (message) => { throw new Error(`unhandled glue Lua error: ${message}`); } },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
  });
  await runtime.load();
  return { runtime, chain };
}

test("the login screen omits Website, Options and Quit while retaining account controls", withClient, async () => {
  const { runtime, chain } = await loadRuntime();
  try {
    for (const name of ["AccountLoginCommunityButton", "OptionsButton", "AccountLoginExitButton"]) {
      const frame = runtime.bridge.getFrame(name);
      assert.ok(frame, `${name} is still an authoritative FrameXML control`);
      assert.equal(runtime.bridge.isVisible(frame), false, `${name} must not be visible on login`);
    }

    for (const name of [
      "AccountLoginLoginButton",
      "AccountLoginAccountEdit",
      "AccountLoginPasswordEdit",
      "AccountLoginSaveAccountName",
    ]) {
      const frame = runtime.bridge.getFrame(name);
      assert.ok(frame, `${name} must remain in the login form`);
      assert.equal(runtime.bridge.isVisible(frame), false,
        `${name} starts under the hidden AccountLogin screen before transition`);
    }

    assert.equal(runtime.api.setGlueScreen("login"), true);
    for (const name of [
      "AccountLoginLoginButton",
      "AccountLoginAccountEdit",
      "AccountLoginPasswordEdit",
      "AccountLoginSaveAccountName",
    ]) {
      assert.equal(runtime.bridge.isVisible(runtime.bridge.getFrame(name)), true,
        `${name} remains visible after showing login`);
    }
    for (const name of ["AccountLoginCommunityButton", "OptionsButton", "AccountLoginExitButton"]) {
      assert.equal(runtime.bridge.isVisible(runtime.bridge.getFrame(name)), false,
        `${name} remains omitted after showing login`);
    }

    assert.equal(runtime.api.setGlueScreen("charselect"), true);
    assert.equal(runtime.bridge.isVisible(runtime.bridge.getFrame("CharacterSelect")), true,
      "the policy must not hide the character-select screen");
  } finally {
    runtime.close();
    chain.close();
  }
});
