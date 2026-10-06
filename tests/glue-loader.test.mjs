import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime, glueViewportMetrics } from "../dist/code/browser/glue/GlueRuntime.js";
import {
  createFixtureProvider,
  createHttpFileProvider,
  parseGlueToc,
  resolveGluePath,
} from "../dist/code/browser/glue/GlueLoader.js";
import { GLUE_BUILD_INFO } from "../dist/code/browser/glue/GlueApi.js";
import {
  GlueServerUnavailableError, probeGlueServer, retrying,
} from "../dist/code/browser/glue/GlueRetry.js";
import { PatchChainChangedError } from "../dist/code/browser/PatchChainChanged.js";

// A fixture shaped like the real corpus rather than like a unit test: a TOC
// whose second entry does not exist, a font chain, a GlueParent every screen
// names by `parent=`, a virtual template with `$parent` children, sibling
// anchors, a GlobalString `text=`, and handlers that read the legacy `this`
// and `arg1` globals.
const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": [
    "## Interface: 30300",
    "GlueStrings.lua",
    "..\\SharedXML\\SharedGlueStrings.lua",
    "GlueFonts.xml",
    "##CameraSelect.xml",
    "GlueParent.xml",
    "TestScreen.xml",
  ].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    TEST_LOGIN = "Войти";
    GlueScreenInfo = {};
    GlueScreenInfo["login"] = "TestScreen";
  `,
  "Interface/GlueXML/GlueFonts.xml": `<Ui>
    <Font name="TestFontBase" font="Fonts\\FRIZQT__.TTF" outline="NORMAL" virtual="true">
      <FontHeight><AbsValue val="14"/></FontHeight>
      <Color r="1" g="0.82" b="0"/>
    </Font>
    <Font name="TestFontHighlight" inherits="TestFontBase" virtual="true">
      <Color r="1" g="1" b="1"/>
    </Font>
  </Ui>`,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Script file="GlueParent.lua"/>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts><OnEvent>GlueParent_OnEvent(event, ...);</OnEvent></Scripts>
    </Frame>
  </Ui>`,
  "Interface/GlueXML/GlueParent.lua": `
    LAST_EVENT = nil;
    function GlueParent_OnEvent(event, first)
      LAST_EVENT = event .. ":" .. tostring(first);
    end
    function SetGlueScreen(name)
      for key, value in pairs(GlueScreenInfo) do
        local frame = _G[value];
        if ( frame ) then
          if ( key == name ) then frame:Show(); else frame:Hide(); end
        end
      end
      SetCurrentScreen(name);
    end
  `,
  "Interface/GlueXML/TestScreen.xml": `<Ui>
    <Script file="TestScreen.lua"/>
    <Frame name="TestPanelTemplate" virtual="true">
      <Size><AbsDimension x="200" y="80"/></Size>
      <Layers>
        <Layer level="BACKGROUND">
          <Texture name="$parentBg" file="Interface\\Glues\\Common\\Glues-Background" alphaMode="ADD">
            <TexCoords left="0" right="0.5" top="0" bottom="0.25"/>
            <Color r="1" g="0" b="0" a="0.5"/>
          </Texture>
        </Layer>
        <Layer level="OVERLAY">
          <FontString name="$parentTitle" inherits="TestFontHighlight" text="TEST_LOGIN" justifyH="LEFT"/>
        </Layer>
      </Layers>
      <Backdrop bgFile="Interface\\DialogFrame\\UI-DialogBox-Background" edgeFile="Interface\\DialogFrame\\UI-DialogBox-Border" tile="true">
        <EdgeSize><AbsValue val="32"/></EdgeSize>
        <TileSize><AbsValue val="16"/></TileSize>
        <BackgroundInsets><AbsInset left="11" right="12" top="12" bottom="11"/></BackgroundInsets>
      </Backdrop>
    </Frame>
    <Frame name="TestScreen" parent="GlueParent" setAllPoints="true" hidden="true">
      <Frames>
        <Frame name="TestPanel" inherits="TestPanelTemplate">
          <Anchors><Anchor point="CENTER"><Offset><AbsDimension x="10" y="-20"/></Offset></Anchor></Anchors>
        </Frame>
        <Button name="TestLoginButton" text="TEST_LOGIN">
          <Size x="128" y="24"/>
          <Anchors>
            <Anchor point="TOPLEFT" relativeto="TestPanel" relativePoint="BOTTOMLEFT">
              <Offset><AbsDimension x="4" y="-6"/></Offset>
            </Anchor>
          </Anchors>
          <NormalTexture name="$parentNormal" file="Interface\\Buttons\\UI-Panel-Button-Up"/>
          <ButtonText name="$parentText" inherits="TestFontBase"/>
          <Scripts>
            <OnClick>TestScreen_OnClick(self, button);</OnClick>
            <OnKeyDown>TestScreen_OnKeyDown();</OnKeyDown>
          </Scripts>
        </Button>
        <EditBox name="TestAccountEdit" letters="16" historyLines="4">
          <Size x="140" y="20"/>
          <FontString inherits="TestFontBase"/>
          <Scripts><OnEditFocusGained>this:HighlightText();</OnEditFocusGained></Scripts>
        </EditBox>
        <ModelFFX name="TestBackdropModel" file="Interface\\Glues\\Models\\UI_Human\\UI_Human.mdx" fogNear="0" fogFar="1200" glow="0.15"/>
      </Frames>
      <Scripts>
        <OnShow>TestScreen_OnShow(self);</OnShow>
      </Scripts>
    </Frame>
  </Ui>`,
  "Interface/GlueXML/TestScreen.lua": `
    SHOWN = 0;
    function TestScreen_OnShow(self) SHOWN = SHOWN + 1; PlaySound("gsLogin"); end
    function TestScreen_OnClick(self, button) CLICKED = button .. "/" .. tostring(this == self); end
    function TestScreen_OnKeyDown() KEY_SEEN = arg1; end
  `,
};

