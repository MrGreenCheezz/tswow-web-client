// Open account registration for the players' site (tools/player-site.mjs, bat\32): the page computes
// the SRP6 salt and verifier itself (site/srp.js), so only the name and those two values arrive here,
// and this writes them into the auth database the way TrinityCore's AccountMgr::CreateAccount does —
// the same two statements (LoginDatabase.cpp LOGIN_INS_ACCOUNT, LOGIN_INS_REALM_CHARACTERS_INIT),
// through tswow's bundled mysql client like the other tools, without adding a driver.
//
// Abuse limits for an open form on the internet, all in memory (they reset with the server):
// per address 3 accounts an hour and 20 requests in ten minutes, 30 accounts an hour overall;
// requests run one at a time.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import { SRP_N, USERNAME_PATTERN } from "../site/srp.js";

const HEX_32 = /^[0-9a-f]{64}$/;

/** `LoginDatabaseInfo = "host;port;user;password;database"` from worldserver.conf. */
export function loginDatabase(configText) {
  const match = configText.match(/^LoginDatabaseInfo\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("LoginDatabaseInfo is missing in worldserver.conf");
  const [host, port, user, password, database] = match[1].split(";");
  if (!host || !port || !user || password === undefined || !database) throw new Error("LoginDatabaseInfo is invalid");
  return { host, port, user, password, database };
}

function fromLittleEndianHex(hex) {
  let value = 0n;
  for (let i = hex.length - 2; i >= 0; i -= 2) value = (value << 8n) | BigInt(Number.parseInt(hex.slice(i, i + 2), 16));
  return value;
}

/** The request body as `{ username, salt, verifier }` ready for SQL, or `{ error }`. */
export function validateRegistration(body) {
  if (body === null || typeof body !== "object") return { error: "bad-request" };
  const { username, salt, verifier } = body;
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) return { error: "bad-username" };
  if (typeof salt !== "string" || !HEX_32.test(salt) || /^0+$/.test(salt)) return { error: "bad-request" };
  if (typeof verifier !== "string" || !HEX_32.test(verifier)) return { error: "bad-request" };
  const v = fromLittleEndianHex(verifier);
  if (v === 0n || v >= SRP_N) return { error: "bad-request" };
  // The page uppercases already; doing it again keeps the stored name what the authserver looks up.
  return { username: username.toUpperCase(), salt, verifier };
}

/** Both statements; every value is validated above (name [A-Z0-9], hex), nothing is quoted from input. */
export function accountSql({ username, salt, verifier }) {
  return [
    `INSERT INTO account (username, salt, verifier, reg_mail, email, joindate) VALUES ('${username}', 0x${salt}, 0x${verifier}, '', '', NOW());`,
    "INSERT INTO realmcharacters (realmid, acctid, numchars) SELECT realmlist.id, account.id, 0 FROM realmlist, account"
      + " LEFT JOIN realmcharacters ON acctid = account.id WHERE acctid IS NULL;",
  ].join(" ");
}

/** Runs SQL through the mysql client; resolves `"ok"` or `"duplicate"` (the unique name key), throws otherwise. */
export function mysqlRunner({ mysql, db }) {
  return (sql) => new Promise((resolve, reject) => {
    execFile(mysql, [
      `--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`, `--database=${db.database}`,
      "--default-character-set=utf8", "--batch", `--execute=${sql}`,
    ], { env: { ...process.env, MYSQL_PWD: db.password }, timeout: 15_000, windowsHide: true }, (error, _stdout, stderr) => {
      if (!error) resolve("ok");
      else if (/ERROR 1062/.test(stderr)) resolve("duplicate");
      else reject(new Error(stderr.trim() || error.message));
    });
  });
}

/** Sliding-window counters by key. */
export function rateLimiter(now = () => Date.now()) {
  const hits = new Map();
  const recent = (key, windowMs) => {
    const list = (hits.get(key) ?? []).filter((time) => now() - time < windowMs);
    hits.set(key, list);
    return list;
  };
  return {
    allowed: (key, limit, windowMs) => recent(key, windowMs).length < limit,
    note: (key) => recent(key, 60 * 60_000).push(now()),
  };
}

const HOUR = 60 * 60_000;
export const LIMITS = { accountsPerAddress: 3, requestsPerAddress: 20, requestWindowMs: 10 * 60_000, accountsOverall: 30 };

/**
 * `(address, body) → { status, body }`. `run(sql)` is {@link mysqlRunner}'s function (a fake in tests);
 * `log` gets one line per created account and per failure.
 */
export function createRegistrar({ run, limits = LIMITS, now, log = console.log }) {
  const limiter = rateLimiter(now);
  let queue = Promise.resolve();
  const handle = async (address, body) => {
    if (!limiter.allowed(`req:${address}`, limits.requestsPerAddress, limits.requestWindowMs)) return { status: 429, body: { error: "too-many" } };
    limiter.note(`req:${address}`);
    const account = validateRegistration(body);
    if (account.error) return { status: 400, body: { error: account.error } };
    if (!limiter.allowed(`acc:${address}`, limits.accountsPerAddress, HOUR) || !limiter.allowed("acc:*", limits.accountsOverall, HOUR)) {
      return { status: 429, body: { error: "too-many" } };
    }
    let result;
    try {
      result = await run(accountSql(account));
    } catch (error) {
      log(`Registration of ${account.username} failed: ${error.message}`);
      return { status: 503, body: { error: "unavailable" } };
    }
    if (result === "duplicate") return { status: 409, body: { error: "taken" } };
    limiter.note(`acc:${address}`);
    limiter.note("acc:*");
    log(`Registered account ${account.username} from ${address}`);
    return { status: 201, body: { ok: true, username: account.username } };
  };
  return (address, body) => {
    const next = queue.then(() => handle(address, body));
    queue = next.catch(() => undefined);
    return next;
  };
}

/** The registrar bat\32 uses: the auth database of the selected worldserver.conf. */
export async function authDatabaseRegistrar({ configPath, mysql }) {
  const db = loginDatabase(await readFile(configPath, "utf8"));
  return createRegistrar({ run: mysqlRunner({ mysql, db }) });
}
