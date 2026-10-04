/**
 * L7 4.16b + 3.32: `ActionBarAccountSync` over one world, this page's settings and its storage.
 * `app/EnterWorld.ts` calls `attachActionBarAccount` once the per-character slots are asked for and
 * tracks the returned disposer with the rest of the world's lifecycle.
 */

import type { WorldClient } from "../../world/WorldClient.js";
import { EXTRA_ACTION_BARS } from "../../world/ActionBarProtocol.js";
import { readByte, unit } from "../../world/Fields.js"; // L7-review: unit.classId
import { PER_CHARACTER_CONFIG_CACHE } from "../../world/SessionProtocol.js";
import { frameXmlFlagEnabled } from "../framexml/FrameXmlWorldPolicy.js";
import { EXTRA_BAR_SETTINGS, setExtraBarVisibility, showActionBar } from "./ActionBar.js";
import { ActionBarAccountSync } from "./ActionBarAccountSync.js";
import {
  classifyConfigSlot, decodeLayoutRecord, encodeLayoutRecord, extraBarBits,
} from "./ActionBarStockLayout.js";
import { notice } from "./Notices.js";
import { applySettings, drawSettings, settingOn, settingsStore, watchSettingsApplied } from "./Settings.js";
import { parseSettings, settingNumber, type SettingValues } from "./SettingsModel.js";

/** The per-browser record: `{ "<realm>/<guid>": mask }`. */
const LOCAL_RECORD_KEY = "webclient.actionbar-stock-layout.v1";
const RECORD_SETTING = "actionBarStockLayout";

function readLocalRecords(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(window.localStorage?.getItem(LOCAL_RECORD_KEY) ?? "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, number> : {};
  } catch {
    return {};
  }
}

export function attachActionBarAccount(world: WorldClient): () => void {
  const guidCounter = (): number => Number((world.state.selfGuid ?? 0n) & 0xffff_ffffn);
  const localKey = (): string => `${world.realmName ?? ""}/${guidCounter()}`;
  const serverBits = (): number | undefined => {
    const guid = world.state.selfGuid;
    const self = guid === undefined ? undefined : world.state.objects.get(guid);
    const byte = self ? readByte(self, "PLAYER_FIELD_BYTES", 2) : undefined;
    return byte === undefined ? undefined : byte & 0x0f;
  };
  // L7-review: the class decides which old pages are its stance, form or stealth bars (never moved).
  const playerClass = (): number | undefined => {
    const guid = world.state.selfGuid;
    const self = guid === undefined ? undefined : world.state.objects.get(guid);
    const value = self ? unit.classId(self) : undefined;
    return value === undefined || value === 0 ? undefined : value;
  };
  const sync = new ActionBarAccountSync({
    world,
    serverBits,
    talentGroup: () => world.talents?.activeSpec,
    playerClass, // L7-review
    nativeHud: () => !frameXmlFlagEnabled(window.location.search, settingOn("originalFrameXml")),
    settingsBits: () => extraBarBits((bar) => settingOn(EXTRA_BAR_SETTINGS[bar])),
    configSlot: () => {
      const text = world.accountData.get(PER_CHARACTER_CONFIG_CACHE)?.text;
      const parsed = text ? parseSettings(text) : undefined;
      const kind = classifyConfigSlot(text, () => parsed !== undefined);
      return { kind, record: parsed ? decodeLayoutRecord(settingNumber(parsed, RECORD_SETTING), guidCounter()) : 0 };
    },
    writeSettings: (bits, record) => {
      const next: SettingValues = { ...settingsStore.value, [RECORD_SETTING]: encodeLayoutRecord(guidCounter(), record) };
      if (bits !== undefined) {
        EXTRA_ACTION_BARS.forEach((bar, index) => { next[EXTRA_BAR_SETTINGS[bar.id]] = (bits & (1 << index)) !== 0; });
      }
      settingsStore.set(next);
      if (bits === undefined) return;
      applySettings();
      drawSettings();
    },
    localRecord: () => {
      const value = readLocalRecords()[localKey()];
      return typeof value === "number" && Number.isInteger(value) ? value & 0x0f : 0;
    },
    writeLocalRecord: (record) => {
      try {
        window.localStorage?.setItem(LOCAL_RECORD_KEY, JSON.stringify({ ...readLocalRecords(), [localKey()]: record & 0x0f }));
      } catch {
        // A blocked store leaves the server's record; the move itself never overwrites anything.
      }
    },
    onMigrated: (count) => notice(`Кнопки дополнительных панелей перенесены на слоты стандартного интерфейса: ${count}.`, "info"),
    redraw: showActionBar,
  });
  // The core sends the player's own object before it answers the slot (HandlePlayerLogin runs whole
  // before the request is read), so the byte is normally there; should it not be, the run is retried
  // twice a second for ten seconds rather than left for an event that may not come.
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retries = 0;
  const retryUntilFields = (): void => {
    retryTimer = undefined;
    if (!sync.waiting) return;
    if (serverBits() !== undefined) {
      sync.retry();
      return;
    }
    if (retries++ < 20) retryTimer = setTimeout(retryUntilFields, 500);
  };
  const disposers = [
    world.events.on("ACCOUNT_DATA_CHANGED", (change) => {
      if (change.type !== PER_CHARACTER_CONFIG_CACHE) return;
      sync.configAnswered();
      retryUntilFields();
    }),
    world.events.on("ACTION_BUTTONS_CHANGED", () => sync.buttonsChanged()),
    watchSettingsApplied(() => sync.settingsApplied()),
  ];
  setExtraBarVisibility(() => sync.visibleBits());
  return () => {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    for (const dispose of disposers) dispose();
    setExtraBarVisibility(undefined);
  };
}
