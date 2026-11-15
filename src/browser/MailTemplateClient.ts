import { RetryingCatalogClient, type RetryingCatalogOptions } from "./CatalogClient.js";

/**
 * 5.28 (15.11): the mail templates (`/dbc/mail-templates`, gateway/MailTemplateMetadata.ts) — the body GetInboxText
 * gives a letter the server built from a MailTemplate (an empty body and a template id, Wow.exe 0x00570bd0). Asked
 * at the first read; until it lands such a letter's body is nil, as a template id with no row is in the client.
 */

/** gateway/MailTemplateMetadata.ts `MAIL_TEMPLATES_VERSION`; tests/framexml-mail-text.test.mjs pins the two together. */
export const MAIL_TEMPLATES_ROUTE_VERSION = 1;
export const MAIL_TEMPLATES_ROUTE_PATH = `/dbc/mail-templates?v=${MAIL_TEMPLATES_ROUTE_VERSION}`;

export interface MailTemplate {
  readonly subject: string;
  readonly body: string;
}

/** Validate a route answer into id → template; undefined when its shape is not the route's. */
export function mailTemplateTableFrom(data: unknown, version = MAIL_TEMPLATES_ROUTE_VERSION): ReadonlyMap<number, MailTemplate> | undefined {
  if (!data || typeof data !== "object") return undefined;
  const value = data as { version?: unknown; templates?: unknown };
  if (value.version !== version || !Array.isArray(value.templates)) return undefined;
  const table = new Map<number, MailTemplate>();
  for (const row of value.templates as unknown[]) {
    if (!Array.isArray(row) || row.length !== 3) return undefined;
    const [id, subject, body] = row as unknown[];
    if (!Number.isSafeInteger(id) || typeof subject !== "string" || typeof body !== "string") return undefined;
    table.set(id as number, Object.freeze({ subject, body }));
  }
  return table;
}

export class MailTemplateClient {
  readonly origin: string;
  readonly #catalog: RetryingCatalogClient<ReadonlyMap<number, MailTemplate>>;

  constructor(gatewayOrigin: string, options: RetryingCatalogOptions = {}) {
    this.origin = gatewayOrigin;
    this.#catalog = new RetryingCatalogClient(gatewayOrigin, MAIL_TEMPLATES_ROUTE_PATH, (data) => mailTemplateTableFrom(data), options);
  }

  /** A template by id; undefined until the table lands (starting the first cycle) or for an id with no row. */
  template(id: number): MailTemplate | undefined {
    const table = this.#catalog.value;
    if (table) return table.get(id);
    void this.#catalog.load();
    return undefined;
  }
}

let current: MailTemplateClient | undefined;

/** The page's one template table for this gateway origin. */
export function mailTemplateClient(gatewayOrigin: string | undefined): MailTemplateClient | undefined {
  if (!gatewayOrigin) return undefined;
  if (current?.origin !== gatewayOrigin) current = new MailTemplateClient(gatewayOrigin);
  return current;
}