async function loadFixture(overrides = {}) {
  const stubs = { method: [], global: [] };
  const runtime = new GlueRuntime({
    provider: createFixtureProvider({ ...FIXTURE, ...overrides }),
    lua: { onError: (message) => { throw new Error(`unhandled glue Lua error: ${message}`); } },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
    onStub: (kind, name) => stubs[kind].push(name),
  });
  const result = await runtime.load();
  return { runtime, result, stubs };
}

test("the TOC walk keeps order, skips a missing entry and honours ## comments", async () => {
  const { runtime, result } = await loadFixture();
  assert.deepEqual(result.tocEntries.map((entry) => entry.path), [
    "interface/gluexml/gluestrings.lua",
    "interface/sharedxml/sharedgluestrings.lua",
    "interface/gluexml/gluefonts.xml",
    "interface/gluexml/glueparent.xml",
    "interface/gluexml/testscreen.xml",
  ], "##CameraSelect.xml is commented out, not metadata");
  // A missing file is a skip, exactly as the real client skips a TOC entry it
  // cannot find; it must not abort the rest of the walk.
  assert.deepEqual(result.missing, ["interface/sharedxml/sharedgluestrings.lua"]);
  assert.deepEqual(result.loaded, [
    "interface/gluexml/gluexml.toc",
    "interface/gluexml/gluestrings.lua",
    "interface/gluexml/gluefonts.xml",
    "interface/gluexml/glueparent.xml",
    "interface/gluexml/glueparent.lua",
    "interface/gluexml/testscreen.xml",
    "interface/gluexml/testscreen.lua",
  ]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(runtime.vm.errors.length, 0);
  runtime.close();
});

test("path resolution reaches SharedXML but never leaves the interface tree", () => {
  assert.equal(
    resolveGluePath("interface/gluexml/", "..\\SharedXML\\SharedGlueStrings.lua"),
    "interface/sharedxml/sharedgluestrings.lua",
  );
  assert.equal(resolveGluePath("interface/gluexml/", "GlueParent.lua"), "interface/gluexml/glueparent.lua");
  assert.equal(resolveGluePath("interface/gluexml/", "..\\..\\..\\etc\\passwd"), undefined);
  assert.equal(resolveGluePath("interface/gluexml/", "..\\..\\WTF\\Config.wtf"), undefined);
  assert.deepEqual(parseGlueToc("# comment\n\n##Skipped.lua\nReal.xml\n", "interface/gluexml/"), [
    { path: "interface/gluexml/real.xml", kind: "xml" },
  ]);
});

test("templates, $parent names and anchors resolve on a real-shaped screen", async () => {
  const { runtime, result } = await loadFixture();
  const bridge = runtime.bridge;
  assert.ok(result.templates.includes("TestPanelTemplate"));
  assert.ok(result.templates.includes("TestFontHighlight"));

  // A screen declares its parent by name because each screen is its own file.
  const screen = bridge.getFrame("TestScreen");
  assert.equal(screen.parent?.name, "GlueParent");
  assert.deepEqual(result.roots.map((root) => root.name), ["GlueParent"]);
  // setAllPoints expands into the two anchors it means, so the screen inherits
  // GlueParent's rectangle instead of anchoring to the document.
  assert.deepEqual(screen.points.map((point) => point.point), ["TOPLEFT", "BOTTOMRIGHT"]);

  // `$parent` is expanded against the instance, not the template.
  const background = bridge.getFrame("TestPanelBg");
  assert.ok(background, "$parentBg became TestPanelBg");
  assert.equal(background.drawLayer, "BACKGROUND");
  assert.equal(background.alphaMode, "ADD");
  assert.deepEqual(background.texCoords, { left: 0, right: 0.5, top: 0, bottom: 0.25 });
  assert.deepEqual(background.vertexColor, { r: 1, g: 0, b: 0, a: 0.5 });

  const title = bridge.getFrame("TestPanelTitle");
  assert.equal(title.drawLayer, "OVERLAY");
  // `text=` is a GlobalString key first: GlueStrings.lua has already run.
  assert.equal(title.text, "Войти");
  assert.equal(title.fontObject, "TestFontHighlight");

  // The font object flattens its whole inherits chain down to file and height.
  const font = bridge.fontStyle("TestFontHighlight");
  assert.equal(font.file, "Fonts\\FRIZQT__.TTF");
  assert.equal(font.height, 14);
  assert.equal(font.outline, "NORMAL");
  assert.deepEqual(font.color, { r: 1, g: 1, b: 1, a: 1 });

  const panel = bridge.getFrame("TestPanel");
  assert.equal(panel.attributes.width, "200");
  assert.equal(panel.backdrop.edgeSize, 32);
  assert.equal(panel.backdrop.tileSize, 16);
  assert.equal(panel.backdrop.tile, true);
  assert.deepEqual(panel.backdrop.insets, { left: 11, right: 12, top: 12, bottom: 11 });

  // `relativeto` in lower case is what the server's own AccountLogin.xml
  // writes, and Blizzard's parser folds attribute names.
  const button = bridge.getFrame("TestLoginButton");
  assert.equal(button.points[0].relativeTo?.name, "TestPanel");
  assert.equal(button.points[0].relativePoint, "BOTTOMLEFT");
  assert.deepEqual([button.points[0].x, button.points[0].y], [4, -6]);
  assert.equal(button.text, "Войти");
  assert.equal(bridge.getFrame("TestLoginButtonText").text, "Войти", "ButtonText mirrors the button label");
  assert.ok(button.stateTextures.get("NORMAL"), "NormalTexture became a state texture");

  const edit = bridge.getFrame("TestAccountEdit");
  assert.equal(edit.editBox.letters, 16);
  assert.equal(edit.editBox.historyLines, 4);
  assert.equal(edit.fontObject, "TestFontBase", "an unnamed FontString child sets the EditBox font");

  // A Model widget records; G3 renders. The .mdx path stays off the texture path.
  const model = bridge.getFrame("TestBackdropModel");
  assert.equal(model.type, "ModelFFX");
  assert.equal(model.texture, "");
  assert.equal(model.model.file, "Interface\\Glues\\Models\\UI_Human\\UI_Human.mdx");
  assert.deepEqual([model.model.fogNear, model.model.fogFar, model.model.glow], [0, 1200, 0.15]);
  runtime.close();
});

test("handlers run with the legacy implicit environment 3.3.5 glue code reads", async () => {
  const { runtime } = await loadFixture();
  const bridge = runtime.bridge;
  const button = bridge.getFrame("TestLoginButton");

  // `this` is the global the corpus' inline handlers still use (three of them
  // in GlueLocalizationPost.xml alone).
  bridge.Click(button, "LeftButton", false);
  assert.equal(runtime.vm.getGlobal("CLICKED"), "LeftButton/true");

  // `TrialConvert_OnKeyDown()` takes no parameters at all and reads arg1.
  bridge.fireScript(button, "OnKeyDown", "ESCAPE");
  assert.equal(runtime.vm.getGlobal("KEY_SEEN"), "ESCAPE");

  // The environment is saved and restored around nesting, so an outer handler
  // still sees its own arg1 after an inner dispatch returns.
  runtime.vm.execute(`
    function TestScreen_OnKeyDown()
      OUTER_BEFORE = arg1
      TestLoginButton:Click()
      OUTER_AFTER = arg1
    end
  `, "@nesting");
  bridge.fireScript(button, "OnKeyDown", "ENTER");
  assert.equal(runtime.vm.getGlobal("OUTER_BEFORE"), "ENTER");
  assert.equal(runtime.vm.getGlobal("OUTER_AFTER"), "ENTER");
  runtime.close();
});

test("the C API answers where it can and records where it cannot", async () => {
  const { runtime, stubs } = await loadFixture();
  const vm = runtime.vm;
  vm.execute("BUILD = { GetBuildInfo() }; LOCALE = GetLocale()", "@probe");
  assert.equal(vm.getGlobal("LOCALE"), "ruRU");
  // 06.10-glue-fix: the glue GetBuildInfo (0x004dbe60) answers VERSION, RELEASE_BUILD and three
  // strings; the fixture defines neither GlueString, so the first two are "".
  vm.execute("T, R, V, B, D, N = GetBuildInfo()", "@probe2");
  assert.deepEqual(
    [vm.getGlobal("T"), vm.getGlobal("R"), vm.getGlobal("V"), vm.getGlobal("B"), vm.getGlobal("D")],
    ["", "", ...GLUE_BUILD_INFO],
  );
  assert.equal(vm.getGlobal("N"), undefined);

  // CVars round-trip through the same map the glue defaults live in.
  assert.equal(runtime.api.cvar("readTOS"), "0");
  vm.execute('SetCVar("accountName", "TESTER"); SAVED = GetSavedAccountName()', "@cvar");
  assert.equal(vm.getGlobal("SAVED"), "TESTER");

  // The screen registry is Lua; the C side only records which screen won.
  assert.equal(runtime.bridge.getFrame("TestScreen").visible, false);
  assert.equal(runtime.api.setGlueScreen("login"), true);
  assert.equal(runtime.api.currentScreen, "login");
  assert.equal(runtime.bridge.getFrame("TestScreen").visible, true);
  assert.equal(vm.getGlobal("SHOWN"), 1, "Show() ran the screen's OnShow");
  // Audio is a recording seam until G3 wires the mixer.
  assert.deepEqual(runtime.api.audio.calls, [{ method: "PlaySound", args: ["gsLogin"] }]);

  // A glue event reaches the frame that registered for it, with `event` and
  // the varargs the corpus forwards.
  runtime.bridge.RegisterEvent(runtime.bridge.getFrame("GlueParent"), "SET_GLUE_SCREEN");
  assert.equal(runtime.api.fireEvent("SET_GLUE_SCREEN", "charselect"), 1);
  assert.equal(vm.getGlobal("LAST_EVENT"), "SET_GLUE_SCREEN:charselect");

  // Nothing in this fixture reaches a stub, which is what makes the corpus
  // test's stub list meaningful.
  assert.deepEqual(stubs.global, []);
  assert.deepEqual(stubs.method, []);
  runtime.close();
});

test("the HTTP provider follows the gateway's 404-versus-error split", async () => {
  const seen = [];
  const provider = createHttpFileProvider({
    gatewayOrigin: "http://127.0.0.1:8090/",
    fetch: async (url) => {
      seen.push(url);
      if (url.includes("Missing.lua")) return { status: 404, ok: false, text: async () => "" };
      if (url.includes("Broken.lua")) return { status: 503, ok: false, text: async () => "" };
      return { status: 200, ok: true, text: async () => "-- ok" };
    },
    sleep: async () => {},
  });
  assert.equal(await provider.read("Interface/GlueXML/GlueParent.lua"), "-- ok");
  assert.equal(
    seen[0],
    "http://127.0.0.1:8090/client/file?path=Interface%5CGlueXML%5CGlueParent.lua",
    "the gateway route takes a backslash WoW path",
  );
  assert.equal(await provider.read("Interface/GlueXML/Missing.lua"), undefined, "404 is a skip");
  await assert.rejects(
    provider.read("Interface/GlueXML/Broken.lua"),
    (error) => error instanceof GlueServerUnavailableError && /returned 503/.test(error.cause.message)
      && error.origin === "http://127.0.0.1:8090",
    "a broken gateway must not look like a missing file",
  );
});

/* --- 10.16: retry on 5xx and network failure, then «server unavailable» ---------------------- */

function scripted(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (next === 200) return { status: 200, ok: true, text: async () => "-- ok" };
    if (next === 409) {
      return { status: 409, ok: false, json: async () => ({ error: "client_patch_chain_changed" }) };
    }
    return { status: next, ok: false, text: async () => "" };
  };
  return { calls, fetch };
}

