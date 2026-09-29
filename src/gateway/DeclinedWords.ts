// The ruRU client's declension dictionary, for the browser's `|3-N(word)` pass.
//
// FrameXmlDeclension.ts (ported from Wow.exe 12340) looks a word up in DeclinedWord.dbc +
// DeclinedWordCases.dbc before its rule engine, and the two tables are the only source of the
// special cases 6-10: `|3-6(Огонь)` is «урона от огня», `|3-8(Штормград)` «Штормград подвергается».
// Without them the browser declines by rules alone, which knows cases 1-5 and single words only.
//
// The files travel as they are, because the browser reads them with the client's own lookup
// (`frameXmlDeclinedWordsFromDbc`): one body holding DeclinedWord.dbc's length (uint32 LE), then
// DeclinedWord.dbc, then DeclinedWordCases.dbc. Measured on the tswow dataset: 29,426 words and
// 141,956 case rows, 1,313,560 + 6,734,878 bytes; gzip (level 6) takes the 8,048,442-byte body to
// 2,136,680 bytes in about 200 ms, done once per dataset and kept, so a request only writes a buffer.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { DbcError } from "./Dbc.js";

const gzipAsync = promisify(gzip);

export interface DeclinedWordsBody {
  /** The body as it goes out uncompressed. */
  readonly raw: Buffer;
  /** The same body gzipped, for a request that accepts it. */
  readonly gzip: Buffer;
  /** A validator over the uncompressed body; weak, because both encodings answer to it. */
  readonly etag: string;
}

async function readTable(dbcDirectory: string, table: string, fields: number): Promise<Buffer> {
  let data: Buffer;
  try {
    data = await readFile(join(dbcDirectory, `${table}.dbc`));
  } catch (error) {
    throw new DbcError(`${table}.dbc could not be read from ${dbcDirectory}: ${(error as Error).message}`);
  }
  if (data.byteLength < 20 || data.subarray(0, 4).toString("latin1") !== "WDBC") {
    throw new DbcError(`${table}.dbc: not a WDBC file`);
  }
  const records = data.readUInt32LE(4);
  const fieldCount = data.readUInt32LE(8);
  const recordSize = data.readUInt32LE(12);
  const strings = data.readUInt32LE(16);
  if (fieldCount !== fields || recordSize !== fields * 4) {
    throw new DbcError(`${table}.dbc has ${fieldCount} fields of ${recordSize} bytes; 3.3.5a has ${fields} of ${fields * 4}`);
  }
  if (20 + records * recordSize + strings !== data.byteLength) {
    throw new DbcError(`${table}.dbc: the string block does not reach the end of the file`);
  }
  return data;
}

/** Reads and packs both tables once; Gateway keeps the result per dataset. */
export async function loadDeclinedWords(dbcDirectory: string): Promise<DeclinedWordsBody> {
  // `DeclinedWord`: ID, Word. `DeclinedWordCases`: ID, WordID, CaseIndex, DeclinedWord.
  const [words, cases] = await Promise.all([
    readTable(dbcDirectory, "DeclinedWord", 2),
    readTable(dbcDirectory, "DeclinedWordCases", 4),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(words.byteLength, 0);
  const raw = Buffer.concat([length, words, cases]);
  const etag = `W/"${createHash("sha1").update(raw).digest("hex")}"`;
  return { raw, gzip: await gzipAsync(raw), etag };
}
