import { game } from "../game/Context.js";
import { glueWorldNameFilters } from "../glue/GlueNameFilters.js";
import { mailTemplateClient } from "../MailTemplateClient.js";
import type { FrameXmlMailTextSource } from "./FrameXmlMailText.js";
import { frameXmlStockCVarValue } from "./FrameXmlStockCVarValues.js";

/**
 * 5.28 (15.11): GetInboxText's body sources over a live world (FrameXmlMailText.ts): the player's quest text parser,
 * the page's MailTemplate table (`/dbc/mail-templates`, asked at the first template letter), and the profanity filter
 * — the CVar `profanityFilter` read as the client reads a CVar's integer (a value that does not parse is 0), by the
 * stock CVar path (FrameXmlStockCVarValues.ts: the account slot's line, else the registered "1"), over the chat list
 * the glue built for the realm (GlueNameFilters.ts).
 */
export function frameXmlLiveMailTextSource(
  questText: (text: string) => string, cvar: (name: string) => string | undefined,
): FrameXmlMailTextSource {
  return {
    questText,
    templateBody: (id) => mailTemplateClient(game.gatewayOrigin)?.template(id)?.body,
    profanity: () => {
      const chat = glueWorldNameFilters()?.chat;
      if (!chat) return undefined;
      const value = Number.parseInt(cvar("profanityFilter") ?? frameXmlStockCVarValue("profanityFilter") ?? "0", 10);
      return { enabled: Number.isFinite(value) && value !== 0, chat };
    },
  };
}
