import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { createGlueCVarStore } from "../dist/code/browser/glue/GlueCVarStore.js";
import {
  GLUE_PASSWORD_STORAGE_PREFIX, createGlueSavedPasswordStore,
} from "../dist/code/browser/glue/GlueSavedPassword.js";

/**
 * 12.10 — the owner's decision «стоит сохранять пароль»: the stock login screen's «remember» box
 * keeps the password of an accepted login beside the account name, and the screen gets it back.
 */

const ORIGIN = "http://127.0.0.1:8090";
const KEY = `${GLUE_PASSWORD_STORAGE_PREFIX}${ORIGIN}`;

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

/* --- an authserver that accepts TEST:PASSWORD (glue-realm-list.test.mjs), or refuses the proof ---- */

const SRP_N = 0x894b645e89e1535bbdad5b8b290650530801b18ebfbf5e8fab3c82872a3e9bb7n;
const SRP_G = 7n;
const sha1 = (...parts) => {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const fromLe = (bytes) => { let value = 0n; for (let at = bytes.length - 1; at >= 0; at--) value = (value << 8n) | BigInt(bytes[at]); return value; };
const toLe = (value, length) => { const out = new Uint8Array(length); for (let at = 0; at < length; at++) { out[at] = Number(value & 0xffn); value >>= 8n; } return out; };
const modPow = (base, exponent, modulus) => {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) { if (exponent & 1n) result = (result * base) % modulus; base = (base * base) % modulus; exponent >>= 1n; }
  return result;
};
const interleave = (secret) => {
  const even = new Uint8Array(16);
  const odd = new Uint8Array(16);
  for (let at = 0; at < 16; at++) { even[at] = secret[at * 2]; odd[at] = secret[at * 2 + 1]; }
  let first = 0;
  while (first < 32 && secret[first] === 0) first++;
  if (first & 1) first++;
  const left = sha1(even.subarray(first / 2));
  const right = sha1(odd.subarray(first / 2));
  const key = new Uint8Array(40);
  for (let at = 0; at < 20; at++) { key[at * 2] = left[at]; key[at * 2 + 1] = right[at]; }
  return key;
};

function fakeAuthServer({ refuse = false } = {}) {
  const salt = Uint8Array.from({ length: 32 }, (_, at) => at + 1);
  const b = fromLe(Uint8Array.from({ length: 32 }, (_, at) => 0x51 + at));
  const verifier = modPow(SRP_G, fromLe(sha1(salt, sha1(new TextEncoder().encode("TEST:PASSWORD")))), SRP_N);
  const B = toLe((modPow(SRP_G, b, SRP_N) + 3n * verifier) % SRP_N, 32);
  let inbox = new Uint8Array(0);
  let waiting;
  let closed = false;
  const push = (bytes) => { inbox = Uint8Array.from([...inbox, ...bytes]); deliver(); };
  const deliver = () => {
    if (!waiting || inbox.length < waiting.length) return;
    const { length, resolve } = waiting;
    waiting = undefined;
    const out = inbox.slice(0, length);
    inbox = inbox.slice(length);
    resolve(out);
  };
  return {
    send(bytes) {
      if (bytes[0] === 0x00) {
        push([0x00, 0x00, 0x00, ...B, 1, 7, 32, ...toLe(SRP_N, 32), ...salt, ...new Array(16).fill(0), 0]);
      } else if (bytes[0] === 0x01) {
        // WOW_FAIL_INCORRECT_PASSWORD, as AuthSession answers a wrong proof.
        if (refuse) { push([0x01, 0x05]); return; }
        const A = bytes.slice(1, 33);
        const M1 = bytes.slice(33, 53);
        const u = fromLe(sha1(A, B));
        const secret = modPow((fromLe(A) * modPow(verifier, u, SRP_N)) % SRP_N, b, SRP_N);
        push([0x01, 0x00, ...sha1(A, M1, interleave(toLe(secret, 32))), 0, 0, 0x80, 0, 0, 0, 0, 0, 0, 0]);
      } else if (bytes[0] === 0x10) {
        // An empty REALM_LIST: u32 0, u16 count 0, the trailing 0x10 0x00 (AuthSession).
        push([0x10, 8, 0, 0, 0, 0, 0, 0, 0, 0x10, 0]);
      }
    },
    readExactly(length) {
      return new Promise((resolve, reject) => {
        if (closed) { reject(new Error("closed")); return; }
        waiting = { length, resolve, reject };
        deliver();
      });
    },
    close() {
      closed = true;
      const pending = waiting;
      waiting = undefined;
      pending?.reject(new Error("closed"));
    },
  };
}