test("a gateway that is gone stops the load instead of building half a screen", async () => {
  const runtime = new GlueRuntime({
    provider: {
      async read(path) {
        if (path.toLowerCase().endsWith("gluexml.toc")) return FIXTURE["Interface/GlueXML/GlueXML.toc"];
        throw new GlueServerUnavailableError("http://127.0.0.1:8090", new TypeError("Failed to fetch"));
      },
    },
    lua: { onError: () => {} },
    api: { locale: "ruRU", screenWidth: 1024, screenHeight: 768 },
  });
  try {
    await assert.rejects(runtime.load(), GlueServerUnavailableError);
  } finally {
    runtime.close();
  }
});
test("the HTTP provider retries 5xx and network failures on a short ladder", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const make = (fetch) => createHttpFileProvider({ gatewayOrigin: "http://127.0.0.1:8090", fetch, sleep });

  let script = scripted([503, 503, 200]);
  assert.equal(await make(script.fetch).read("Interface/GlueXML/A.lua"), "-- ok");
  assert.equal(script.calls.length, 3);
  assert.deepEqual(sleeps, [500, 1500]);

  script = scripted([503, 502, 500, 504]);
  await assert.rejects(make(script.fetch).read("Interface/GlueXML/A.lua"), GlueServerUnavailableError);
  assert.equal(script.calls.length, 4, "one try plus three retries");

  script = scripted([new TypeError("Failed to fetch"), 200]);
  assert.equal(await make(script.fetch).read("Interface/GlueXML/A.lua"), "-- ok", "a dropped connection is retried");

  script = scripted([404]);
  assert.equal(await make(script.fetch).read("Interface/GlueXML/A.lua"), undefined);
  assert.equal(script.calls.length, 1, "404 is an answer, not a failure");

  script = scripted([403, 200]);
  await assert.rejects(make(script.fetch).read("Interface/GlueXML/A.lua"), (error) =>
    !(error instanceof GlueServerUnavailableError) && /returned 403/.test(error.message));
  assert.equal(script.calls.length, 1, "a 4xx is not retried: waiting cannot change it");

  script = scripted([409, 200]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(make(script.fetch).read("Interface/GlueXML/A.lua"), PatchChainChangedError);
  } finally {
    console.warn = warn;
  }
  assert.equal(script.calls.length, 1, "the patch-chain latch is the banner's, not the retry's");
});

