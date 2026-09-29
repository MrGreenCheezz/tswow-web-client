// The one back-edge in `app/`: `Login.ts` imports `enterWorld` from here and this imports the way
// out from there. It is safe because `leaveWorld` is a hoisted function declaration and is only
// ever called from a world event, long after both modules have finished evaluating — and it is the
// right side of the cycle, because the way out ends in `connectRealm`, which lives there.
import { leaveWorld } from "./Login.js";
import { formatMoney } from "../ui/Format.js";
import { EMOTE_ANIMATIONS } from "../../generated/animations.js";
import { CharacterSummary } from "../../world/CharacterProtocol.js";
import type { WorldEvents, WorldPacketEvents } from "../../world/EventBus.js";
import { unit } from "../../world/Fields.js";
import { game } from "../game/Context.js";
import { clearFocusOn } from "../game/Targeting.js";
import {
  characterModel, characterStatus, characterWindowTitle, combatStatus, creatureStatus, environmentStatus, gatewayInput,
  modelStatus, movementStatus, playerHudName, spellStatus, terrainStatus, worldPanel, worldStatus,
} from "../ui/Dom.js";
import { clearSpellbook, loadSpellMetadata, showSpells, updateSpellCooldowns } from "../ui/Spellbook.js";
import { showTarget } from "../ui/Frames.js";
import { bossDisengaged, bossEngaged, forgetUnitFrames, showUnitFrames } from "../ui/UnitFrames.js";
import { applyPortraitVisibility, clearPortraitTargets, mountNativeCharacterPortrait } from "../ui/Portraits.js";
import { ENCOUNTER_FRAME_DISENGAGE, ENCOUNTER_FRAME_ENGAGE } from "../../world/InstanceProtocol.js";
import { queueWorldState, showWorldState } from "../ui/WorldView.js";
import { queueFrameTask } from "../../transport/PacketPump.js";
import { ENVIRONMENT_NAMES, logSwing, pushCombatLine, showSwingWarning } from "../ui/CombatLog.js";
import { loadAuraMetadata, showAuras } from "../ui/Auras.js";
import {
  showBattlegroundList, showDeath, showGossip, showLoot, showQuestState, showTabardVendor,
  showTaxiMenu, showTrainer, showVendor,
} from "../ui/Npc.js";
import { itemMetadataChanged, showItemMessage } from "../ui/Bags.js";
import { ensureSpellNames } from "../ui/SpellNames.js";
import { showBank } from "../ui/Bank.js";
import { addMinimapPing, forgetMinimap } from "../ui/Minimap.js";
import { showWorldMap } from "../ui/WorldMap.js";
import { showTracking } from "../ui/Tracking.js";
import { showEquipmentSets } from "../ui/EquipmentSets.js";
import { showAuctions, showDuel, showGroup, showLfg, showMail, showTrade } from "../ui/Social.js";
import { resetGuildWindow, showGuild } from "../ui/Guild.js";
import { resetGuildBank, showGuildBank } from "../ui/GuildBank.js";
import { refreshCalendar, resetCalendar, showCalendar } from "../ui/Calendar.js";
import { refreshSocialNames, resetSocialPanel, showSocialPanel } from "../ui/SocialPanel.js";
import { resetScoreboard, scoreboardOpen, showScoreboard } from "../ui/Scoreboard.js";
import { resetGmTickets } from "../ui/GmTickets.js";
import { resetPetition, showPetition } from "../ui/Petition.js";
import { resetArenaWindow, showArenaWindow } from "../ui/ArenaWindow.js";
import { noticeLootRoll, resetLootRolls, showLootRolls } from "../ui/LootRolls.js";
import { resetReadyCheck, showReadyCheck } from "../ui/ReadyCheck.js";
import { resetInteractionPrompts, showInteractionPrompts } from "../ui/InteractionPrompts.js";
import {
  appendChatMessage, recordCombatEntry, redrawChatLog, refreshChatNames, resetChatDock, syncChannelTabs,
} from "../ui/ChatDock.js";
import { resetHeadOverlay, showChatBubble, showFloatingText } from "../ui/HeadOverlay.js";
import { notePlateHit } from "../ui/OverlayModel.js";
import { clearSpellNames } from "../ui/SpellNames.js";
import { notice, resetNotices } from "../ui/Notices.js";
import { updateLogoutPending } from "../ui/GameMenu.js";
import { beginModuleCommandLoad, systemLine } from "../ui/Chat.js";
import { applySettings, drawSettings, settingOn, settingsStore, watchSettingsApplied } from "../ui/Settings.js";
import { macroStores, resetMacroWindow, showMacros } from "../ui/Macros.js";
import { resetPetBar, showPetBar } from "../ui/PetBar.js";
import { resetTotems } from "../ui/Totems.js";
import { resetAutoQuality } from "../AutoQuality.js";
import { maybeShowWelcomeHints } from "../ui/WelcomeHints.js";
import { hideLoadingScreen, resetLoadingScreen, showLoadingScreen } from "../ui/LoadingScreen.js";
import { resetDeathScreenEffect } from "../ui/DeathScreenEffect.js";
import { watchMinimapRotation } from "../ui/Minimap.js";
import { chatClass } from "../ui/ChatFormat.js";
import { EmoteClient } from "../EmoteClient.js";
import {
  CHAT_MSG_EMOTE, CHAT_MSG_MONSTER_EMOTE, CHAT_MSG_MONSTER_SAY, CHAT_MSG_MONSTER_YELL, CHAT_MSG_SAY,
  CHAT_MSG_TEXT_EMOTE, CHAT_MSG_YELL,
  type TextEmote,
} from "../../world/ChatProtocol.js";
import { emoteSoundId } from "../../world/EmoteRules.js";
import { EnvironmentClient, TerrainClient } from "../Terrain.js";
import { TerrainSplatClient } from "../TerrainSplat.js";
import { GroundCoverClient } from "../GroundCover.js";
import { LightClient } from "../LightClient.js";
import { LiquidTextureClient } from "../Water.js";
import { SpellMetadataClient } from "../SpellMetadata.js";
import { SpellVisualClient, SpellVisualKitClient } from "../SpellVisualClient.js";
import { spellVisualKitPaths } from "../SpellVisuals.js";
import { SpellVisualCoordinator } from "../SpellVisualLifecycle.js";
import { CreatureMetadataClient } from "../CreatureMetadata.js";
import { GameObjectMetadataClient } from "../GameObjectMetadata.js";
import { TransportPathClient } from "../TransportPath.js";
import { HorizonClient } from "../Horizon.js";
import { CreatureModelClient } from "../CreatureModelClient.js";
import { ItemMetadataClient } from "../ItemMetadata.js";
import { LockClient } from "../LockClient.js";
import { FactionClient } from "../FactionClient.js";
import { TalentClient } from "../TalentClient.js";
import { BarberClient } from "../BarberClient.js";
import { SlotPriceClient } from "../SlotPriceClient.js";
import { VendorCostClient } from "../VendorCostClient.js";
import { AreaClient } from "../AreaClient.js";
import { MinimapTileClient } from "../MinimapTiles.js";
import { SoundClient } from "../SoundClient.js";
import { SoundPlayer } from "../Sound.js";
import { forgetZoneSound } from "../game/ZoneSound.js";
import {
  forgetGameSounds, playCreatureSound, playKit, playUiSound, retryPendingSounds,
} from "../game/GameSounds.js";
import { forgetCombatSounds, playSwingSounds, spellCombatVoices } from "../game/CombatSounds.js";
import { applySoundVolumes } from "../ui/Settings.js";
import { TextureBitmapCache } from "../TextureBitmaps.js";
import { ASSET_WARMUP_BUDGET, SessionAssetWarmup, loadedVisualWarmPaths } from "../AssetWarmup.js";
import { showTalents } from "../ui/Talents.js";
import { resetBarberShop, showBarberShop } from "../ui/BarberShop.js";
import { channelRosterOpen, resetChannelRoster, showChannelRoster } from "../ui/ChannelRoster.js";
import { showProfessions, professionCastStatus } from "../ui/Professions.js";
import { closeSocketing } from "../ui/Socketing.js";
import { CollisionSource } from "../game/CollisionSource.js";
import { clearHeldKeys } from "../input/Controls.js";
import { isAutoRunning, isWalking } from "../input/Movement.js";
import { showUnhandledOpcodes } from "../ui/Diagnostics.js";
import { createModuleLoader } from "../ui/ModuleClient.js";
import { showActionBar } from "../ui/ActionBar.js";
import { upgradeActionBarRanks } from "../ui/ActionBar.js";
import {
  bindQuestLogStore, clearQuestLog, requestMissingQuestTemplates, requestQuestPoi, showQuestLog,
  showQuestTracker,
} from "../ui/QuestLog.js";
import { showCharacterCollections, showCharacterSheet } from "../ui/CharacterSheet.js";
import { clearReputation, showReputation } from "../ui/Reputation.js";
import { showCharacterWindow } from "../ui/Windows.js";
import { frameXmlFlagEnabled } from "../framexml/FrameXmlWorldPolicy.js";
import { FrameXmlModeController } from "../framexml/FrameXmlModeController.js";
import { installNativeWowUiSkin } from "../ui/NativeUiSkin.js";
import { frameXmlMerchantOpen, notifyFrameXmlMerchant } from "../framexml/FrameXmlMerchantController.js";
import { frameXmlTrainerOpen, notifyFrameXmlTrainer } from "../framexml/FrameXmlTrainerController.js";
import { frameXmlStablePublished } from "../framexml/FrameXmlStableController.js";
import {
  notifyFrameXmlQuestGiver, notifyFrameXmlQuestGiverItemUpdate,
} from "../framexml/FrameXmlQuestGiverController.js";
import { createFrameXmlMerchantMetadataCoordinator } from "../framexml/FrameXmlMerchantMetadata.js";
import { WorldEntryLifecycle } from "./WorldEntryLifecycle.js";
/**
 * Entering the world: the login handshake for a chosen character, the asset clients that realm
 * needs, and the couple of dozen callbacks that connect the world client to the panels.
 *
 * This lived inside a click handler inside a loop inside `showCharacters`, four levels deep in a
 * file that also owned the render loop. It is the widest wiring in the client and it deserves its
 * own file to be read in.
 */

