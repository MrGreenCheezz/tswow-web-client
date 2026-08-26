import type { CustomOpcodeSummary, CustomPacketProblem } from "../../world/CustomPacketRegistry.js";
import type { CustomPacketWarning } from "../../world/CustomPacket.js";
import type { LoadedMessageFile } from "./ModuleLoader.js";

/**
 * What the «Пакеты» tab of the diagnostics window says, worked out without touching a document.
 *
 * The tab exists because a custom packet is the one thing in this client that has no other trace.
 * An ordinary opcode that goes unhandled is counted by name in the unhandled-opcode list; a module
 * message is counted there as `CMSG_EMOTE`, once, no matter which of a module's messages it was —
 * the number that matters is inside the body. So the counts, the last decoded value and the raw
 * bytes of anything unclaimed have to be shown here or nowhere.
 *
 * Everything is a string by the time it leaves this file, which is what makes it testable: the
 * rendering half (`PacketsTab.ts`) only appends nodes.
 */

/** How many characters of one formatted value are shown before it is cut. */
const VALUE_LIMIT = 220;
/** How many bytes of an unclaimed body are shown as hex. Two characters and a space each. */
const HEX_BYTES = 48;
/** Rows drawn at once. The registry keeps 64 opcodes; a window that long is not read. */
const ROW_LIMIT = 24;

export type PacketRowKind = "message" | "unclaimed" | "error";

export interface PacketRow {
  readonly opcode: number;
  /** `4001 · shop.State · shop · in`, or `4001 · схемы нет` for an opcode nobody declared. */
  readonly title: string;
  readonly counts: string;
  /** The last decoded value, the decode error, or the raw bytes as hex. */
  readonly body: string;
  readonly kind: PacketRowKind;
}

export interface PacketsView {
  readonly status: string;
  readonly statusKind: "muted" | "error" | "success";
  /** One line per loaded definition file, plus one per load problem. */
  readonly modules: string[];
  readonly rows: PacketRow[];
  /** Transport warnings and handler failures, newest last, already sentences. */
  readonly warnings: string[];
}

export interface PacketsInput {
  readonly opcodes: readonly CustomOpcodeSummary[];
  /** `CustomPacketReassembler.warnings`: reader skew, an abandoned tail, a replaced partial. */
  readonly transportWarnings: readonly CustomPacketWarning[];
  /** `CustomPacketRegistry.problems`: a decode that failed, a handler that threw. */
  readonly problems: readonly CustomPacketProblem[];
  readonly files: readonly LoadedMessageFile[];
  readonly loadProblems: readonly string[];
}

/**
 * The four numbers the pane was last drawn from.
 *
 * Everything the tab shows moves one of them: the registry's `revision` for a message, a counter, a
 * value or a wire problem, the reassembler's `warningCount` for a transport warning — a count and
 * not `warnings.length`, which stops growing at 32 — and the loader's two lists for a file that
 * loaded or refused to.
 */
export interface PacketsCounters {
  readonly revision: number;
  readonly warnings: number;
  readonly files: number;
  readonly problems: number;
}

/**
 * Whether the pane is out of date, asked once a frame while it is on screen.
 *
 * Redrawing unconditionally would rebuild two dozen blocks sixty times a second to show the same
 * numbers; redrawing only on the cue the pane used to have — the unhandled-opcode list changing —
 * showed the *first* packet and then stood still, because a message on an opcode a schema claims is
 * never filed as unhandled at all. Every number here only ever goes up, so "nothing moved" is a
 * fact rather than a guess.
 */
export function packetsChanged(drawn: PacketsCounters | undefined, now: PacketsCounters): boolean {
  return drawn === undefined || drawn.revision !== now.revision || drawn.warnings !== now.warnings
    || drawn.files !== now.files || drawn.problems !== now.problems;
}

/**
 * A decoded value as one line.
 *
 * Not `JSON.stringify`: `u64` and `i64` decode to `bigint` by design — 64 bits do not survive a
 * double, and the guid in a module's message is the case that motivated it — and `JSON.stringify`
 * answers a bigint with `TypeError: Do not know how to serialize a BigInt`. A diagnostics window
 * that throws while describing the packet it was opened to describe is worse than no window, so
 * the printer is written out. The `n` suffix is kept deliberately: it is the reader's only clue
 * that tswow's own Lua will see this field rounded (`ClientNetwork.lua:73-74`).
 */
