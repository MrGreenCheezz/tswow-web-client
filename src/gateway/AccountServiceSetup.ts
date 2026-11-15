/**
 * 10.30 (15.11): the account service the gateway starts with when `GATEWAY_ACCOUNTS=1` — the login database of
 * the selected worldserver.conf (`WORLDSERVER_CONF`, tools/paths.mjs) through tswow's bundled mysql client
 * (`MYSQL_BIN`), as tools/account-register.mjs reaches it. Off: undefined, and nothing is read.
 *
 * Review F4: `GATEWAY_ACCOUNTS_DB_USER` / `GATEWAY_ACCOUNTS_DB_PASSWORD` name a MySQL user with only the rights
 * these statements need (the grants are in the 10.30 report); empty, the conf's own user is used, as before.
 * Review F7h: with `*` in ALLOWED_ORIGINS any site could make its visitors register accounts, each from its own
 * address, so the service refuses to start then (one line in the log) and the routes say «disabled».
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseAccountRoutesEnv, parseReservedAccountNames } from "./AccountRoutes.js";
import { AccountSelfService } from "./AccountSelfService.js";
import { loginDatabase, mysqlCliRunner, type LoginDatabase } from "./AccountSql.js";

interface DatabasePaths {
  worldserverConf(): string;
  mysqlBinary(): string;
}

/** The conf's login database, with the dedicated user of `GATEWAY_ACCOUNTS_DB_USER` when one is set. */
export function accountDatabase(confDb: LoginDatabase, env: NodeJS.ProcessEnv): LoginDatabase {
  const user = env["GATEWAY_ACCOUNTS_DB_USER"]?.trim();
  return user ? { ...confDb, user, password: env["GATEWAY_ACCOUNTS_DB_PASSWORD"] ?? "" } : confDb;
}

export async function createAccountService(
  env: NodeJS.ProcessEnv, cwd: string, allowedOrigins: readonly string[], log: (line: string) => void = console.log,
): Promise<AccountSelfService | undefined> {
  if (!parseAccountRoutesEnv(env)) return undefined;
  if (allowedOrigins.includes("*")) {
    log("Account forms on the login screen: NOT started — ALLOWED_ORIGINS contains *, which would let any site register accounts");
    return undefined;
  }
  const paths = await import(pathToFileURL(resolve(cwd, "tools/paths.mjs")).href) as DatabasePaths;
  // A missing or unreadable config stops the start: the owner asked for the forms by name.
  const db = accountDatabase(loginDatabase(await readFile(paths.worldserverConf(), "utf8")), env);
  log("Account forms on the login screen: on (GATEWAY_ACCOUNTS=1), writing the auth database of WORLDSERVER_CONF");
  return new AccountSelfService({
    run: mysqlCliRunner({ mysql: paths.mysqlBinary(), db }),
    reserved: parseReservedAccountNames(env),
  });
}
