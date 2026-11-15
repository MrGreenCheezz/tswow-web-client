// The mail templates (plan item 5.28): MailTemplate.dbc, served once per page as `/dbc/mail-templates?v=1`
// (CatalogRoutes.ts), for the stock MailFrame's GetInboxText (browser/framexml/FrameXmlMailText.ts).
//
// A letter the server builds from a template (a quest's RewardMailTemplateId, an achievement's reward, a holiday)
// arrives in SMSG_MAIL_LIST_RESULT with an empty body and its MailTemplate id. Wow.exe 3.3.5a 12340 GetInboxText
// (0x00570bd0, read-only Ghidra, .runtime/re-2026-11-11/api4/d1.c) then looks the id up in MailTemplate.dbc
// (0x0065c290, the table's row by id) and runs the row's body (+8) through the quest text parser (0x00579590) for the
// player; no row is a nil body.
//
// Not in the generated DBC_LAYOUTS; read as the file is (35 fields, 140 bytes): {ID, Subject_lang[17], Body_lang[17]}
// — TrinityCore does not load it. Measured on this dataset: 207 rows, the ruRU body slot filled, the subject empty in
// the rows looked at; bodies carry quest markers («Спасибо, что $gнавестил:навестила; меня $N.»).

import type { DbcLocale } from "../generated/dbcLayouts.js";
import { DEFAULT_LOCALE } from "./Dbc.js";
import { readFixed, type FixedRows } from "./DbcFixed.js";
import { fixedLocstring } from "./DungeonEncounterMetadata.js";

/** The route's shape; the browser asks `?v=` this and refuses another. */
export const MAIL_TEMPLATES_VERSION = 1;

export const MAIL_TEMPLATE_LAYOUT = Object.freeze({ fieldCount: 35, recordSize: 140 });
const ID_FIELD = 0;
const SUBJECT_FIELD = 1;
const BODY_FIELD = 18;

/** One row: `[id, subject, body]`, the client locale's strings (else enUS, else any filled slot). */
export type MailTemplateRow = [id: number, subject: string, body: string];

export interface MailTemplateCatalog {
  version: number;
  templates: MailTemplateRow[];
}

/** The catalog out of already-checked rows; pure, so a test can feed it a synthetic file. */
export function mailTemplateCatalog(rows: FixedRows, locale: DbcLocale = DEFAULT_LOCALE): MailTemplateCatalog {
  const templates: MailTemplateRow[] = [];
  for (let row = 0; row < rows.records; row++) {
    const id = rows.int(row, ID_FIELD);
    if (id <= 0) continue;
    templates.push([id, fixedLocstring(rows, row, SUBJECT_FIELD, locale), fixedLocstring(rows, row, BODY_FIELD, locale)]);
  }
  return { version: MAIL_TEMPLATES_VERSION, templates };
}

export async function loadMailTemplates(dbcDirectory: string): Promise<MailTemplateCatalog> {
  return mailTemplateCatalog(await readFixed(dbcDirectory, "MailTemplate", MAIL_TEMPLATE_LAYOUT));
}