/**
 * How long a state emote holds when nothing interrupts it.
 *
 * Nothing on the wire ever says a dance ended: the server sends the emote once and the original
 * client keeps the pose until the character moves, which is what cancels it here too. This is only
 * a ceiling, so a unit that dances out of sight is not still dancing when it comes back.
 */
const EMOTE_STATE_HOLD = 600_000;

/** A text-emote sound may wait for the media table and kit, but never indefinitely. */
const EMOTE_SOUND_WAIT = 1_200;

/** What the original client puts in a bubble over a head: speech and emotes, not channels. */
const BUBBLE_TYPES: ReadonlySet<number> = new Set([
  CHAT_MSG_SAY, CHAT_MSG_YELL, CHAT_MSG_EMOTE, CHAT_MSG_TEXT_EMOTE,
  CHAT_MSG_MONSTER_SAY, CHAT_MSG_MONSTER_YELL, CHAT_MSG_MONSTER_EMOTE,
]);

/**
 * The archive path a visual placement carries, reduced to the file the collision route serves.
 *
 * Case is not this function's business any more. The extractor writes `Stormwind.wmo.vmo` and the
 * placement says `STORMWIND.WMO`; `CollisionClient.model` folds the second onto the first — the
 * spelling the `.vmtile` uses, which is the file's own — so the renderer's water probe and the
 * collision source share one download of the city rather than making two, and the probe no longer
 * depends on the gateway's disk ignoring case.
 */
function collisionModelName(name: string): string {
  const cut = Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/"));
  return cut >= 0 ? name.slice(cut + 1) : name;
}

/**
 * A combat line with the spell's real name in it.
 *
 * `WorldClient` writes «заклинание 133» because the spell table is a browser-side fetch and the
 * protocol layer has no business knowing about it. The name is put back here, where it is known.
 */
function spellLine(text: string, spellId: number): string {
  if (spellId <= 0) return text;
  const name = game.spells.get(spellId)?.name;
  return name ? text.replace(`заклинание ${spellId}`, name) : text;
}

/**
 * The current character's packet/store subscriptions. Retired on world exit and before another
 * character enters, so neither the old event bus nor an in-flight login can repaint a new world.
 *
 * The realm connection can outlive a character. An array cleared only at the next entry kept the
 * previous WorldClient and its closures alive throughout character selection or logout.
 */
const entryLifecycle = new WorldEntryLifecycle();

/** Stop the old character's callbacks before resetting its store and panels. */
export function retireEnterWorldSession(): void {
  entryLifecycle.retire();
}