test("retrying runs once per delay and stops on a failure it is told not to retry", async () => {
  let calls = 0;
  await assert.rejects(retrying(async () => { calls++; throw new Error("no"); },
    { delaysMs: [1, 1], sleep: async () => {}, isRetryable: () => false }), /no/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(retrying(async () => { calls++; throw new TypeError("net"); },
    { delaysMs: [1, 1], sleep: async () => {} }), TypeError);
  assert.equal(calls, 3);
});

test("the unavailable screen's probe asks for the login TOC and reads the answer", async () => {
  const seen = [];
  assert.equal(await probeGlueServer("http://127.0.0.1:8090", async (url) => {
    seen.push(url);
    return { ok: true, status: 200 };
  }), true);
  assert.match(seen[0], /\/client\/file\?path=Interface%5CGlueXML%5CGlueXML\.toc$/);
  assert.equal(await probeGlueServer("http://127.0.0.1:8090", async () => ({ ok: false, status: 404 })), true);
  assert.equal(await probeGlueServer("http://127.0.0.1:8090", async () => ({ ok: false, status: 503 })), false);
  assert.equal(await probeGlueServer("http://127.0.0.1:8090", async () => { throw new TypeError("x"); }), false);
});

test("the glue viewport scales by height, as GlueParent's own layout implies", () => {
  // GlueParent.xml is setAllPoints with no size and GlueParent_OnLoad only
  // pillarboxes past 16:9, so height is the fixed axis at 768 UI units.
  assert.deepEqual(glueViewportMetrics(1024, 768), { scale: 1, virtualWidth: 1024, virtualHeight: 768 });
  const wide = glueViewportMetrics(2560, 1440);
  assert.equal(wide.scale, 1440 / 768);
  assert.equal(Math.round(wide.virtualWidth), 1365, "16:9 is 1365 UI units wide, not a stretched 1024");
  assert.equal(wide.virtualHeight, 768);
  // A degenerate viewport must not produce NaN geometry.
  assert.equal(glueViewportMetrics(0, 0).scale, 1);
});