export function formatCustomValue(value: unknown, depth = 0): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return value.length > 60 ? `"${value.slice(0, 60)}…"` : `"${value}"`;
  if (value instanceof Uint8Array) return formatHex(value);
  if (depth >= 3) return "…";
  if (Array.isArray(value)) {
    const shown = value.slice(0, 8).map((item) => formatCustomValue(item, depth + 1));
    if (value.length > 8) shown.push(`…ещё ${value.length - 8}`);
    return `[${shown.join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const shown = entries.slice(0, 12).map(([key, item]) => `${key}: ${formatCustomValue(item, depth + 1)}`);
    if (entries.length > 12) shown.push(`…ещё ${entries.length - 12}`);
    return `{${shown.join(", ")}}`;
  }
  return typeof value;
}

/** Raw bytes as spaced hex, cut at {@link HEX_BYTES} and saying how many were left out. */
export function formatHex(bytes: Uint8Array | string, limit = HEX_BYTES): string {
  const pairs = typeof bytes === "string"
    ? (bytes.match(/../g) ?? [])
    : [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
  const shown = pairs.slice(0, limit).join(" ");
  return pairs.length > limit ? `${shown} …ещё ${pairs.length - limit} Б` : shown;
}

function cut(text: string): string {
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text;
}

function counts(row: CustomOpcodeSummary): string {
  const parts: string[] = [];
  if (row.received) parts.push(`принято ${row.received} (${row.receivedBytes} Б)`);
  if (row.sent) parts.push(`отправлено ${row.sent} (${row.sentBytes} Б)`);
  if (row.decoded) parts.push(`разобрано ${row.decoded}`);
  if (row.failed) parts.push(`ошибок ${row.failed}`);
  // The tail past the last declared field is not an error — `CreateCustomPacket(op, size)`
  // preallocates and the preallocation becomes payload — but it is also exactly what a schema one
  // field behind its livescript looks like, so it is worth a number rather than silence.
  if (row.remainder) parts.push(`хвост ${row.remainder} Б`);
  return parts.join(" · ") || "тишина";
}

/** Everything the tab draws, in the order it draws it. */
export function packetsView(input: PacketsInput): PacketsView {
  const rows: PacketRow[] = [];
  for (const row of input.opcodes.slice(0, ROW_LIMIT)) {
    // `declared` and not `claimed`: the narrower question is «can anything decode an inbound
    // message here», which is false for a message this client only ever sends — and painting that
    // one in the no-schema colour, under a title that names its schema, said two opposite things
    // on one line.
    const kind: PacketRowKind = row.error ? "error" : row.declared ? "message" : "unclaimed";
    const title = row.name
      ? `${row.opcode} · ${row.name}${row.module ? ` · ${row.module}` : ""} · ${row.direction ?? "both"}`
      : `${row.opcode} · схемы нет`;
    const body = row.error
      ? row.error
      : row.value !== undefined
        ? cut(formatCustomValue(row.value))
        : row.samples.length
          ? formatHex(row.samples[row.samples.length - 1] ?? "")
          : "—";
    rows.push({ opcode: row.opcode, title, counts: counts(row), body, kind });
  }

  const modules = input.files
    .map((file) => `${file.module}/${file.file} · ${file.count} сообщ. · ${file.source} · ${file.sha1.slice(0, 8)}`)
    .concat(input.loadProblems);

  const warnings = [
    ...input.transportWarnings.map((warning) => warning.text),
    ...input.problems.map((problem) => problem.text),
  ];

  const unclaimed = input.opcodes.filter((row) => !row.declared && row.received > 0).length;
  const received = input.opcodes.reduce((total, row) => total + row.received, 0);
  const failed = input.opcodes.reduce((total, row) => total + row.failed, 0);
  const status = received === 0 && !input.files.length
    ? "Пакеты модулей: ни одной схемы и ни одного пакета."
    : `Пакеты модулей: ${input.files.length} файлов схем · опкодов ${input.opcodes.length}`
      + ` · принято ${received}${unclaimed ? ` · без схемы ${unclaimed}` : ""}${failed ? ` · ошибок ${failed}` : ""}`;
  const statusKind = failed || input.loadProblems.length ? "error" : received ? "success" : "muted";
  return { status, statusKind, modules, rows, warnings };
}