/* --- the stock login screen's flow, reduced to what the password touches ----------------------- */

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "AccountLogin.lua", "AccountLogin.xml"].join("\n"),
  // AccountLogin.lua:40-75 and :170-180 of the stock file, without the parts the password never meets.
  "Interface/GlueXML/AccountLogin.lua": `
function AccountLogin_OnShow(self)
  AccountLoginAccountEdit:SetText(GetSavedAccountName())
  AccountLoginPasswordEdit:SetText("")
end
function AccountLogin_Login()
  DefaultServerLogin(AccountLoginAccountEdit:GetText(), AccountLoginPasswordEdit:GetText())
  AccountLoginPasswordEdit:SetText("")
  if REMEMBER then
    SetSavedAccountName(AccountLoginAccountEdit:GetText())
  else
    SetSavedAccountName("")
  end
end`,
  "Interface/GlueXML/AccountLogin.xml": `<Ui>
    <Frame name="AccountLogin" hidden="true">
      <Frames>
        <EditBox name="AccountLoginAccountEdit" letters="320"><Size x="200" y="37"/></EditBox>
        <EditBox name="AccountLoginPasswordEdit" letters="16" password="1"><Size x="200" y="37"/></EditBox>
      </Frames>
      <Scripts><OnShow>AccountLogin_OnShow(self);</OnShow></Scripts>
    </Frame>
  </Ui>`,
};

const settle = async () => { for (let round = 0; round < 8; round++) await new Promise((resolve) => setImmediate(resolve)); };

async function glue(storage, auth = fakeAuthServer()) {
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      authUrl: "ws://gateway/auth",
      connect: async () => auth,
      cvarStore: createGlueCVarStore(storage, ORIGIN),
      passwordStore: createGlueSavedPasswordStore(storage, ORIGIN),
    },
  });
  await runtime.load();
  const lua = (source) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${source} end)()`, "@glue-saved-password");
    assert.equal(outcome.ok, true, `${source}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };
  return { runtime, lua };
}

async function loginThrough(storage, { password = "PASSWORD", remember = true, auth } = {}) {
  const screen = await glue(storage, auth);
  // DefaultServerLogin starts the login without waiting for it; the test waits for exactly that one.
  let pending;
  const login = screen.runtime.api.login.bind(screen.runtime.api);
  screen.runtime.api.login = (...args) => (pending = login(...args));
  try {
    screen.lua(`REMEMBER = ${remember}; AccountLoginAccountEdit:SetText("TEST");
      AccountLoginPasswordEdit:SetText(${JSON.stringify(password)}); AccountLogin_Login()`);
    assert.ok(pending, "DefaultServerLogin reached the login");
    await pending;
    await settle();
  } finally {
    screen.runtime.close();
  }
}

async function shownFields(storage) {
  const screen = await glue(storage);
  try {
    screen.lua("AccountLogin:Show()");
    return [screen.lua("return AccountLoginAccountEdit:GetText()"), screen.lua("return AccountLoginPasswordEdit:GetText()")];
  } finally {
    screen.runtime.close();
  }
}

test("an accepted login with the box ticked is remembered, and the screen gets name and password back", async () => {
  const storage = memoryStorage();
  await loginThrough(storage);
  assert.deepEqual(JSON.parse(storage.data.get(KEY)), { account: "TEST", password: "PASSWORD" });
  assert.deepEqual(await shownFields(storage), ["TEST", "PASSWORD"],
    "after the stock OnShow emptied the field, the saved password is put back");
});

test("without the box, nothing of the password is kept, and an earlier one is forgotten", async () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ account: "TEST", password: "OLD" }) });
  await loginThrough(storage, { remember: false });
  assert.equal(storage.data.has(KEY), false);
  assert.deepEqual(await shownFields(storage), ["", ""]);
});

test("a refused password is never stored, and a saved one for that account is dropped", async () => {
  const storage = memoryStorage();
  await loginThrough(storage, { password: "WRONG", auth: fakeAuthServer({ refuse: true }) });
  assert.equal(storage.data.has(KEY), false, "the box was ticked, but the server said no");
  storage.data.set(KEY, JSON.stringify({ account: "TEST", password: "PASSWORD" }));
  await loginThrough(storage, { password: "WRONG", auth: fakeAuthServer({ refuse: true }) });
  assert.equal(storage.data.has(KEY), false, "the remembered password no longer works");
});

test("the password goes only into the field of the name it was saved for", async () => {
  const storage = memoryStorage({ [KEY]: JSON.stringify({ account: "OTHER", password: "SECRET" }) });
  const screen = await glue(storage);
  try {
    screen.lua('SetSavedAccountName("TEST"); AccountLogin:Show()');
    assert.equal(screen.lua("return AccountLoginPasswordEdit:GetText()"), "");
  } finally {
    screen.runtime.close();
  }
});

test("the store refuses junk and survives a blocked storage", () => {
  const blocked = {
    getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); },
  };
  const store = createGlueSavedPasswordStore(blocked, ORIGIN);
  assert.equal(store.load(), undefined);
  assert.doesNotThrow(() => { store.save("TEST", "PASSWORD"); store.clear(); });
  const storage = memoryStorage({ [KEY]: "not json" });
  assert.equal(createGlueSavedPasswordStore(storage, ORIGIN).load(), undefined);
  createGlueSavedPasswordStore(storage, ORIGIN).save("TEST", "");
  assert.equal(storage.data.get(KEY), "not json", "an empty password is not written");
  createGlueSavedPasswordStore(storage, ORIGIN).save("TEST", "PASSWORD");
  assert.equal(createGlueSavedPasswordStore(storage, "http://other:8090").load(), undefined, "per gateway");
});
