import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { createGlueCVarStore, isPlainAccountName } from "../dist/code/browser/glue/GlueCVarStore.js";

/**
 * 10.07 — the glue CVars that outlive a reload: account name, realm, last character, usesToken —
 * per gateway, in this browser, and never a password.
 */

const ORIGIN = "http://127.0.0.1:8090";
const KEY = `webclient.glue.cvars:${ORIGIN}`;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); } };
}

const saved = (storage) => JSON.parse(storage.data.get(KEY) ?? "{}");

test("only the listed CVars are kept, and a password never is", () => {
  const storage = memoryStorage();
  const store = createGlueCVarStore(storage, ORIGIN);
  const cvars = new Map([["accountName", "TESTER"], ["password", "secret"], ["realmName", "Мир"]]);
  store.save("password", cvars);
  assert.equal(storage.data.size, 0, "a name outside the list writes nothing");
  store.save("accountName", cvars);
  assert.deepEqual(saved(storage), { accountName: "TESTER", realmName: "Мир" });
  assert.ok(!storage.data.get(KEY).includes("secret"));
  assert.deepEqual(store.load(), { accountName: "TESTER", realmName: "Мир" });
});

test("a login-screen blob in the account pair is not kept, and removes what was", () => {
  // The owner's LoginScreenModule writes name and password, deflated and printable, split over the
  // two CVars. Nothing about the account is kept then — not even a name saved earlier.
  const storage = memoryStorage();
  const store = createGlueCVarStore(storage, ORIGIN);
  store.save("accountName", new Map([["accountName", "TESTER"]]));
  const blob = "e0zAQfMP0jbQ3vN7kEdBQY1rEbT2jcBcC7dKJcS7ktxMOiqqPZm(ZIiUKQl";
  store.save("accountName", new Map([["accountName", blob], ["accountList", ""]]));
  assert.deepEqual(saved(storage), {});
  store.save("accountList", new Map([["accountName", "SHORT"], ["accountList", "tail"]]));
  assert.deepEqual(saved(storage), {}, "a second half means it is not a plain name");
  assert.equal(isPlainAccountName("TESTER", ""), true);
  assert.equal(isPlainAccountName("АБВГДЕЖЗИ", ""), false, "18 bytes: more than a challenge carries");
  assert.equal(isPlainAccountName("A B", ""), false);
  // A tampered storage with a blob in it loads without the pair.
  const tampered = memoryStorage({ [KEY]: JSON.stringify({ accountName: blob, realmName: "Мир", password: "x" }) });
  assert.deepEqual(createGlueCVarStore(tampered, ORIGIN).load(), { realmName: "Мир" });
});

test("a blocked or broken storage is no memory, not a broken page", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  const store = createGlueCVarStore(blocked, ORIGIN);
  assert.deepEqual(store.load(), {});
  assert.doesNotThrow(() => store.save("realmName", new Map([["realmName", "Мир"]])));
  assert.deepEqual(createGlueCVarStore(memoryStorage({ [KEY]: "not json" }), ORIGIN).load(), {});
  assert.deepEqual(createGlueCVarStore(null, ORIGIN).load(), {});
  // Per gateway: another origin sees nothing.
  const storage = memoryStorage();
  createGlueCVarStore(storage, ORIGIN).save("realmName", new Map([["realmName", "Мир"]]));
  assert.deepEqual(createGlueCVarStore(storage, "http://other:8090").load(), {});
});

/* --- through the C API ------------------------------------------------------------------------ */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent">
      <Scripts>
        <OnLoad>
          SEEN = {};
          self:RegisterEvent("SUGGEST_REALM");
          self:RegisterEvent("OPEN_REALM_LIST");
        </OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event .. " " .. tostring(arg1) .. " " .. tostring(arg2);</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

const REALMS = [
  { type: 1, locked: false, flags: 0, name: "Первый", address: "a", population: 0, characters: 0, timezone: 1, id: 1 },
  { type: 1, locked: false, flags: 0, name: "Второй", address: "b", population: 0, characters: 2, timezone: 1, id: 2 },
  { type: 1, locked: true, flags: 0, name: "Закрытый", address: "c", population: 0, characters: 0, timezone: 1, id: 3 },
];

function summary(guid, name) {
  return {
    guid: BigInt(guid), name, race: 1, classId: 1, gender: 0, skin: 0, face: 0, hairStyle: 0, hairColor: 0,
    facialHair: 0, level: 1, zone: 0, map: 0, x: 0, y: 0, z: 0, guildId: 0, flags: 0x02000000,
    customizeFlags: 0, firstLogin: false, petDisplayId: 0, petLevel: 0, petFamily: 0, equipment: [],
  };
}