export async function enterWorld(character: CharacterSummary, onBusy?: HTMLButtonElement): Promise<void> {
  if (!game.world) return;
  const world = game.world;
  const savedVariablesScope = game.session && world.realmName ? {
    account: game.session.username,
    realm: JSON.stringify([new URL(gatewayInput.value.replace(/^ws/, "http")).origin, world.realmName]),
    character: character.guid.toString(),
  } : undefined;
  // Session-scoped: changing this switch takes effect on the next world entry, before either
  // custom UI loader starts. Both loaders stay idle by default for addon-free comparison runs.
  const tswowAddonsEnabled = settingOn("tswowAddons");
  const generation = entryLifecycle.begin();
  // Session-scoped subscribes: identical to `world.events.on` / `game.store?.events.on`, except
  // each unsubscribe is recorded for world exit or the next character. Function
  // declarations, so the seventy call sites below read exactly as before.
  function onWorldEvent<Name extends keyof WorldPacketEvents>(
    name: Name, listener: (payload: WorldPacketEvents[Name]) => void,
  ): void {
    // Local alias, not a recursive call: the bus method itself, recorded for the next session.
    const bus = world.events;
    entryLifecycle.track(bus.on(name, listener));
  }
  function onStoreEvent<Name extends keyof WorldEvents>(
    name: Name, listener: (payload: WorldEvents[Name]) => void,
  ): void {
    const bus = game.store?.events;
    if (!bus) return;
    entryLifecycle.track(bus.on(name, listener));
  }
  clearQuestLog();
  // WorldStore coalesces all changed quest words into one event per frame. The
  // QuestLog module owns this one binding and replaces its previous one here,
  // so a character switch cannot leave a stale redraw listener behind.
  bindQuestLogStore(game.store, world);
  if (onBusy) onBusy.disabled = true;
  characterStatus.textContent = `Вход персонажем ${character.name}…`;
  // A text emote names its target by name rather than by GUID, so the only way to tell «машет
  // рукой вам» from «машет рукой кому-то» is to know what this character is called.
  world.selfName = character.name;
  resetChatDock();
  resetHeadOverlay();
  clearSpellNames();
  resetNotices();
  resetMacroWindow();
  resetPetBar();
  resetLoadingScreen();
  // The realm connection outlives a character, and so does the store subscription that drives the
  // death layer — so entering the world on a second character has to drop the first one's grey
  // rather than wait for an update block to contradict it.
  resetDeathScreenEffect();
  // Up before anything is fetched, because the world panel is about to cover the login screen and
  // there is nothing behind it yet.
  showLoadingScreen(character.name, "Настройки и макросы этого персонажа загружаются с сервера.",
    { mapId: character.map, gateway: gatewayInput.value });
  resetGuildWindow();
  resetGuildBank();
  resetCalendar();
  closeSocketing();
  resetSocialPanel();
  resetScoreboard();
  clearReputation();
  resetGmTickets();
  resetPetition();
  resetArenaWindow();
  resetLootRolls();
  resetReadyCheck();
  resetInteractionPrompts();
  resetBarberShop();
  resetTotems();
  resetChannelRoster();
  resetAutoQuality();
  // First session in this browser only: three info toasts over the fresh world, never again.
  maybeShowWelcomeHints();
  playerHudName.textContent = character.name;
  characterWindowTitle.textContent = character.name;
  worldPanel.hidden = false;
  document.body.classList.add("world-active");
  worldStatus.className = "";
  worldStatus.textContent = "Ожидание SMSG_LOGIN_VERIFY_WORLD…";
  movementStatus.textContent = "Movement: ожидание active mover…";
  terrainStatus.textContent = "Terrain: ожидание карты…";
  environmentStatus.className = "muted";
  environmentStatus.textContent = "Environment: ожидание VMAP…";
  creatureStatus.className = "muted";
  creatureStatus.textContent = "Creature data: ожидание объектов…";
  combatStatus.className = "muted";
  combatStatus.textContent = "Кликни по существу в сцене или выбери его в списке.";
  spellStatus.className = "muted";
  spellStatus.textContent = "Ожидание SMSG_INITIAL_SPELLS…";
  clearSpellbook();
  showTarget();
  // Bind visual ownership before the login handshake: the first SPELL_GO, cast start or aura
  // can arrive in the same batch as LOGIN_VERIFY_WORLD and must be replayed when its metadata
  // fetch completes rather than waiting for a second cast.
  game.spellVisualCoordinator?.clear();
  const spellVisuals = new SpellVisualClient(gatewayInput.value);
  /**
   * The kit route, on the same engine and with its own queue.
   *
   * Deliberately a local rather than another field on `game`: nothing outside this closure asks a
   * question by kit id, its lifetime is exactly the coordinator's, and the coordinator holds the
   * only reference that matters. The failure path below detaches its callback beside its sibling's.
   */
  const spellVisualKits = new SpellVisualKitClient(gatewayInput.value);
  const spellVisualCoordinator = new SpellVisualCoordinator({
    metadata: spellVisuals,
    kitMetadata: spellVisualKits,
    renderer: () => game.renderer,
    playSound: (soundId, at, guard) => {
      if (!game.sound || !game.soundKits) return false;
      playKit(soundId, { channel: "effects", at, guard });
      return true;
    },
  });
  game.spellVisuals = spellVisuals;
  game.spellVisualCoordinator = spellVisualCoordinator;
  spellVisuals.onLoaded = (ids) => {
    spellVisualCoordinator.onLoaded(ids);
    // The metadata that just landed already names every model these kits are made of, so warming
    // them costs one walk of an object that is already in memory. This is the cheapest of the
    // three round trips a cold spell used to pay, and the only one that can be removed before
    // anything at all has happened. `get` answers from cache for every id in a loaded batch, so
    // nothing here can start another metadata request.
    const environment = game.environment;
    if (!environment) return;
    for (const path of loadedVisualWarmPaths(ids, (id) => spellVisuals.get(id))) {
      environment.model(path, "normal");
    }
  };
  spellVisualKits.onLoaded = (ids) => {
    spellVisualCoordinator.onKitsLoaded(ids);
    // The same S1 seam, for the packets that have no cast bar to spend: the answer already names
    // every file the kit is made of, so warming them costs one walk of an object already in memory.
    const environment = game.environment;
    if (!environment) return;
    const warmed = new Set<string>();
    for (const id of ids) {
      for (const path of spellVisualKitPaths(spellVisualKits.get(id)?.kit)) {
        if (warmed.size >= ASSET_WARMUP_BUDGET.metadataWarmModels) return;
        if (warmed.has(path)) continue;
        warmed.add(path);
        environment.model(path, "normal");
      }
    }
  };
  spellVisualCoordinator.bindWorld(world);
  world.onStateChange = queueWorldState;
  world.onWorldError = (error) => {
    if (game.world !== world) return;
    clearHeldKeys();
    worldStatus.className = "error";
    worldStatus.textContent = error.message;
    // This callback is not "a packet went wrong" — `#deliver` swallows those and reports them
    // through `onPacketError`. It fires when `#connection.read()` itself threw, which means the
    // socket is gone, and a frozen world nobody can leave is worse than a screen that says so.
    // The login screen rather than the character list: without a connection there is no list.
    clearQuestLog();
    leaveWorld("connection-lost", `Соединение с миром потеряно: ${error.message}`);
  };
  // One packet this client cannot model no longer ends the session; it is reported and the
  // rest of the stream carries on.
  world.onPacketError = (opcode, error) => {
    if (game.world !== world) return;
    worldStatus.className = "error";
    worldStatus.textContent = `пакет 0x${opcode.toString(16)}: ${error.message}`;
  };
  // A teleport moves the player to another map, so the terrain and object streams have to
  // start over. mapId used to be set once at login, which left the client streaming the old
  // continent while the character stood somewhere else entirely.
  world.onWorldChanged = (mapId, position) => {
    if (game.world !== world) return;
    // This is intentionally the first side effect: no old cast, aura, decoded sound or pending
    // visual may survive into a world that happens to reuse the same GUIDs and coordinates.
    spellVisualCoordinator.worldChanged(world);
    // Keep the curtain up until the destination's terrain and VMAP collision have answered. The
    // server has already accepted the worldport ack, but starting local gravity in this gap makes
    // a character fall through an upper floor before its collision groups arrive.
    showLoadingScreen(world.selfName ?? "персонаж", "Загрузка ландшафта и коллизии вокруг точки прибытия…",
      { mapId, gateway: gatewayInput.value });
    // Close the movement gate before releasing input. Otherwise `syncMovement` can send one final
    // stop/start packet against the new server position while the destination is still loading.
    clearHeldKeys();
    // Another continent: nothing that was solid here is solid there, and no boss from the last
    // instance is engaged in this one.
    game.collision?.reset();
    // The destination can have the same map coordinates as the source. Drop the scattered field
    // explicitly instead of relying on a coordinate comparison in the renderer.
    game.renderer?.invalidateGroundCover();
    forgetUnitFrames();
    // GUIDs can be reused across maps, and the old render target must not survive a teleport while
    // the destination's model is still loading. Keep the ordinary image fallback visible.
    clearPortraitTargets();
    game.renderer?.clearPortraits();
    applyPortraitVisibility();
    // The zone name and any ping belong to the map that was left behind, and the new map's tile
    // index is fetched on the first frame that asks for a tile.
    forgetMinimap();
    // And so does whatever track was playing over it — and the wind under the track, which
    // `forgetZoneSound` now stops rather than only forgetting: an instance names no ambience of
    // its own, so on the other side there is nothing that would ever ask for the forest to stop.
    game.sound?.stopMusic();
    forgetZoneSound();
    worldStatus.className = "success";
    worldStatus.textContent = position
      ? `Карта ${mapId}: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`
      : `Карта ${mapId}: ждём позицию персонажа…`;
  };
  world.onMovementStatus = (ready, sentPackets) => {
    movementStatus.className = ready ? "success" : "error";
    // The two modes that are otherwise invisible until the character moves: walking looks like a
    // slow run, and autorun looks like a key nobody is holding.
    const modes = [isWalking() ? "шагом" : "", isAutoRunning() ? "автобег" : ""].filter(Boolean);
    movementStatus.textContent = ready
      ? `Movement: active mover назначен · отправлено пакетов: ${sentPackets}${modes.length ? ` · ${modes.join(", ")}` : ""}`
      : "Movement: active mover не назначен";
  };
  world.onCombatStatus = (message, attacking, error) => {
    combatStatus.className = error ? "error" : attacking ? "success" : "muted";
    combatStatus.textContent = message;
    // «Цель мертва», «по этой цели нельзя атаковать» and the rest used to reach only the line
    // above, which lives inside the diagnostics window and is hidden unless somebody opened it.
    if (error) notice(message);
    showSwingWarning(world);
    showTarget();
  };
  world.onSwing = (swing) => {
    logSwing(world, swing);
    // Which swing it is comes from what the attacker is visibly holding; the renderer knows that
    // and the log does not, so it is told the action rather than the animation.
    game.renderer?.playUnitAction(swing.attacker, "attack");
    // And what it sounded like. Whoosh, landing, grunt and cry are all chosen from this one packet,
    // in `CombatSounds`, because none of that needs a DOM and all of it needs testing. This is the
    // only thing in the client that makes a noise for a melee blow, and it can be: `COMBAT_LOG`,
    // where the client's only combat sound lived until now, is emitted by six spell packets and by
    // none of the melee ones — so melee had no sound at all rather than the wrong one, and the two
    // handlers never fire for the same blow. `tests/attack.test.mjs` is what keeps that true.
    playSwingSounds(swing);
  };
  world.onEmote = (guid, emoteId) => {
    const emote = EMOTE_ANIMATIONS[emoteId];
    // A stance is held until the unit moves; anything else is over when it has played once.
    if (emote) game.renderer?.playUnitEmote(guid, emote.animation, emote.state ? EMOTE_STATE_HOLD : 0);
  };
  // `SMSG_TEXT_EMOTE` is the sound-bearing edge. `SMSG_EMOTE` above is animation-only, so a
  // server pair of packets still produces exactly one audio lookup. The bounded queue covers the
  // normal login race where EmotesTextSound or the audio system lands a frame later. An unknown
  // source is intentionally not queued: without its race, sex and position the client would have
  // to guess both which voice to play and where it came from.
  const pendingTextEmoteSounds: Array<{ emote: TextEmote; deadline: number }> = [];
  const tryPlayTextEmoteSound = (emote: TextEmote): boolean => {
    const source = world.state.objects.get(emote.guid);
    if (!source) return true; // Unknown source is deliberately silent, never guessed.
    const raceId = unit.race(source);
    const gender = unit.gender(source);
    const at = source.position;
    if (raceId === undefined || gender === undefined || !at) return false;
    if (!world.emotes || !game.soundKits || !game.sound) return false;
    const soundId = emoteSoundId(world.emotes, emote.textEmoteId, raceId, gender);
    if (soundId === undefined || soundId <= 0) return true;
    const guard = (): boolean => {
      if (game.world !== world) return false;
      const current = world.state.objects.get(emote.guid);
      return current === source && unit.race(current) === raceId && unit.gender(current) === gender;
    };
    playKit(soundId, { channel: "effects", at: { ...at }, guard });
    return true;
  };
  const flushTextEmoteSounds = (): void => {
    const now = performance.now();
    const keep: Array<{ emote: TextEmote; deadline: number }> = [];
    for (const pending of pendingTextEmoteSounds) {
      if (pending.deadline <= now) continue;
      if (!tryPlayTextEmoteSound(pending.emote)) keep.push(pending);
    }
    pendingTextEmoteSounds.splice(0, pendingTextEmoteSounds.length, ...keep);
  };
  onWorldEvent("TEXT_EMOTE", (emote) => {
    if (!tryPlayTextEmoteSound(emote)) {
      const deadline = performance.now() + EMOTE_SOUND_WAIT;
      if (pendingTextEmoteSounds.length < 32) pendingTextEmoteSounds.push({ emote, deadline });
    }
  });
  onWorldEvent("MOUNT_SPECIAL", ({ guid }) => {
    // The packet names the rider, but the authored MountSpecial/FlyMountSpecial sequence belongs
    // to the mount node underneath it. The renderer keeps the edge until that node is available.
    game.renderer?.playMountSpecial(guid);
  });
  world.onExperience = (gain) => {
    pushCombatLine(gain.victim === 0n ? `+${gain.total} опыта` : `+${gain.total} опыта за убийство`, "reward");
  };
  world.onEnvironmentalDamage = (damage) => {
    const label = ENVIRONMENT_NAMES[damage.type] ?? "Урон";
    recordCombatEntry({
      at: Date.now(), text: `${world.displayName(damage.victim)}: ${label} ${damage.damage}`,
      kind: damage.victim === world.state.selfGuid ? "taken" : "muted",
      casterGuid: 0n, targetGuid: damage.victim, spellId: 0,
    });
    showFloatingText(damage.victim, "taken", damage.damage, false);
  };
  // The tracking menu is built from what the character knows and read back out of the fields, so
  // both a new spell and a changed bit have to repaint it.
  onStoreEvent("PLAYER_TRACK_CREATURES", () => showTracking());
  onStoreEvent("PLAYER_TRACK_RESOURCES", () => showTracking());
  world.onSpellsChanged = () => {
    showSpells();
    showActionBar();
    void loadSpellMetadata(world).then(showCharacterCollections);
  };
  // Slice P4: what the world says to everyone standing in it. The banner an area trigger raises
  // gets its own line rather than a frame of its own — the frame belongs to slice I10, and a line
  // the player can read now beats a packet counted and dropped.
  onWorldEvent("WORLD_MESSAGE", (message) => {
    // A banner is an announcement and belongs over the world; a system line is a sentence about
    // the player — a friend coming online, a name that did not resolve — and belongs in chat,
    // which is where `#recordSystemLine`'s own comment always said it was going.
    if (message.kind === "system") systemLine(message.text);
    else pushCombatLine(message.text, message.kind === "banner" ? "reward" : "muted");
  });
  /**
   * The server asked for a sound, and until now the client wrote the request down and did nothing.
   *
   * The metadata for a kit may not be here yet — the first time an id is seen it is asked for and
   * this call returns nothing. That is not worth queueing: the second boar's death rattle plays,
   * and a sound held back until it could be looked up would arrive after the boar had gone.
   */
  onWorldEvent("PLAY_SOUND", (request) => {
    const kit = game.soundKits?.kit(request.soundKitId);
    if (!kit) return;
    if (request.music) {
      game.sound?.play(kit, { channel: "music", loop: true });
      return;
    }
    // A `SMSG_PLAY_OBJECT_SOUND` names the thing making the noise, and that is the whole
    // difference between the two: an object's sound comes from where the object is standing, a
    // plain one from wherever the listener is.
    const source = request.sourceGuid === 0n ? undefined : world.state.objects.get(request.sourceGuid)?.position;
    game.sound?.play(kit, source ? { channel: "effects", at: source } : { channel: "interface" });
  });
  /**
   * A kit the server asked for by number, with no spell around it.
   *
   * `SMSG_PLAY_SPELL_VISUAL` / `SMSG_PLAY_SPELL_IMPACT` are how a scripted event shows itself — a
   * door ward, a boss emote, a player sitting down to eat, this server's own Illidan throwing a
   * glaive — and until slice S3 only the noise came out of them: the kit tables were reachable
   * only through `/dbc/spell-visuals`, which is keyed by *spell*. `/dbc/spell-visual-kits` answers
   * by the number the packet actually carries, so the coordinator can now draw the models and play
   * the pose as well. The sound stays exactly where it was — it never needed the route, because
   * `SoundID` reaches `SoundEntries` through the sound index rather than through the kit record.
   */
  onWorldEvent("SPELL_VISUAL", (event) => {
    const at = world.state.objects.get(event.guid)?.position;
    if (at) playKitSound(0, at, event.kitId);
    spellVisualCoordinator.playVisualKit(event.guid, event.kitId, event.impact);
  });
  onWorldEvent("SUMMON_REQUEST", () => showInteractionPrompts());
  onWorldEvent("QUEST_SHARED", () => showInteractionPrompts());
  onWorldEvent("BATTLEFIELD_QUEUE_CHANGED", () => showInteractionPrompts());
  onWorldEvent("BATTLEFIELD_CHANGED", () => showInteractionPrompts());
  onWorldEvent("LFG_INFO_CHANGED", () => showInteractionPrompts());
  // A channel the player was put into needs a tab; nothing subscribed to this before.
  onWorldEvent("CHANNEL_CHANGED", () => syncChannelTabs());
  // Slice I10: the account's own eight slots, which nothing had ever written to. Settings, macros
  // and the rest stop belonging to a browser profile and start belonging to the player.
  onWorldEvent("ACCOUNT_DATA_CHANGED", (change) => {
    if (change.type === undefined) return;
    if (settingsStore.accept(change.type)) {
      applySettings();
      drawSettings();
    }
    for (const store of macroStores) if (store.accept(change.type)) showMacros();
  });
  // The pet bar and the vehicle bar are the same packet; neither had a reader.
  onWorldEvent("PET_BAR_CHANGED", () => {
    showPetBar();
    showCharacterCollections();
  });
  onWorldEvent("VEHICLE_CHANGED", () => showPetBar());
  onWorldEvent("LOGOUT_CHANGED", (state) => {
    updateLogoutPending(world, state.pending);
    if (state.pending) {
      notice("Выход через несколько секунд", "info");
      return;
    }
    if (!state.complete) return;
    notice("Выход из мира", "info");
    // `SMSG_LOGOUT_COMPLETE` is the server letting go of the character, and in the original that is
    // the character-select screen coming back. Before G6 it was a notice and nothing else: the
    // player was left looking at a world the server had already stopped updating, with no way out
    // but reloading the page. The guard is the one every handler here carries — a completion that
    // belongs to a connection this client has already replaced changes nothing.
    if (game.world !== world) return;
    clearQuestLog();
    leaveWorld("logout");
  });
  // Slice I10: every refusal that had no reader at all. Each of these was written into a field on
  // the world client and left there — the pet's, the arena's, the calendar's, the charter's, the
  // ticket's, the stable's, and the server's own announcements.
  onWorldEvent("PET_MESSAGE", (message) => notice(message.text, message.error ? "error" : "info"));
  onWorldEvent("PVP_MESSAGE", (message) => notice(message.text, message.error ? "error" : "info"));
  onWorldEvent("TAXI_MENU", () => showTaxiMenu());
  onWorldEvent("TAXI_CHANGED", () => showTaxiMenu());
  onWorldEvent("BATTLEFIELD_LIST_CHANGED", () => showBattlegroundList());
  onWorldEvent("TABARD_VENDOR_CHANGED", () => showTabardVendor());
  onWorldEvent("STABLE_CHANGED", () => {
    // Stock PetStableFrame opens and answers from its own events while published.
    if (frameXmlStablePublished()) return;
    if (world.stableMessage) notice(world.stableMessage.text, world.stableMessage.error ? "error" : "info");
    showCharacterWindow("collections");
    showCharacterCollections();
  });
  onWorldEvent("PETITION_CHANGED", () => {
    if (world.petitionMessage) notice(world.petitionMessage.text, world.petitionMessage.error ? "error" : "info");
    showPetition();
  });
  onWorldEvent("GM_TICKET_CHANGED", () => {
    if (world.ticketMessage) notice(world.ticketMessage.text, world.ticketMessage.error ? "error" : "info");
  });
  onWorldEvent("CHARACTER_SERVICE", () => {
    if (world.serviceMessage) notice(world.serviceMessage.text, world.serviceMessage.error ? "error" : "info");
    // A haircut refusal leaves the chair window open with the reason; success stands the
    // character up, which closes it.
    showBarberShop();
  });
  onWorldEvent("CHANNEL_CHANGED", () => { if (channelRosterOpen()) showChannelRoster(); });
  onWorldEvent("BARBER_SHOP", () => showBarberShop());
  // The message of the day and the server's own notices go to chat, where they stay readable.
  onWorldEvent("SESSION_MESSAGE", (message) => systemLine(message.text));
  // Slice I9. Nine of these were declared on the bus, emitted by the handlers and read by nobody
  // at all; `EnterWorld` held every subscription in the client and none of them were here.
  onWorldEvent("LOOT_ROLL_CHANGED", (roll) => noticeLootRoll(roll.newItemGuid));
  onWorldEvent("READY_CHECK", () => showReadyCheck());
  onWorldEvent("GUILD_BANK_CHANGED", () => showGuildBank());
  // The alert stream is parsed and discarded by the handler, so the snapshot is asked for again
  // rather than patched from an event that carries nothing.
  onWorldEvent("CALENDAR_CHANGED", (change) => {
    refreshCalendar(change);
    if (world.calendarMessage) {
      notice(world.calendarMessage.text, world.calendarMessage.error ? "error" : "info");
      world.calendarMessage = undefined;
    }
  });
  onWorldEvent("INSTANCE_CHANGED", () => showCalendar());
  onWorldEvent("CONTACTS_CHANGED", () => showSocialPanel());
  onWorldEvent("WHO_RESULTS", () => showSocialPanel());
  onWorldEvent("PVP_SCOREBOARD_CHANGED", () => showScoreboard());
  onWorldEvent("FLAG_CARRIERS_CHANGED", () => showScoreboard());
  onWorldEvent("ARENA_TEAM_CHANGED", () => showArenaWindow());
  onWorldEvent("WEATHER_CHANGED", () => queueWorldState(world.state));
  onWorldEvent("ACTION_BUTTONS_CHANGED", () => showActionBar());
  // Boss frames. The packet carries one engage or disengage at a time and never a list, so the
  // list is kept in the frames module and fed from here.
  onWorldEvent("ENCOUNTER_FRAME", (frame) => {
    if (frame.type === ENCOUNTER_FRAME_ENGAGE) bossEngaged(frame.guid);
    else if (frame.type === ENCOUNTER_FRAME_DISENGAGE) bossDisengaged(frame.guid);
    else return;
    showUnitFrames();
  });
  // A raid mark moved, so somebody's frame gained or lost its star.
  onWorldEvent("RAID_TARGET_UPDATE", () => showUnitFrames());
  // The pet bar arriving or coming down is what tells the pet frame there is a pet at all.
  onWorldEvent("PET_BAR_CHANGED", () => showUnitFrames());

  onWorldEvent("PARTY_MEMBER_STATS", () => showUnitFrames());
  onWorldEvent("THREAT_CHANGED", () => showUnitFrames());
  // The bank window opens itself the moment the banker grants permission, and closes with it.
  // Someone in the party marked a spot. The packet has been arriving and going nowhere.
  onWorldEvent("MINIMAP_PING", (ping) => addMinimapPing(ping.x, ping.y));
  // The exploration mask is a field rather than a packet, so it comes off the store's bus, and it
  // is 128 words fanned into one name — this fires once however many of them changed.
  onStoreEvent("PLAYER_EXPLORED_ZONES", () => showWorldMap());
  onWorldEvent("EXPLORATION", (found) => {
    // Not the source of truth — the core only sends this when the area is worth experience — but
    // it is the only thing that says *which* area was just discovered.
    const name = game.areas?.area(found.areaId)?.name;
    if (name) pushCombatLine(`Обнаружено: ${name}`, "dealt");
    showWorldMap();
  });
  onWorldEvent("BANK_OPENED", () => showBank());
  onWorldEvent("CHARACTER_SHEET_CHANGED", () => {
    showCharacterSheet();
    // Equipment sets ride the same event: the list arrives once at login and never again, so a
    // set saved during the session is only ever redrawn because this says so.
    showEquipmentSets();
  });
  onWorldEvent("REPUTATION_CHANGED", () => {
    showCharacterSheet();
    showReputation();
  });
  onWorldEvent("TALENTS_CHANGED", () => {
    showCharacterSheet();
    showTalents();
  });
  onWorldEvent("LEVEL_UP", (info) => {
    playUiSound("levelUp");
    pushCombatLine(`Уровень ${info.level}: +${info.healthDelta} здоровья`, "dealt");
    showCharacterSheet();
  });
  onWorldEvent("SPELL_LEARNED", (learned) => {
    const name = game.spells.get(learned.spellId)?.name ?? `заклинание ${learned.spellId}`;
    pushCombatLine(`Изучено: ${name}`, "dealt");
    // A newly learned top rank promotes the bar slots still pointing at its lower ranks.
    upgradeActionBarRanks();
  });
  onWorldEvent("SPELL_MODIFIERS_CHANGED", () => showSpells());
  onWorldEvent("ACHIEVEMENT_EARNED", (earned) => {
    if (earned.mine) pushCombatLine(`Достижение ${earned.achievementId} получено`, "dealt");
  });
  onWorldEvent("QUEST_LOG_CHANGED", () => {
    requestMissingQuestTemplates();
    // Where the log's quests want the player to go, asked for only when the set of quests changes.
    requestQuestPoi();
    showQuestLog();
    showQuestTracker();
  });
  onWorldEvent("QUEST_POI", () => showWorldMap());
  onWorldEvent("QUEST_PROGRESS", (progress) => {
    const title = world.questTemplates.get(progress.questId)?.title ?? `Задание ${progress.questId}`;
    pushCombatLine(`${title}: ${progress.count} / ${progress.required}`, "dealt");
  });
  onWorldEvent("QUEST_FINISHED", (finished) => {
    playUiSound(finished.failed ? "questFailed" : "questCompleted");
    const title = world.questTemplates.get(finished.questId)?.title ?? `Задание ${finished.questId}`;
    pushCombatLine(finished.failed ? `${title}: провалено` : `${title}: выполнено`, finished.failed ? "taken" : "dealt");
  });
  onWorldEvent("QUEST_GIVER_STATUS", () => {
    // Nothing to redraw: the marks are painted from the map every frame by the scene.
  });
  // Only real spell damage adds a creature effort voice. Authored SpellVisualKit sounds remain
  // untouched; healing and utility rows are deliberately silent here.
  onWorldEvent("COMBAT_LOG", (line) => {
    for (const voice of spellCombatVoices(line)) playCreatureSound(voice.guid, voice.voice);
  });
  onWorldEvent("COMBAT_LOG", (line) => {
    const mine = line.casterGuid === world.state.selfGuid;
    const atMe = line.targetGuid === world.state.selfGuid;
    // The combat tab keeps the complete history. Relevance filtering belongs to floating world
    // text, not to the log, which players expect to remain an auditable record of the encounter.
    recordCombatEntry({
      at: Date.now(), text: spellLine(line.text, line.spellId),
      kind: line.critical ? "crit" : mine ? "dealt" : atMe ? "taken" : "muted",
      casterGuid: line.casterGuid, targetGuid: line.targetGuid, spellId: line.spellId,
    });
  });
  // The overlay keeps only the player and their current target. The target can change between the
  // packet and this callback, so that relevance policy stays beside floater allocation itself.
  onWorldEvent("FLOATING_TEXT", (text) => {
    const taken = text.guid === world.state.selfGuid && text.kind === "damage";
    showFloatingText(text.guid, taken ? "taken" : text.kind, text.amount, text.critical, text.text);
  });
  onWorldEvent("FLOATING_TEXT", (text) => {
    if (text.guid !== world.state.selfGuid) return;
    if (text.kind === "miss") pushCombatLine(text.text ?? "промах", "taken");
    else if (text.amount > 0) pushCombatLine(`${text.kind === "heal" ? "лечение" : text.kind === "power" ? "восстановлено" : "урон"}: ${text.amount}`, text.kind === "damage" ? "taken" : "dealt");
  });
  // What the creature itself has to say about being hit and about dying. `CreatureSoundData` has
  // been vendored since the sound tables landed and nothing ever read it, so every boar in the
  // world took its damage in silence.
  onWorldEvent("FLOATING_TEXT", (text) => {
    if (text.kind === "damage" && text.amount > 0) {
      playCreatureSound(text.guid, text.critical ? "injuryCritical" : "injury");
    }
  });
  // The plate's hit-flash rides the same funnel as the numbers and the injury voices, so a flash
  // and its number are never about different blows. Kind and amount gate inside `notePlateHit`:
  // heals, power and misses never whiten a health bar.
  onWorldEvent("FLOATING_TEXT", (text) => {
    notePlateHit(text.guid, text.kind, text.amount, performance.now());
  });
  onWorldEvent("AI_REACTION", (reaction) => {
    // 2 is `AI_REACTION_HOSTILE`, the moment a creature decides it has seen you.
    if (reaction.reaction === 2) playCreatureSound(reaction.guid, "aggro");
  });
  // The focus is the interface's own and the world client has never heard of it, so this is where
  // `SMSG_BREAK_TARGET` lands; the selection is its sibling's business, `SMSG_CLEAR_TARGET`, which
  // the same fear sends three lines later. Without this line half of SPELL_EFFECT_FORCE_DESELECT
  // would land.
  onWorldEvent("TARGET_BROKEN", (broken) => clearFocusOn(broken.guid));
  onWorldEvent("PARTY_KILL", (kill) => {
    playCreatureSound(kill.victimGuid, "death");
    // The victim's GUID was in the payload all along and the line said «цель убита» regardless,
    // which in a group is three identical lines and no way to tell what died.
    const victim = world.displayName(kill.victimGuid);
    recordCombatEntry({
      at: Date.now(), text: `${world.displayName(kill.killerGuid)} убивает: ${victim}`, kind: "muted",
      casterGuid: kill.killerGuid, targetGuid: kill.victimGuid, spellId: 0,
    });
  });
  world.onSpellStatus = (message, error) => {
    professionCastStatus(message, error);
    spellStatus.className = error ? "error" : "success";
    spellStatus.textContent = message;
    // The same, for a cast refusal: it went to a line inside the spellbook and nowhere else.
    if (error) notice(message);
  };
  world.onCooldownsChanged = () => updateSpellCooldowns(performance.now());
  world.onCooldownEvent = (spellId) => {
    const metadata = game.spells.get(spellId);
    if (metadata) world.startLocalCooldown(spellId, Math.max(metadata.recoveryTime, metadata.categoryRecoveryTime));
  };
  // One world-bound subscription owns the action-bar GCD. The spellbook only submits casts; a
  // click-local listener could survive a failure and attach itself to a later cast of the same id.
  onWorldEvent("SPELL_CAST_ACCEPTED", ({ spellId, startedAt }) => {
    if (game.world !== world) return;
    const gcd = game.spells.get(spellId)?.startRecoveryTime ?? 0;
    if (gcd > 0) game.globalCooldownUntil = Math.max(game.globalCooldownUntil, startedAt + gcd);
  });
  // A lever being pulled, a door being knocked in: the object's own animation, named by number.
  world.onGameObjectAnimation = (guid, animation) => game.renderer?.playGameObjectAnimation(guid, animation);
  /**
   * One kit's noise, at a point in the world.
   *
   * `soundId` is a `SoundEntries` row and is what a spell's own visual carries. `visualKitId` is
   * the other way in — `SMSG_PLAY_SPELL_VISUAL_KIT` names a `SpellVisualKit` and the mapping to a
   * sound lives on the kit — and the two are separate parameters rather than one because they are
   * ids in different tables and confusing them plays the wrong thing rather than nothing.
   */
  const playKitSound = (soundId: number, at: { x: number; y: number; z: number }, visualKitId = 0): void => {
    const id = soundId > 0 ? soundId : visualKitId > 0 ? game.soundKits?.spellKitSound(visualKitId) ?? 0 : 0;
    if (id <= 0) return;
    // Through `playKit` rather than straight at the player, so a spell whose row has not arrived
    // yet is heard a few milliseconds late instead of not at all. A sound id is first seen at the
    // moment the spell is cast, so without the wait the first cast of every spell was silent.
    playKit(id, { channel: "effects", at });
  };
  // Aura packets arrive for every unit in view, a crowd's worth in one burst, and the frame after it
  // shows only the last state: the strips, the renderer's stealth map and the metadata ask run once
  // there (`queueFrameTask`) instead of once per packet. `showAuras` leaves a strip alone when none
  // of its auras moved, so a packet about somebody else no longer rebuilds the player's icons.
  const refreshAuras = (): void => {
    if (game.world !== world) return;
    showAuras();
    void loadAuraMetadata(world);
  };
  world.onAurasChanged = () => queueFrameTask(refreshAuras);

  world.onGossipChanged = showGossip;
  world.onQuestChanged = () => {
    if (!notifyFrameXmlQuestGiver(world)) showQuestState();
  };
  world.onLootChanged = () => {
    showLoot();
    // The master looter's candidate list rides this callback and raises no event of its own.
    showLootRolls();
  };
  // One callback owns both vendor presentation routes. Before the stock gate publishes, the
  // native panel remains the fallback; after publication every transition is a FrameXML event.
  let refreshVendorUi: (reason?: "vendor" | "metadata") => void = () => {};
  const merchantMetadata = createFrameXmlMerchantMetadataCoordinator({
    vendor: () => world.vendor,
    itemMetadata: () => game.itemMetadata,
    itemTemplate: (entry) => world.itemTemplates.get(entry),
    costFor: (id) => game.vendorCosts?.get(id),
    onMetadataLoaded: () => {
      if (game.world === world) refreshVendorUi("metadata");
    },
  });
  refreshVendorUi = (reason: "vendor" | "metadata" = "vendor"): void => {
    const vendor = world.vendor;
    if (!vendor) {
      merchantMetadata.reset();
      if (!notifyFrameXmlMerchant("closed")) showVendor();
      return;
    }
    if (reason === "vendor" && !game.vendorCosts?.ready) game.vendorCosts?.load();
    const presentation = merchantMetadata.refresh(reason);
    if (reason === "metadata") {
      // ItemMetadataClient also reports unrelated item rows. Only repaint the stock root when a
      // vendor row's name/icon/stack data actually changed; the force bit bypasses raw vendor-shape
      // dedupe in the seam without making the next tick emit a duplicate UPDATE.
      if (presentation.changed) {
        if (!notifyFrameXmlMerchant("update", true)) showVendor();
      }
    } else {
      const event = frameXmlMerchantOpen() ? "update" : "show";
      if (!notifyFrameXmlMerchant(event)) showVendor();
    }
  };
  world.onVendorChanged = refreshVendorUi;
  world.onItemMessage = showItemMessage;
  world.onGroupChanged = showGroup;
  world.onTradeChanged = showTrade;
  world.onMailChanged = showMail;
  world.onGuildChanged = () => {
    showGuild();
    // `MSG_GUILD_EVENT_LOG_QUERY` answers through this callback while its five siblings use the
    // bus, so the bank window has to listen here too or its log tab never repaints.
    showGuildBank();
  };
  world.onAuctionChanged = showAuctions;
  world.onLfgChanged = showLfg;
  world.onDuelChanged = showDuel;
  world.onChatMessage = (message) => {
    appendChatMessage(message);
    // Only the types the original client puts over a head. Keyed on the type and never on the
    // label, which is Russian and would change the behaviour the day it is translated.
    if (BUBBLE_TYPES.has(message.type)) showChatBubble(message.senderGuid, message.text, chatClass(message.type));
  };
  // The world view asks for the names of the forty nearest players at a time, and every answer used
  // to redraw the whole chat pane and each window that prints a name. They are repainted once, on
  // the next frame (`queueFrameTask`), and the pane only when a line on it reads differently now
  // (`refreshChatNames`).
  const refreshNames = (): void => {
    if (game.world !== world) return;
    refreshChatNames(); showMail(); refreshSocialNames(); if (channelRosterOpen()) showChannelRoster();
    if (scoreboardOpen()) showScoreboard();
    if (world.resurrectRequest && !world.resurrectRequest.casterName) showDeath();
  };
  world.onNamesChanged = () => queueFrameTask(refreshNames);
  redrawChatLog();
  const refreshTrainerUi = (): void => {
    const trainer = world.trainer;
    // Both stock and native trainer rows need the same cached names/icons. A tradeskill trainer
    // stays native, but skipping this request left every packet row filtered out by showTrainer.
    const ids = [...new Set((trainer?.spells ?? []).map((spell) => spell.spellId).filter((id) => id > 0))];
    ensureSpellNames(ids, () => {
      // Metadata belongs to the world/list currently on screen, not to the object captured when
      // the request was coalesced. WorldClient may replace an equivalent TrainerList instance.
      if (game.world === world && world.trainer !== undefined) refreshTrainerUi();
    });
    const supported = trainer !== undefined
      && (trainer.trainerType === 0 || trainer.trainerType === 1 || trainer.trainerType === 3);
    if (!supported) {
      notifyFrameXmlTrainer("closed");
      showTrainer();
      return;
    }
    const event = frameXmlTrainerOpen() ? "update" : "show";
    if (!notifyFrameXmlTrainer(event)) showTrainer();
  };
  world.onTrainerChanged = refreshTrainerUi;
  world.onDeathChanged = showDeath;
  world.onLootMoney = (amount, alone) => {
    combatStatus.className = "success";
    combatStatus.textContent = alone ? `Вы подобрали ${formatMoney(amount)}` : `Ваша доля: ${formatMoney(amount)}`;
  };
  showLoot();
  showDeath();
  refreshVendorUi();
  refreshTrainerUi();
  showItemMessage();
  showGroup();
  showTrade();
  showDuel();
  showMail();
  showGuild();
  showAuctions();
  showLfg();
  world.unhandledOpcodes.onFirstSighting = (entry) => {
    // The record keeps two different failures apart and the line has to as well. A packet the
    // world loop could not route has no handler; a packet lost while the login handshake owned the
    // socket has one and never reached it. Saying "no handler" for the second sent five names to
    // the console that the diagnostics panel, correctly, counts as zero — and contradicted the
    // plan, which was right about them.
    const where = entry.count > 0 ? "нет обработчика для" : "потерян в окне логина:";
    console.warn(`[WebClient] ${where} ${entry.name} (0x${entry.opcode.toString(16).toUpperCase()})`);
  };
  world.onUnhandledOpcodesChanged = showUnhandledOpcodes;
  world.onPacketErrorsChanged = showUnhandledOpcodes;
  showUnhandledOpcodes();
  let assetWarmup: SessionAssetWarmup | undefined;
  try {
    const location = await world.loginCharacter(character.guid);
    // A logout or a new realm can retire this attempt while its login reply is in flight. Do not
    // rebuild asset clients into the context that now belongs to another world.
    if (!entryLifecycle.isCurrent(generation) || game.world !== world) return;
    // The tabard designer only echoes its own guid. The current emblem is client data obtained
    // from the guild query, so ask once on entry rather than opening an editor on destructive zeroes.
    if (character.guildId > 0) world.queryGuild(character.guildId);
    const terrain = new TerrainClient(gatewayInput.value);
    game.terrain = terrain;
    terrain.onStatus = (message, error) => {
      if (game.terrain !== terrain) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "success";
      terrainStatus.textContent = `Terrain: ${message}`;
    };
    const splat = new TerrainSplatClient(gatewayInput.value);
    game.terrainSplat = splat;
    splat.onStatus = (message, error) => {
      if (game.terrainSplat !== splat) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "success";
      terrainStatus.textContent = `Terrain: ${message}`;
    };
    // What grows on the ground rides the same family of files as the splat, so it is built beside
    // it; `applySettings` below is what tells the renderer about it, along with how far the field
    // reaches. Nothing is fetched until a frame asks for a tile.
    const groundCover = new GroundCoverClient(gatewayInput.value);
    game.groundCover = groundCover;
    groundCover.onStatus = (message, error) => {
      if (game.groundCover !== groundCover) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "success";
      terrainStatus.textContent = `Terrain: ${message}`;
    };
    const light = new LightClient(gatewayInput.value);
    game.light = light;
    const liquids = new LiquidTextureClient(gatewayInput.value);
    game.liquids = liquids;
    liquids.onStatus = (message, error) => {
      if (game.liquids !== liquids) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "success";
      terrainStatus.textContent = `Terrain: ${message}`;
    };
    light.onStatus = (message, error) => {
      if (game.light !== light) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "success";
      terrainStatus.textContent = `Terrain: ${message}`;
    };
    const environment = new EnvironmentClient(gatewayInput.value);
    game.environment = environment;
    environment.onStatus = (message, error) => {
      if (game.environment !== environment) return;
      if (error) notice(message);
      environmentStatus.className = error ? "error" : "success";
      environmentStatus.textContent = `Environment: ${message}`;
    };
    game.spellMetadataClient = new SpellMetadataClient(gatewayInput.value);
    game.creatureMetadata = new CreatureMetadataClient(gatewayInput.value);
    // The dump answers first and the server corrects it. A creature a module added is not in the
    // dump at all — it was written by `npm run assets:creatures` against the database as it was —
    // so without this it is drawn under the name of whatever stock entry the dump happens to hold,
    // and a renamed one keeps the old name until somebody regenerates the file.
    game.creatureMetadata.attach(world, () => queueWorldState(world.state));
    game.gameObjectMetadata = new GameObjectMetadataClient(gatewayInput.value);
    game.transportPaths = new TransportPathClient(gatewayInput.value);
    game.horizon = new HorizonClient(gatewayInput.value);
    const creatureModels = new CreatureModelClient(gatewayInput.value);
    game.creatureModels = creatureModels;
    creatureModels.onStatus = (message, error) => {
      if (game.creatureModels !== creatureModels) return;
      if (error) notice(message);
      modelStatus.className = error ? "error" : "success";
      modelStatus.textContent = `Models: ${message}`;
    };
    const itemMetadata = new ItemMetadataClient(gatewayInput.value);
    game.itemMetadata = itemMetadata;
    // Same for items, plus the one thing a slot needs beyond a repaint: the inventory only redraws
    // when its signature or its metadata revision moves, and a name arriving from the wire moves
    // neither on its own.
    //
    // Every visible piece of gear of every player in view is asked of the server, so a crowd answers
    // with hundreds of these in a burst; the windows below are repainted once, on the next frame
    // (`queueFrameTask`), from whatever has arrived by then.
    const refreshItemMetadata = (): void => {
      if (game.world !== world || game.itemMetadata !== itemMetadata) return;
      itemMetadataChanged();
      queueWorldState(world.state);
      notifyFrameXmlQuestGiverItemUpdate(world, itemMetadata.revision);
      // Three windows that `showWorldState` does not repaint. It calls `showDeath`,
      // `showUnitFrames`, `showProfessions`, `renderInventory` and `showTarget`, and none of those
      // is the loot window — so an item query answered while the corpse was open left «Предмет
      // 4306» on screen until the player closed and reopened it.
      showLoot();
      refreshVendorUi("metadata");
      showLootRolls();
      showMail();
    };
    itemMetadata.attach(world, () => queueFrameTask(refreshItemMetadata));
    // Speculative work belongs to this login only. It has fixed lifetime budgets and never joins
    // the loading-screen barrier; the render loop merely gives it the already-current player,
    // action bar and environment list while its short soft window is open.
    game.assetWarmup?.dispose();
    // The spellbook, not just the action bar: the spell nobody put on a bar is exactly the one
    // whose first cast is cold. Read through a function because `SMSG_INITIAL_SPELLS` is only the
    // first of the packets that change it.
    assetWarmup = new SessionAssetWarmup(
      { environment, creatureModels, itemMetadata, spellVisuals },
      { knownSpellIds: () => world.knownSpells.map((spell) => spell.id) },
    );
    game.assetWarmup = assetWarmup;
    // Both lock tables at once, and once: which spell opens a chest has to be decided here,
    // where the spellbook is, and asking per object would be a round trip for every rock.
    const locks = new LockClient(gatewayInput.value);
    game.locks = locks;
    locks.onStatus = (message, error) => {
      if (game.locks !== locks) return;
      if (error) notice(message);
      combatStatus.className = error ? "error" : "muted";
      combatStatus.textContent = message;
    };
    locks.load();
    // Every faction template, once. Nothing on the wire says whether a unit is an enemy, so Tab
    // targeting and the reaction a frame shows both come out of this table.
    const factions = new FactionClient(gatewayInput.value);
    game.factions = factions;
    factions.onStatus = (message, error) => {
      if (game.factions !== factions) return;
      if (error) notice(message);
      combatStatus.className = error ? "error" : "muted";
      combatStatus.textContent = message;
    };
    factions.load();
    factions.loadReputation();
    // Every text emote and its sentences. `/dance` is a slash command the client has to recognise
    // and a sentence the client has to write; neither is on the wire, and both are in EmotesText.
    const emoteClient = new EmoteClient(gatewayInput.value);
    emoteClient.onStatus = (message, error) => {
      if (game.world !== world) return;
      if (error) notice(message);
      combatStatus.className = error ? "error" : "muted";
      combatStatus.textContent = message;
    };
    emoteClient.onLoaded = (data) => {
      if (game.world !== world) return;
      world.emotes = data;
      // Emotes that arrived before the table did were recorded with no sentence at all; now they
      // have one, and the pane is drawn again to show it.
      world.refreshEmoteLines();
      redrawChatLog();
      flushTextEmoteSounds();
    };
    emoteClient.load();
    // Talent trees, glyphs and skill lines. `SMSG_TALENTS_INFO` carries ids and ranks and nothing
    // that makes a tree, so without this table there is no window to open.
    const talentData = new TalentClient(gatewayInput.value);
    game.talentData = talentData;
    talentData.onStatus = (message, error) => {
      if (game.talentData !== talentData) return;
      if (error) notice(message);
      spellStatus.className = error ? "error" : "muted";
      spellStatus.textContent = message;
    };
    talentData.onLoaded = () => {
      if (game.talentData !== talentData) return;
      // The book divides into tabs the moment the table lands, and the two windows that read it
      // are repainted rather than left showing "waiting".
      showSpells();
      showTalents();
      showProfessions();
      showCharacterCollections();
    };
    talentData.load();
    // BarberShopStyle rows: the only style ids `CMSG_ALTER_APPEARANCE` may carry. Without
    // them the chair window cannot offer a single click the server would take.
    const barberStyles = new BarberClient(gatewayInput.value);
    game.barberStyles = barberStyles;
    barberStyles.onStatus = (message, error) => {
      if (game.barberStyles !== barberStyles) return;
      if (error) notice(message);
      showBarberShop();
    };
    barberStyles.onLoaded = () => {
      if (game.barberStyles !== barberStyles) return;
      showBarberShop();
    };
    barberStyles.load();
    // Bank bag and stable slot prices. Without them both windows say the server names the
    // price, which is what they said before this slice.
    const slotPrices = new SlotPriceClient(gatewayInput.value);
    game.slotPrices = slotPrices;
    slotPrices.onLoaded = () => {
      if (game.slotPrices !== slotPrices) return;
      showBank();
      showCharacterCollections();
    };
    slotPrices.load();
    // The vendor packet carries only an ItemExtendedCost id. Stock MerchantFrame needs the
    // corresponding DBC row before it can display honor, arena points and turn-in items.
    const vendorCosts = new VendorCostClient(gatewayInput.value);
    game.vendorCosts = vendorCosts;
    vendorCosts.onLoaded = () => {
      if (game.world === world && game.vendorCosts === vendorCosts && world.vendor) {
        refreshVendorUi("vendor");
      }
    };
    vendorCosts.onStatus = (message, error) => {
      if (game.vendorCosts === vendorCosts && error) notice(message);
    };
    vendorCosts.load();
    // Zones and their rectangles. The server names an area with a number and nothing else, so the
    // zone under the minimap and every shape on the world map come out of this table.
    const areas = new AreaClient(gatewayInput.value);
    game.areas = areas;
    areas.onStatus = (message, error) => {
      if (game.areas !== areas) return;
      if (error) notice(message);
      terrainStatus.className = error ? "error" : "muted";
      terrainStatus.textContent = message;
    };
    areas.load();
    // Where pictures come from, and it is set *before* anything that draws one.
    //
    // It used to be five lines below `modules.load()`, and it worked by luck: the loader's first
    // act is `await fetch('/modules/index')`, so the origin was always assigned before a window
    // was rendered. The failure that luck was hiding is invisible — a window rendered with
    // `textureUrl: undefined` produces a DOM byte-identical to one whose every picture answered
    // 400, `src=""` on both — so a reordering that broke it would have cost another session of
    // empty windows and nothing would have said why.
    game.gatewayOrigin = new URL(gatewayInput.value.replace(/^ws/, "http")).origin;
    // Keep a complete fallback ready during loading and when switching back in the same world.
    installNativeWowUiSkin(game.gatewayOrigin);
    mountNativeCharacterPortrait(characterModel);
    // The 2D overlay draws creature icons on a canvas and cannot read `game` — it is what
    // `game/Context.ts` imports its camera constants from, so the import back would be a cycle.
    if (game.scene) game.scene.gatewayOrigin = game.gatewayOrigin;
    // What the modules on this machine ship for the client: windows, message schemas, stylesheets.
    // Loaded here rather than at start-up because a window is only useful once there is a session
    // behind it, and because the packet registry it fills belongs to this world client and goes
    // with it.
    if (tswowAddonsEnabled) {
      const modules = createModuleLoader(gatewayInput.value, world.customPackets);
      game.modules = modules;
      modules.onStatus = (message, error) => {
        // Only a problem, and only ever in grey — the same shape as `soundProblem` below, for the
        // same two reasons. A module file that will not load is worth a status line and nothing
        // louder: every built-in window works without one, and the whole list is in the diagnostics
        // window's «Окна» and «Пакеты» tabs with the file that carried each problem. And this line
        // belongs to `showWorldState`, which repaints its *text* once a frame and never its class —
        // so a colour left here outlives the sentence that justified it and leaves «Объектов в
        // памяти: N» red for the rest of the session. Announcing the ordinary answer (today, on this
        // machine, «модули: файлов для клиента нет») did exactly that on every login, in grey.
        if (game.modules !== modules || !error) return;
        notice(message);
        worldStatus.className = "muted";
        worldStatus.textContent = message;
      };
      modules.onLoaded = () => {
        if (game.modules !== modules) return;
        showUnhandledOpcodes();
      };
      void modules.load();
    }
    // Sound. Three opcodes have carried a `SoundEntries` id into an event since the packet slice
    // and nothing has ever listened; seven sound tables are vendored; the archives hold 19,786
    // `.wav` and 1,194 `.mp3` and no `.ogg` at all, so a browser plays every one without a
    // conversion step. What was missing was the gateway route and this pair of objects.
    forgetGameSounds();
    // And the one piece of combat state that is not a cooldown: whether the last character to stand
    // here was dead. Without this the next one dies again on their first frame in the world.
    forgetCombatSounds();
    const soundKits = new SoundClient(gatewayInput.value);
    const sound = new SoundPlayer(gatewayInput.value);
    game.soundKits = soundKits;
    game.sound = sound;
    const soundProblem = (message: string, error: boolean): void => {
      // A sound that will not load is worth a status line and nothing louder: the client is
      // playable in silence, which is what it was until this slice.
      if (game.sound !== sound || !error) return;
      worldStatus.className = "muted";
      worldStatus.textContent = message;
    };
    soundKits.onStatus = soundProblem;
    // A batch landing is the only moment a sound that was asked for too early can still be played.
    soundKits.onLoaded = () => {
      retryPendingSounds();
      flushTextEmoteSounds();
    };
    soundKits.loadSpellKits();
    // And the weapon tables, for the same reason and at the same moment: 4,671 bytes fetched once,
    // because the noise of a blow belongs to the blow and a round trip puts it afterwards.
    soundKits.loadWeaponSounds();
    sound.onStatus = soundProblem;
    applySoundVolumes();
    // The baked minimap pictures. The index is per map and is fetched on the first frame that
    // needs a tile, so entering a world costs nothing until the character is actually standing in it.
    const minimapTiles = new MinimapTileClient(gatewayInput.value);
    game.minimapTiles = minimapTiles;
    minimapTiles.onStatus = (message, error) => {
      if (game.minimapTiles !== minimapTiles || !error) return;
      if (error) notice(message);
      terrainStatus.className = "error";
      terrainStatus.textContent = message;
    };
    // The world map's parchment. A zone is twelve tiles plus its exploration overlays, and the
    // gateway publishes a whole picture on the first miss rather than a tile per process.
    const mapArt = new TextureBitmapCache(gatewayInput.value, 96);
    game.mapArt = mapArt;
    // What is solid: the server's own vmap meshes, placed by the same spawns the server places
    // them with. Built lazily around wherever the player is standing.
    const collision = new CollisionSource(gatewayInput.value);
    game.collision = collision;
    collision.onStatus = (message, error) => {
      if (game.collision !== collision) return;
      if (error) notice(message);
      environmentStatus.className = error ? "error" : "muted";
      environmentStatus.textContent = message;
    };
    collision.models.onStatus = collision.onStatus;
    // The same models are where a building's own water lives: a WMO carries liquid the tile under
    // it knows nothing about, and Stormwind's canals are five grids inside the city model.
    //
    // Named the way the collision route names things, which is not the way the renderer does. A
    // visual placement carries the archive path — `WORLD\WMO\AZEROTH\BUILDINGS\STORMWIND\STORMWIND.WMO`
    // — while the server's own `.vmtile` carries the bare file, and the route's own pattern accepts
    // no separators at all. Handing it the path asked for a model that cannot exist and got a 404
    // for every building in view, cached as a permanent "no such model".
    //
    // Asked for every building in view, however far: its water is visible from the far end of a
    // city, which the collision range is not. What keeps that from costing the collision world
    // anything is on the other side — a landing it was not waiting for no longer rebuilds it.
    game.renderer?.setCollisionModels((name) => collision.models.model(collisionModelName(name)));
    characterStatus.className = "success";
    characterStatus.textContent = `World login подтверждён: map ${location.map}, ${location.x.toFixed(2)}, ${location.y.toFixed(2)}, ${location.z.toFixed(2)}.`;
    worldStatus.className = "success";
    showSpells();
    void loadSpellMetadata(world);
    showAuras();
    void loadAuraMetadata(world);
    // The quest log lives in the character's own fields and is already there; what it needs is the
    // description of each quest, and the marks over the heads nearby.
    requestMissingQuestTemplates();
    showQuestTracker();
    world.requestQuestGiverStatus();
    world.requestCompletedQuests();
    world.requestPlayedTime();
    // The eight account slots are asked for here rather than at construction: they are answered
    // per character, and the character is only known now.
    settingsStore.attach(world);
    for (const store of macroStores) store.attach(world);
    applySettings();
    watchMinimapRotation((rotate) => {
      settingsStore.set({ ...settingsStore.value, minimapRotate: rotate });
    });
    showWorldState(world.state);
    // Switching UI retires the previous VM and its borrowed canvases, without reconnecting.
    // The module remains lazy when both original UI and TSWoW addons are disabled.
    if (!tswowAddonsEnabled) systemLine("Аддоны TSWoW отключены. Включить: Настройки → Интерфейс → Аддоны TSWoW.");
    const uiMode = new FrameXmlModeController(tswowAddonsEnabled, async () => {
      const module = await import("../framexml/FrameXmlWorldMount.js");
      return {
        unmount: module.unmountFrameXmlVertical,
        mount: async (frameXmlEnabled: boolean) => {
          const finishModuleCommandLoad = beginModuleCommandLoad(world);
          try {
            return await module.mountFrameXmlVertical({
              addonsOnly: !frameXmlEnabled,
              includeActiveTsAddons: tswowAddonsEnabled,
              ...(savedVariablesScope ? { savedVariablesScope } : {}),
            });
          } finally { finishModuleCommandLoad(); }
        },
      };
    }, (message) => {
      if (entryLifecycle.isCurrent(generation) && game.world === world) systemLine(message);
    });
    const syncUiMode = (): void => {
      if (entryLifecycle.isCurrent(generation) && game.world === world) {
        void uiMode.select(frameXmlFlagEnabled(window.location.search, settingOn("originalFrameXml")));
      }
    };
    entryLifecycle.track(() => uiMode.dispose());
    entryLifecycle.track(watchSettingsApplied(syncUiMode));
    syncUiMode();
  } catch (error) {
    if (game.assetWarmup === assetWarmup) {
      assetWarmup?.dispose();
      game.assetWarmup = undefined;
    }
    // loginCharacter can fail after the coordinator was bound but before this world becomes
    // usable. Retire only the objects created by this enter attempt: a newer login may already
    // have installed its own coordinator while this promise was unwinding.
    if (game.spellVisualCoordinator === spellVisualCoordinator) {
      spellVisualCoordinator.clear();
      game.spellVisualCoordinator = undefined;
    }
    if (game.spellVisuals === spellVisuals) {
      spellVisuals.onLoaded = undefined;
      game.spellVisuals = undefined;
      // The kit client is this closure's own, so it is retired on the same condition rather than
      // on one of its own: it exists to serve the coordinator that has just been retired above.
      spellVisualKits.onLoaded = undefined;
    }
    // Retiring the world can reject a pending login read. Its old error must not hide the loading
    // screen or replace the status of the new world that has already taken over.
    if (!entryLifecycle.isCurrent(generation) || game.world !== world) return;
    hideLoadingScreen();
    const message = error instanceof Error ? error.message : String(error);
    characterStatus.className = "error";
    characterStatus.textContent = message;
    if (onBusy) onBusy.disabled = false;
    // The way back. It used to be «hide the world panel and leave everything else standing», which
    // was survivable only because the DOM character panel was still behind it; with the GlueXML
    // screens as the front door there is nothing behind it at all, and a half-built world left in
    // `game` is what the next attempt would inherit. `leaveWorld` hides the panel, clears the
    // context (the dead death layer included) and returns the player to the screen the session came
    // from. The generation and world-identity guard above keeps a retired attempt off this path.
    clearQuestLog();
    leaveWorld("enter-failed", message);
  }
}
