import {
  characterClass, characterFace, characterFacial, characterGender, characterHair, characterHairColor,
  characterName, characterPanel, characterRace, characterSkin, characterStatus,
  characters, createForm, createSubmit, form, gatewayInput, loginSubmit, passwordInput, realms, status,
  tokenInput, usernameInput, worldPanel,
} from "../ui/Dom.js";
import { clearWorldContext, game } from "../game/Context.js";
import { cancelItemTarget } from "../game/SpellCursor.js";
import { CharacterSummary } from "../../world/CharacterProtocol.js";
import { enterWorld, retireEnterWorldSession } from "./EnterWorld.js";
import { canSelectRealm, REALM_FLAG_OFFLINE, type RealmInfo } from "../../auth/AuthProtocol.js";
import { showDeath, showLoot, showTrainer, showVendor } from "../ui/Npc.js";
import { showAuctions, showDuel, showGroup, showLfg, showMail, showTrade } from "../ui/Social.js";
import { showGuild } from "../ui/Guild.js";
import { className, raceName } from "../ui/UnitSnapshot.js";
import {
  CreationMemo, LatestAppearanceRequest, creationClasses, creationRaces, fetchCharacterCreation, type CreationOption,
} from "../ui/CharacterCreation.js";
import { resetGuildBank } from "../ui/GuildBank.js";
import { resetCalendar } from "../ui/Calendar.js";
import { closeProfessions } from "../ui/Professions.js";
import { closeSocketing } from "../ui/Socketing.js";
import { resetSocialPanel } from "../ui/SocialPanel.js";
import { resetScoreboard } from "../ui/Scoreboard.js";
import { resetArenaWindow } from "../ui/ArenaWindow.js";
import { resetLootRolls } from "../ui/LootRolls.js";
import { resetReadyCheck } from "../ui/ReadyCheck.js";
import { resetBarberShop } from "../ui/BarberShop.js";
import { resetTotems } from "../ui/Totems.js";
import { resetChannelRoster } from "../ui/ChannelRoster.js";
import { resetGmTickets } from "../ui/GmTickets.js";
import { resetPetition } from "../ui/Petition.js";
import { clearReputation } from "../ui/Reputation.js";
import { resetAutoQuality } from "../AutoQuality.js";
import { clearBagSearch } from "../ui/Bags.js";
import { resetMacroWindow, macroStores } from "../ui/Macros.js";
import { resetPetBar } from "../ui/PetBar.js";
import { resetLoadingScreen } from "../ui/LoadingScreen.js";
import { closeGameMenu, resetLogoutPending } from "../ui/GameMenu.js";
import { closeKeyBindingsWindow } from "../ui/KeyBindings.js";
import { closeGameWindows } from "../ui/Windows.js";
import { clearQuestLog } from "../ui/QuestLog.js";
import { bindDeathScreenEffect, resetDeathScreenEffect } from "../ui/DeathScreenEffect.js";
import { settingsStore } from "../ui/Settings.js";
import { detachInputAccount } from "../input/InputAccountWiring.js";
import { WebSocketByteStream } from "../../transport/WebSocketByteStream.js";
import { WorldClient } from "../../world/WorldClient.js";
import { bindPlayerHud } from "../ui/Frames.js";
import { AuthSessionResult, loginToRealmList } from "../../auth/login.js";
import { forgetMovementState } from "../input/Movement.js";
import { CHARACTER_OPTIONS_VERSION, isCharacterOptions, type CharacterOptions } from "../CharacterAtlas.js";
import { clientLocale } from "../Environment.js";
import { frontDoorHost, type WorldExit } from "../glue/FrontDoor.js";
import { describeFailure, type GlueAuthMessage, type GlueFailureContext } from "../glue/GlueMessages.js";
import { adoptWorldConnection } from "./WorldAdoption.js";
import { LatestConnection } from "./LatestConnection.js";
/**
 * What the legacy forms (`?legacy-login=1`) print for a failure: the coded message's plain text, as
 * the glue screens show it without a corpus (`describeFailure`: a refused login, a dropped socket, a
 * server behind the gateway gone…). The exception's own English goes to the log only.
 */
function failureText(error: unknown, context: GlueFailureContext): string {
  console.warn(`[legacy-login] ${context} failed:`, error instanceof Error ? error.message : String(error));
  return describeFailure(error, context).text ?? "Ошибка";
}

