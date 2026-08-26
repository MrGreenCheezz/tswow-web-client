import assert from "node:assert/strict";
import test from "node:test";

import {
  clientLocale,
  gatewayOrigin,
  gatewayWebSocketUrl,
} from "../dist/code/browser/Environment.js";

test("gateway addresses follow the page until an explicit public origin is configured", () => {
  const local = { protocol: "http:", hostname: "127.0.0.1" };
  const secure = { protocol: "https:", hostname: "wow.example" };
  assert.equal(gatewayOrigin(local), "http://127.0.0.1:8090");
  assert.equal(gatewayWebSocketUrl(local), "ws://127.0.0.1:8090/auth");
  assert.equal(gatewayOrigin(secure), "https://wow.example:8090");
  assert.equal(gatewayWebSocketUrl(secure, "/world"), "wss://wow.example:8090/world");
  assert.equal(gatewayOrigin(local, "https://gateway.example/"), "https://gateway.example");
  assert.throws(() => gatewayOrigin(local, "ws://gateway.example"), /must use http/);
});

test("the login locale is configurable and validated", () => {
  assert.equal(clientLocale(), "ruRU");
  assert.equal(clientLocale("enUS"), "enUS");
  assert.throws(() => clientLocale("english"), /Invalid VITE_CLIENT_LOCALE/);
});
