/**
 * 10.30 (15.11): the query layer of the account routes (AccountSelfService.ts) — how the gateway reaches
 * the `auth` database, and the only thing a test replaces.
 *
 * The way in is the one `tools/account-register.mjs` and the generators already use: tswow's bundled
 * `mysql` client, with the login database named by `LoginDatabaseInfo` of the selected worldserver.conf
 * and the password in the child's environment (MYSQL_PWD), not on its command line. No driver is added.
 *
 * Every statement is parameterised. The command-line client has no parameter binding of its own, so the
 * statement text — always a constant of AccountSelfService.ts — is prepared server-side
 * (`PREPARE … FROM '<text with ?>'`) and executed `USING` user variables, and each value reaches its
 * variable as a hexadecimal literal (`X'…'`) or a checked integer: the script carries no character of
 * the value itself, so nothing a player sends can end a string or start a statement. The script goes in
 * through stdin. A failure is reported by its MySQL error number only; the client's error text (which
 * can quote the value, e.g. «Duplicate entry 'NAME'») is never passed on.
 */

import { spawn } from "node:child_process";

export type SqlParam = string | Uint8Array | number;

export interface SqlStatement {
  /** A constant of the calling module, with `?` for every value. */
  readonly text: string;
  readonly params: readonly SqlParam[];
  /** The statement whose execution may commit (a COMMIT, an autocommitted write): a run that ends from here on is `uncertain`. */
  readonly commitPoint?: boolean;
}

export type SqlOutcome =
  | { readonly ok: true; readonly rows: readonly (readonly string[])[] }
  /** `uncertain`: the run ended (timeout, lost connection, any error) at or after the commit point, so the write may have happened. */
  | { readonly ok: false; readonly errno: number | undefined; readonly uncertain?: boolean };

/**
 * Second-look S3: printed (`--unbuffered`) just before a `commitPoint` statement, so the runner knows whether the client
 * got that far. Without it a run ended before the point wrote nothing: an unfinished transaction rolls back.
 */
export const COMMIT_POINT_MARKER = "webclient:commit-point";

/** Runs the statements in order in one session; the rows of every SELECT, tab-separated columns. */
export type SqlRunner = (statements: readonly SqlStatement[]) => Promise<SqlOutcome>;

/** MySQL's duplicate-key error (ER_DUP_ENTRY): the unique `idx_username` of `account`. */
export const MYSQL_DUPLICATE_ENTRY = 1062;

/** One value as the literal its user variable is set from: hex for text and bytes, digits for a safe integer. */
export function sqlParamLiteral(value: SqlParam): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError("SQL integer parameter out of range");
    return String(value);
  }
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `X'${hex}'`;
}

function placeholders(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

/** The script the client is fed: statements without values as they are, the others prepared. */
export function mysqlScript(statements: readonly SqlStatement[]): string {
  const lines: string[] = [];
  statements.forEach((statement, index) => {
    if (statement.text.includes(";")) throw new Error("one statement per SqlStatement");
    if (placeholders(statement.text) !== statement.params.length) throw new Error("placeholder count does not match the parameters");
    if (statement.commitPoint) lines.push(`SELECT '${COMMIT_POINT_MARKER}';`);
    if (statement.params.length === 0) {
      lines.push(`${statement.text};`);
      return;
    }
    const names = statement.params.map((_, param) => `@webclient_${index}_${param}`);
    statement.params.forEach((param, at) => lines.push(`SET ${names[at]} = ${sqlParamLiteral(param)};`));
    // The text is a constant; quoting it for PREPARE only has to survive its own quotes.
    lines.push(`PREPARE webclient_statement FROM '${statement.text.replaceAll("\\", "\\\\").replaceAll("'", "''")}';`);
    // No DEALLOCATE: a later PREPARE of the same name replaces it, the session's end frees it, and a
    // `SELECT ROW_COUNT()` right after the EXECUTE must see the EXECUTE's count (review F3).
    lines.push(`EXECUTE webclient_statement USING ${names.join(", ")};`);
  });
  return `${lines.join("\n")}\n`;
}

/** `LoginDatabaseInfo = "host;port;user;password;database"` of worldserver.conf. */
export interface LoginDatabase {
  readonly host: string;
  readonly port: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export function loginDatabase(configText: string): LoginDatabase {
  const match = configText.match(/^LoginDatabaseInfo\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) throw new Error("LoginDatabaseInfo is missing in worldserver.conf");
  const [host, port, user, password, database] = match[1].split(";");
  if (!host || !port || !user || password === undefined || !database) throw new Error("LoginDatabaseInfo is invalid");
  return { host, port, user, password, database };
}

/** `mysql --batch` output: one row per line, columns split on tabs. */
export function parseBatchRows(stdout: string): string[][] {
  return stdout.split(/\r?\n/).filter((line) => line.length > 0).map((line) => line.split("\t"));
}

const OUTPUT_LIMIT = 1 << 20;

/** The real runner: one `mysql` child per call, the script on stdin. Never used by the tests. */
export function mysqlCliRunner(options: { readonly mysql: string; readonly db: LoginDatabase; readonly timeoutMs?: number }): SqlRunner {
  const { mysql, db } = options;
  return (statements) => new Promise((resolve, reject) => {
    let script: string;
    try {
      script = mysqlScript(statements);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // `--no-defaults` first: no my.ini/my.cnf may add options such as `force` (review F7c).
    const child = spawn(mysql, [
      "--no-defaults", `--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`, `--database=${db.database}`,
      "--default-character-set=utf8", "--batch", "--skip-column-names", "--unbuffered",
    ], { env: { ...process.env, MYSQL_PWD: db.password }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    // A killed client drops its connection, and the server rolls back a transaction that was not committed. Whether
    // the run reached its commit point is the marker on stdout: from there on the outcome is unknown (review F7a).
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs ?? 15_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`mysql client did not start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const rows = parseBatchRows(stdout);
      const reached = rows.some((row) => row.length === 1 && row[0] === COMMIT_POINT_MARKER);
      if (code === 0 && !timedOut) {
        resolve({ ok: true, rows: rows.filter((row) => !(row.length === 1 && row[0] === COMMIT_POINT_MARKER)) });
        return;
      }
      const errno = timedOut ? undefined : /ERROR (\d+)/.exec(stderr)?.[1];
      resolve({ ok: false, errno: errno === undefined ? undefined : Number(errno), ...(reached ? { uncertain: true } : {}) });
    });
    child.stdin.on("error", () => { /* a child that died early is reported by `close` */ });
    child.stdin.end(script);
  });
}