export function worldGatewayUrl(): string {
  const url = new URL(gatewayInput.value);
  url.pathname = "/world";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function refreshCharacters(): Promise<void> {
  const world = game.world;
  if (!world) return;
  const list = await world.characters();
  if (game.world === world) showCharacters(list);
}

/** What `/dbc/character-creation` said, which gateway said it, and when that stops counting. */
const creation = new CreationMemo();

function setOptions(select: HTMLSelectElement, options: ReadonlyArray<CreationOption>): void {
  const chosen = select.value;
  select.replaceChildren();
  for (const { id, name } of options) {
    const option = document.createElement("option");
    option.value = String(id);
    option.textContent = name;
    select.append(option);
  }
  // Kept if it is still on offer, so refilling the class list on a race change does not silently
  // move the choice — and so the race the player picked is still picked after the fetch lands.
  if (chosen && options.some((option) => String(option.id) === chosen)) select.value = chosen;
}

/**
 * Fills the three lists on the creation form.
 *
 * They were ten `<option>` elements of English in the page markup — "Night Elf", "Death Knight" —
 * on the one screen a new player sees before anything else, in a client that is Russian everywhere
 * else. Then they were ten names compiled into this build, which is one list too few in the other
 * direction: `ChrRaces` holds 21 rows and a module may add more, and neither the form nor the
 * frames had any way to know. Now the dataset says who exists, what they are called and which
 * classes each race may take, and the compiled names are the floor under a gateway that is down.
 *
 * The lists are built twice on purpose: once synchronously from whatever is already known, so the
 * form is never empty while a fetch is in flight, and again when the answer lands.
 */
function fillCreationLists(): void {
  // Asked once per gateway rather than once per session: the address is a field on this very
  // screen, and a player who corrects it should not be left with the previous server's races. The
  // memo drops the previous answer as it hands the new address over, so the lists below are drawn
  // from the compiled floor and not from a stranger's dataset while the new one is being asked.
  const asking = creation.aimAt(gatewayInput.value);
  fillRaceAndClass();
  if (characterGender.options.length === 0) {
    setOptions(characterGender, [{ id: 0, name: "Мужской" }, { id: 1, name: "Женский" }]);
  }
  if (asking === undefined) return;
  void (async () => {
    // Nothing to redraw if the gateway is unreachable, or if it answered about a gateway the
    // player has since left: the compiled lists are already standing, and an unreachable one is
    // asked again next time because the memo forgets that it was asked.
    if (!creation.accept(asking, await fetchCharacterCreation(asking))) return;
    fillRaceAndClass();
    void fillAppearance();
    // The cards on the left carry a race and a class name too, and they were drawn before this.
    renderCharacters(shownCharacters);
  })();
}

/**
 * The race list, and the class list the chosen race may actually take.
 *
 * `CharBaseInfo` is the pair table, so the classes depend on the race — which is why this runs
 * again on every race change and not only once.
 */
function fillRaceAndClass(): void {
  setOptions(characterRace, creationRaces(creation.data));
  const race = Number.parseInt(characterRace.value, 10);
  setOptions(characterClass, creationClasses(creation.data, Number.isInteger(race) ? race : undefined));
}

/**
 * The five appearance selects, in the order they stand in the form.
 *
 * The order is load-bearing since the faces became per skin: `fillAppearance` walks this list, so
 * the skin is refilled before the faces are asked which skin they belong to.
 */
const LOOK_SELECTS = [
  { select: () => characterSkin, key: "skins" },
  { select: () => characterFace, key: "faces" },
  { select: () => characterHair, key: "hairStyles" },
  { select: () => characterHairColor, key: "hairColors" },
  { select: () => characterFacial, key: "facialHairs" },
] as const;

/** The last answer, so choosing a skin can refill the faces without asking the gateway again. */
let lookOptions: CharacterOptions | undefined;
const latestAppearance = new LatestAppearanceRequest();

/** Every index one axis offers — which for the faces depends on the skin that is chosen. */
function offeredLooks(key: (typeof LOOK_SELECTS)[number]["key"]): readonly number[] {
  if (!lookOptions) return [];
  if (key !== "faces") return lookOptions[key];
  // A face row is keyed on `(face, skin)`, and the two do not make a full rectangle: the
  // death-knight skins carry three faces where the ordinary ones carry twenty-four, which is 780
  // of the offered pairs across the twenty playable profiles. The union is the fallback for a skin
  // the answer says nothing about; `facesBySkin` is what binds.
  const skin = Number.parseInt(characterSkin.value, 10);
  return lookOptions.facesBySkin[skin] ?? lookOptions.faces;
}

/** One select refilled from a list of indices, keeping the chosen one if it is still on offer. */
function fillLook(element: HTMLSelectElement, values: readonly number[]): void {
  const label = element.parentElement;
  // Nothing to choose hides the control rather than offering an empty list. A human female has no
  // facial-hair row of any kind; a tauren has seven, and they are his horns.
  if (label) label.hidden = values.length === 0;
  const chosen = element.value;
  element.replaceChildren();
  for (const [place, value] of values.entries()) {
    const option = document.createElement("option");
    // The index is what the wire carries; the number the player reads is its place in the list,
    // because a gap in the indices is not something to explain on the creation screen.
    option.value = String(value);
    option.textContent = String(place + 1);
    element.append(option);
  }
  // Kept if it is still on offer, so switching sex back and forth does not reshuffle the face.
  if (chosen && values.includes(Number(chosen))) element.value = chosen;
}

/**
 * Fills the five appearance selects with what this race and sex actually have.
 *
 * Asked of the gateway rather than guessed, because the choices are per race *and* per sex and are
 * nothing like uniform: a human male has 17 hairstyles and a blood elf female 19, and a human
 * female has no facial-hair row at all. Guessing a range would offer numbers the tables do not
 * have, and the server accepts those without complaint — which is how a character ends up bald.
 *
 * Lists of indices now, not counts. The gateway used to answer the largest index that exists plus
 * one, so every gap inside that range was offered with the rest: 1,900 of them over the twenty
 * playable profiles, and the ones that showed were night elf hair colours 8 and 9, which exist for
 * no night elf and drew a flat green wig on 48 of the 3,278 looks the form put up.
 */
async function fillAppearance(): Promise<void> {
  const race = Number.parseInt(characterRace.value, 10);
  const sex = Number.parseInt(characterGender.value, 10);
  const classId = Number.parseInt(characterClass.value, 10);
  const gateway = gatewayInput.value;
  const request = latestAppearance.begin(gateway, race, sex, classId);
  // The old race's indices may be valid numbers for a different look. Hide them as soon as the
  // profile changes so a quick create cannot submit appearance bytes from the previous race.
  if (request.changed) {
    lookOptions = undefined;
    for (const { select } of LOOK_SELECTS) fillLook(select(), []);
  }
  if (!Number.isInteger(race) || !Number.isInteger(sex) || !Number.isInteger(classId)) return;
  try {
    const url = new URL(gateway.replace(/^ws/, "http"));
    const response = await fetch(
      `${url.origin}/dbc/character-options?v=${CHARACTER_OPTIONS_VERSION}&race=${race}&sex=${sex}&class=${classId}`);
    if (!response.ok) throw new Error(`character options returned ${response.status}`);
    const answer: unknown = await response.json();
    if (!latestAppearance.isCurrent(request.serial, gatewayInput.value,
      Number.parseInt(characterRace.value, 10), Number.parseInt(characterGender.value, 10),
      Number.parseInt(characterClass.value, 10))) return;
    // An answer this bundle cannot read is no answer: the five controls are emptied and hidden
    // rather than half-filled from a shape that is not the one they expect.
    lookOptions = isCharacterOptions(answer) ? answer : undefined;
  } catch {
    // The form still works with the default look if the gateway is down. A profile change already
    // hid the previous race's selections above; a retry of the same profile keeps its known look.
    return;
  }
  for (const { select, key } of LOOK_SELECTS) fillLook(select(), offeredLooks(key));
}

/**
 * The list last drawn, so it can be drawn again when the dataset's names arrive.
 *
 * A card says «ур. 12 · Ночной эльф · Друид», and both of those words come out of the name tables.
 * The fetch that fills those tables lands after the cards are already on screen, so without this a
 * character of a custom race would read «Раса 22» until something else redrew the list.
 */
let shownCharacters: CharacterSummary[] = [];

export function showCharacters(list: CharacterSummary[]): void {
  shownCharacters = list;
  fillCreationLists();
  void fillAppearance();
  renderCharacters(list);
}

function renderCharacters(list: CharacterSummary[]): void {
  characters.replaceChildren();
  if (list.length === 0) {
    characters.textContent = "На этом аккаунте пока нет персонажей.";
    return;
  }

  for (const character of list) {
    const card = document.createElement("article");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    const actions = document.createElement("div");
    const enter = document.createElement("button");
    const remove = document.createElement("button");

    title.textContent = character.name;
    details.textContent = [`ур. ${character.level}`, raceName(character.race), className(character.classId)]
      .filter(Boolean).join(" · ");
    actions.className = "actions";
    enter.type = "button";
    enter.textContent = "Войти в мир";
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "Удалить";

    enter.addEventListener("click", () => void enterWorld(character, enter));

    remove.addEventListener("click", async () => {
      if (!game.world || !window.confirm(`Удалить персонажа ${character.name}? Это действие необратимо.`)) return;
      remove.disabled = true;
      try {
        const result = await game.world.deleteCharacter(character.guid);
        if (result !== 71) {
          // The glue screen's words for a refusal it finds no string for (GlueSession.deleteCharacter).
          characterStatus.className = "error";
          characterStatus.textContent = `Удаление отклонено сервером, код ${result}.`;
          remove.disabled = false;
          return;
        }
        characterStatus.className = "success";
        characterStatus.textContent = `${character.name} удалён.`;
        await refreshCharacters();
      } catch (error) {
        characterStatus.className = "error";
        characterStatus.textContent = failureText(error, "world");
        remove.disabled = false;
      }
    });

    actions.append(enter, remove);
    card.append(title, details, actions);
    characters.append(card);
  }
}

/**
 * Everything a world owns, dropped.
 *
 * Was the body of `connectRealm`, and is now called by every route out of a world: changing realms,
 * signing in as somebody else, a completed logout, a lost connection and a failed enter. The
 * duplicate that used to sit in the login form's submit handler was a hand-copied *half* of it —
 * no module unload, no sound close, no settings flush, no minimap clear — which is exactly the kind
 * of divergence a second front door multiplies rather than reveals.
 *
 * `clearWorldContext` had no caller anywhere in `src/` before this list existed. The half of it
 * that hurt was the modules: `enterWorld` builds a fresh loader and overwrites `game.modules`, so
 * the previous session's windows stayed in the registry and the second login in one tab refused
 * every one of them as a duplicate — measured, 0 windows and «окно "proverochnyy-ekran" уже
 * зарегистрировано модулем «test»» — while `/testUI` went on toggling the first session's handle.
 *
 * Deliberately does **not** close the socket. Who owns the connection differs by front door: the
 * DOM flow opens it in `connectRealm` and closes it there, while the GlueXML screens open it and
 * only *lend* it to the world. Closing here would take a live realm connection away from the glue
 * session that is about to draw its character list over it.
 */
export function resetWorldUi(): void {
  retireEnterWorldSession();
  game.store?.detach();
  clearWorldContext();
  // A spell or item waiting for an item dies with the world (2.05): the cast cursor goes with it now,
  // not at the next question asked of it.
  cancelItemTarget();
  resetLogoutPending();
  closeGameMenu();
  closeKeyBindingsWindow();
  // Close both markup and runtime windows before the viewport is shown for a new character.
  // The world reference is already gone, so this cannot send service-close packets to the old realm.
  closeGameWindows();
  clearQuestLog();
  showLoot();
  showDeath();
  showVendor();
  showTrainer();
  showGroup();
  showTrade();
  showDuel();
  showMail();
  showGuild();
  resetGuildBank();
  resetCalendar();
  closeProfessions();
  closeSocketing();
  resetSocialPanel();
  resetScoreboard();
  resetArenaWindow();
  resetLootRolls();
  resetReadyCheck();
  resetBarberShop();
  resetTotems();
  resetChannelRoster();
  resetGmTickets();
  resetPetition();
  clearReputation();
  resetAutoQuality();
  clearBagSearch();
  resetMacroWindow();
  resetPetBar();
  resetLoadingScreen();
  // The grey of death belongs to the world being left. Its own listener is already gone with the
  // store detached above, so nothing would ever take the layer down again on its own.
  resetDeathScreenEffect();
  // Pending writes go out before the world does, so a setting changed in the last second survives.
  settingsStore.detach();
  for (const store of macroStores) store.detach();
  detachInputAccount();
  showAuctions();
  showLfg();
  // The connection is gone, so the keys are dropped rather than released: a stop packet now
  // would be written to a socket that no longer has a session behind it.
  forgetMovementState();
  worldPanel.hidden = true;
  document.body.classList.remove("world-active");
}

/**
 * The realm this client is connected to, so a return from the world can rebuild the character list.
 *
 * Only the DOM flow needs it: the GlueXML front door keeps the realm inside its own `GlueSession`.
 */
let currentRealm: RealmInfo | undefined;
/** A later realm or account choice retires each pending socket and world handshake. */
const realmConnections = new LatestConnection();

/**
 * A live connection becomes this client's world.
 *
 * Shared with the GlueXML front door, which reaches the same point by a different road: it already
 * has an authenticated `WorldClient` on the realm the player chose, and adopting it is what makes
 * the world half of the client work over that connection instead of opening a second one.
 */
export function adoptWorld(world: WorldClient): void {
  adoptWorldConnection(game, world, {
    bindHud: bindPlayerHud,
    // Same update path as the HUD, for the same reason: the two read the same character and must
    // never disagree about whether it is alive.
    bindDeathScreen: bindDeathScreenEffect,
    onListenerError: (error) => console.error("Панель интерфейса не пережила обновление", error),
  });
}

/**
 * Every way out of a world, in one place.
 *
 * Three callers, all of them in `EnterWorld.ts` because that is where the world's own events are
 * bound: `SMSG_LOGOUT_COMPLETE`, the read loop dying, and an enter attempt that failed. Where the
 * player lands depends on which interface opened the session — the glue screens if they are the
 * front door, the DOM character panel otherwise — and that decision is made once, here.
 *
 * Legacy reconnects rather than reusing the connection, and that is not caution: `characters()`
 * reads the socket through `#waitFor` while `loginCharacter` has left `#readWorld` reading the same
 * socket, so a character list asked for over a used-world connection is two readers on one stream.
 * `connectRealm` closes and reopens, which the session key still allows.
 */
export function leaveWorld(exit: WorldExit, message?: GlueAuthMessage): void {
  // Held before the reset, because `clearWorldContext` is what drops `game.world`: reaching for it
  // afterwards would find `undefined` and leave the socket open for the life of the tab.
  const world = game.world;
  resetWorldUi();
  const front = frontDoorHost();
  if (front) {
    front.returnFromWorld(exit, message);
    return;
  }
  characterPanel.hidden = false;
  characters.replaceChildren();
  if (message) {
    // This panel has no corpus to look the key up in, so it prints the message's plain text.
    characterStatus.className = "error";
    characterStatus.textContent = message.text ?? "Ошибка";
  }
  // Whichever exit this is, the connection the client was playing on is finished with: a logout
  // ended it server-side, a failed enter left it in an unknown read state, and a lost one is
  // already gone. `connectRealm` would normally be the one to close it, but `resetWorldUi` has
  // already taken the reference off the context, so it is closed here.
  world?.close();
  // A dead socket has nothing useful to reconnect *to* — the server is the thing that went away —
  // so the realm list above the panel is the honest next step, and the player picks a world again.
  if (exit === "connection-lost" || exit === "relogin") return;
  if (currentRealm) void connectRealm(currentRealm);
}

export async function connectRealm(realm: RealmInfo): Promise<void> {
  if (!canSelectRealm(realm)) return;
  const session = game.session;
  if (!session) return;
  const attempt = realmConnections.begin();
  game.world?.close();
  currentRealm = realm;
  resetWorldUi();
  characterPanel.hidden = false;
  characters.replaceChildren();
  characterStatus.className = "";
  characterStatus.textContent = `Подключение к ${realm.name}…`;

  let stream: WebSocketByteStream | undefined;
  try {
    stream = await realmConnections.accept(attempt, WebSocketByteStream.connect(worldGatewayUrl()));
    if (!stream) return;
    const world = await realmConnections.accept(attempt, WorldClient.connect(stream, {
      username: session.username,
      sessionKey: session.sessionKey,
      realmId: realm.id,
      realmName: realm.name,
      realmType: realm.type,
    }));
    if (!world) {
      // The obsolete WorldClient has already closed the socket it owns.
      stream = undefined;
      return;
    }
    stream = undefined;
    // The previous store was already detached with the previous connection, at the top of
    // `resetWorldUi`; this one lives exactly as long as the client it watches.
    adoptWorld(world);
    characterStatus.className = "success";
    characterStatus.textContent = `Worldserver ${realm.name} подключён.`;
    await refreshCharacters();
  } catch (error) {
    if (realmConnections.isCurrent(attempt)) {
      characterStatus.className = "error";
      characterStatus.textContent = failureText(error, "world");
    }
  } finally {
    stream?.close();
  }
}

export function showRealms(session: AuthSessionResult): void {
  realms.replaceChildren();
  if (session.realms.length === 0) {
    realms.textContent = "Authserver не вернул доступных миров.";
    return;
  }

  for (const realm of session.realms) {
    const card = document.createElement("article");
    const title = document.createElement("strong");
    const details = document.createElement("span");
    const connect = document.createElement("button");
    title.textContent = realm.name;
    const availability = realm.locked ? " · закрыт" : (realm.flags & REALM_FLAG_OFFLINE) !== 0 ? " · недоступен" : "";
    details.textContent = `${realm.address} · персонажей: ${realm.characters}${availability}`;
    connect.type = "button";
    connect.textContent = "Показать персонажей";
    connect.disabled = !canSelectRealm(realm);
    connect.addEventListener("click", () => void connectRealm(realm));
    card.append(title, details, connect);
    realms.append(card);
  }
}

/** The login and character-creation forms. Registered once, at start-up. */
export function wireLoginForms(): void {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    loginSubmit.disabled = true;
    realmConnections.invalidate();
    game.world?.close();
    currentRealm = undefined;
    // The other way out of a world, and now literally the same function: signing in again as
    // somebody else leaves as much behind as changing realms does. It used to call a hand-copied
    // half of the list — four panels out of twenty, no module unload, no settings flush — so the
    // second account in one tab inherited the first one's windows and macros.
    resetWorldUi();
    characterPanel.hidden = true;
    realms.replaceChildren();
    status.className = "";
    status.textContent = "Подключение к gateway…";

    let stream: WebSocketByteStream | undefined;
    try {
      stream = await WebSocketByteStream.connect(gatewayInput.value);
      status.textContent = "Проверка аккаунта через SRP6…";
      const token = tokenInput.value;
      game.session = await loginToRealmList(stream, {
        username: usernameInput.value,
        password: passwordInput.value,
        locale: clientLocale(),
        ...(token ? { token } : {}),
      });
      status.className = "success";
      status.textContent = `Авторизация успешна: ${game.session.username}`;
      showRealms(game.session);
    } catch (error) {
      game.session = undefined;
      status.className = "error";
      status.textContent = failureText(error, "auth");
    } finally {
      passwordInput.value = "";
      stream?.close();
      loginSubmit.disabled = false;
    }
  });

  // A draenei has no beard and a blood elf has nineteen hairstyles: the lists are per race and per
  // sex, so they are refilled whenever either changes. The class list goes with the race too — a
  // night elf has no shaman and a blood elf no druid, and `CharBaseInfo` is where that is written.
  characterRace.addEventListener("change", () => {
    fillRaceAndClass();
    void fillAppearance();
  });
  characterClass.addEventListener("change", () => void fillAppearance());
  characterGender.addEventListener("change", () => void fillAppearance());
  // And the faces are per skin on top of that — a face row is keyed on the pair — so the one
  // dependent list is refilled from the answer already in hand, with no second request.
  characterSkin.addEventListener("change", () => fillLook(characterFace, offeredLooks("faces")));

  createForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!game.world) return;
    createSubmit.disabled = true;
    characterStatus.className = "";
    characterStatus.textContent = `Создание ${characterName.value}…`;
    try {
      // The five appearance bytes, which this form never sent. `buildCreateCharacter` defaults
      // each of them to zero and zero is legal, so the server accepted every character created
      // here with skin 0, face 0 and hair 0 — and for a human male hair 0 is the bald row, three
      // empty texture slots and geoset 0. The character was not drawn wrong; it was created bald.
      const look = (select: HTMLSelectElement): number => {
        const value = Number.parseInt(select.value, 10);
        return Number.isInteger(value) && value >= 0 ? value : 0;
      };
      const result = await game.world.createCharacter({
        name: characterName.value,
        race: Number.parseInt(characterRace.value, 10),
        classId: Number.parseInt(characterClass.value, 10),
        gender: Number.parseInt(characterGender.value, 10),
        skin: look(characterSkin),
        face: look(characterFace),
        hairStyle: look(characterHair),
        hairColor: look(characterHairColor),
        facialHair: look(characterFacial),
      });
      if (result !== 47) {
        // GlueCreation's words for a refusal it finds no string for.
        characterStatus.className = "error";
        characterStatus.textContent = `Сервер отказал в создании, код ${result}.`;
        return;
      }
      characterStatus.className = "success";
      characterStatus.textContent = `${characterName.value} создан.`;
      characterName.value = "";
      await refreshCharacters();
    } catch (error) {
      characterStatus.className = "error";
      characterStatus.textContent = failureText(error, "create");
    } finally {
      createSubmit.disabled = false;
    }
  });

}