async function glue(storage, { fixture = FIXTURE } = {}) {
  const entered = [];
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(fixture),
    api: {
      locale: "ruRU",
      cvarStore: createGlueCVarStore(storage, ORIGIN),
      enterWorld: (request) => entered.push(request.index),
      session: {
        connect: async () => ({
          characters: async () => [summary(1, "Один"), summary(2, "Два"), summary(3, "Три")],
          deleteCharacter: async () => 71,
          close() {},
        }),
      },
    },
  });
  await runtime.load();
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-cvar-probe");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  const seen = () => {
    return lua('return table.concat(SEEN or {}, "|")') || "";
  };
  return { runtime, lua, seen, entered };
}

test("the login screen's CVars survive a reload, the password does not", async () => {
  const storage = memoryStorage();
  const first = await glue(storage);
  try {
    first.lua('SetSavedAccountName("TESTER"); SetCVar("password", "secret"); SetUsesToken(true); return 1');
  } finally {
    first.runtime.close();
  }
  assert.ok(!storage.data.get(KEY).includes("secret"));
  const second = await glue(storage);
  try {
    assert.equal(second.lua("return GetSavedAccountName()"), "TESTER");
    assert.equal(second.lua("return GetUsesToken()"), true);
    assert.equal(second.lua('return GetCVar("password")'), undefined);
  } finally {
    second.runtime.close();
  }
});

test("the last realm is suggested after a login, and the last character is selected", async () => {
  const storage = memoryStorage();
  const first = await glue(storage);
  try {
    first.runtime.session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: REALMS });
    first.lua("ChangeRealm(1, 2); return 1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.lua("SelectCharacter(3); EnterWorld(); return 1");
    assert.deepEqual(first.entered, [3]);
  } finally {
    first.runtime.close();
  }
  assert.equal(saved(storage).realmName, "Второй");
  assert.equal(saved(storage).lastCharacterIndex, "2", "0-based, as the client writes it");

  const second = await glue(storage);
  try {
    second.runtime.session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: REALMS });
    second.lua("SEEN = {}; return 1");
    second.runtime.api.chooseRealmAfterLogin();
    assert.equal(second.seen(), "SUGGEST_REALM 1 2", "not the realm list");
    await second.runtime.session.connect(REALMS[1]);
    assert.equal(second.runtime.session.selectedIndex, 3, "the character last taken into the world");
  } finally {
    second.runtime.close();
  }
});

test("a remembered realm that is gone, locked or unheard falls back to the realm list", async () => {
  const cases = [
    [{ realmName: "Нет такого" }, FIXTURE],
    [{ realmName: "Закрытый" }, FIXTURE],
  ];
  for (const [kept, fixture] of cases) {
    const storage = memoryStorage({ [KEY]: JSON.stringify(kept) });
    const stage = await glue(storage, { fixture });
    try {
      stage.runtime.session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: REALMS });
      stage.lua("SEEN = {}; return 1");
      stage.runtime.api.chooseRealmAfterLogin();
      assert.equal(stage.seen(), "OPEN_REALM_LIST nil nil", JSON.stringify(kept));
    } finally {
      stage.runtime.close();
    }
  }
  // Nobody listens for SUGGEST_REALM: the realm list still opens.
  const quiet = {
    ...FIXTURE,
    "Interface/GlueXML/GlueParent.xml": FIXTURE["Interface/GlueXML/GlueParent.xml"].replace('self:RegisterEvent("SUGGEST_REALM");', ""),
  };
  const storage = memoryStorage({ [KEY]: JSON.stringify({ realmName: "Второй" }) });
  const stage = await glue(storage, { fixture: quiet });
  try {
    stage.runtime.session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: REALMS });
    stage.lua("SEEN = {}; return 1");
    stage.runtime.api.chooseRealmAfterLogin();
    assert.equal(stage.seen(), "OPEN_REALM_LIST nil nil");
  } finally {
    stage.runtime.close();
  }
});

test("a last character outside the list changes nothing", async () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ lastCharacterIndex: "7" }) });
  const stage = await glue(storage);
  try {
    stage.runtime.session.beginSession({ username: "T", sessionKey: new Uint8Array(40), realms: REALMS });
    await stage.runtime.session.connect(REALMS[1]);
    assert.equal(stage.runtime.session.selectedIndex, 0);
  } finally {
    stage.runtime.close();
  }
});
