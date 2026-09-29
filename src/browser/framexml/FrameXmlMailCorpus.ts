import { normalizeGluePath, type GlueFileProvider } from "../glue/GlueLoader.js";

/**
 * MailFrame.xml's one dependency outside the vertical, served without loading its owner.
 *
 * The two mail tabs inherit `FriendsFrameTabTemplate` (MailFrame.xml:1259, :1273), which only
 * FriendsFrame.xml declares (stock TOC 101, MailFrame is 119). That template is
 * `CharacterFrameTabButtonTemplate` (CharacterFrameTemplates.xml, in the vertical) plus an OnClick
 * that both mail tabs replace with their own `MailFrameTab_OnClick`. Measured without it: the loader
 * drops both tabs («template "FriendsFrameTabTemplate" is not registered» ×2) and MailFrame_OnLoad
 * raises at PanelTemplates_SetTab («attempt to index a nil value (local 'tab')») before it registers
 * a single MAIL_* event. Loading FriendsFrame.xml instead costs +2 files and ~308 KB and puts the
 * social frame's handlers (PARTY_MEMBERS_CHANGED → FriendsList_Update over unbound friend APIs) in
 * the live world, so while the vertical does not carry FriendsFrame.xml the mail tabs name the base
 * template directly — the widget each tab becomes is identical. With FriendsFrame.xml in the subset,
 * MailFrame.xml is served untouched.
 */
const MAIL_FRAME_PATH = "interface/framexml/mailframe.xml";
const FRIENDS_TAB_TEMPLATE = /inherits="FriendsFrameTabTemplate"/g;

function hasEntry(entries: readonly string[], file: string): boolean {
  return entries.some((entry) => normalizeGluePath(entry).endsWith(file));
}

export function frameXmlMailCorpusSource(source: GlueFileProvider, entries: readonly string[]): GlueFileProvider {
  if (!hasEntry(entries, "mailframe.xml") || hasEntry(entries, "friendsframe.xml")) return source;
  return {
    async read(path: string): Promise<string | undefined> {
      const text = await source.read(path);
      return text !== undefined && normalizeGluePath(path) === MAIL_FRAME_PATH
        ? text.replace(FRIENDS_TAB_TEMPLATE, 'inherits="CharacterFrameTabButtonTemplate"')
        : text;
    },
  };
}
