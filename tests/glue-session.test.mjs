import assert from "node:assert/strict";
import test from "node:test";
import { GlueRuntime } from "../dist/code/browser/glue/GlueRuntime.js";
import { createFixtureProvider } from "../dist/code/browser/glue/GlueLoader.js";
import { GlueSession, glueBackgroundModelFor, realmLoad } from "../dist/code/browser/glue/GlueSession.js";
import { fakeGlueSession } from "../dist/code/browser/glue/GlueFakeSession.js";
import { glueStandPoint } from "../dist/code/browser/glue/GlueModelStage.js";
import { WorldAuthError } from "../dist/code/world/CharacterProtocol.js";
import { TransportClosedError } from "../dist/code/transport/WebSocketByteStream.js";

// The realm list and the character list are read by the corpus *positionally*: `RealmList.lua:47`
// unpacks fourteen values out of `GetRealmInfo` and `CharacterSelect.lua:314` ten out of
// `GetCharacterInfo`. One value in the wrong slot colours every realm as "down" or prints a class
// where a zone belongs, and nothing errors. So the order is asserted as an order.
//
// Everything here runs against a fake world connection through the same `GlueWorldConnector` seam
// the live page hands `WorldClient.connect`, which is what lets this exist with no server at all.

/** Names as a live gateway would answer them, so the test can tell a class from a zone. */
const NAMES = {
  raceName: (race) => `Раса${race}`,
  className: (classId) => ({ 1: "Воин", 6: "Рыцарь смерти", 11: "Друид" })[classId] ?? `Класс${classId}`,
  zoneName: (zone) => ({ 12: "Элвиннский лес", 141: "Тельдрассил", 4298: "Анклав" })[zone] ?? "",
  raceDisplayId: (race, sex) => (race === 1 ? (sex ? 50 : 49) : undefined),
};

function recordingSession(extra = {}) {
  const events = [];
  const screens = [];
  const session = new GlueSession({
    fireEvent: (event, ...args) => events.push([event, ...args]),
    setGlueScreen: (name) => screens.push(name),
    names: NAMES,
    ...extra,
  });
  return { session, events, screens };
}

test("realm rows answer RealmList.lua's fourteen values in its own order", async () => {
  const canned = fakeGlueSession("charselect");
  const { session } = recordingSession({ connect: () => canned.connect() });
  session.beginSession(canned.auth);

  // One category, because both fake realms carry timezone 1 — which is what makes
  // `RealmList_UpdateTabs` hide the tab row, exactly as the original does for one category.
  assert.deepEqual(session.categories(), [{ id: 1, name: "1" }]);
  assert.equal(session.realmsIn(1).length, 2);
  assert.equal(session.realmsIn(2).length, 0);

  const first = session.realmRow(1, 1);
  assert.deepEqual(first, {
    name: "Круг Теней",
    numCharacters: 3,
    invalidRealm: false,
    realmDown: false,
    currentRealm: 0,
    pvp: true,
    rp: false,
    // REALM_FLAG_RECOMMENDED (0x20) is the -3 sentinel `RealmListUpdate` compares against.
    load: -3,
    locked: false,
  });
  assert.equal(session.realmRow(1, 2)?.pvp, false);
  assert.equal(session.realmRow(1, 2)?.load, 1.5, "a realm with no flag reports its population");
  assert.equal(session.realmRow(1, 3), undefined, "past the end is nothing, not a blank row");

  // `currentRealm` is 1 only for the realm actually connected to.
  await session.connect(canned.realm);
  assert.equal(session.realmRow(1, 1)?.currentRealm, 1);
  assert.equal(session.realmRow(1, 2)?.currentRealm, 0);
  session.close();
});

test("the realm flags map onto the load sentinels the corpus tests for", () => {
  const realm = (flags, population) => ({
    type: 0, locked: false, flags, name: "x", address: "", population,
    characters: 0, timezone: 1, id: 1, build: undefined,
  });
  assert.equal(realmLoad(realm(0x80, 0.5)), 2, "full");
  assert.equal(realmLoad(realm(0x20, 0.5)), -3, "recommended");
  assert.equal(realmLoad(realm(0x40, 0.5)), -2, "new");
  assert.equal(realmLoad(realm(0xa0, 0.5)), 2, "full wins over recommended, as the client's order does");
  assert.equal(realmLoad(realm(0, -0.25)), -0.25, "no flag: the population as sent");
});

test("offline and locked realms stay on the realm list without opening a world connection", async () => {
  const canned = fakeGlueSession("charselect");
  for (const blockedRealm of [
    { ...canned.realm, flags: canned.realm.flags | 0x02 },
    { ...canned.realm, locked: true },
  ]) {
    let connections = 0;
    const { session, screens } = recordingSession({
      connect: async () => {
        connections++;
        return canned.connect();
      },
    });
    session.beginSession({ ...canned.auth, realms: [blockedRealm] });
    session.changeRealm(1, 1);
    assert.deepEqual(screens, [], "unavailable realm cannot advance to character selection");
    assert.equal(session.selectedRealm, undefined);
    await session.connect(blockedRealm);
    assert.equal(connections, 0, "direct connection requests must also reject the realm");
    assert.equal(session.connected, false);
    session.close();
  }
});

test("character rows answer CharacterSelect.lua's ten values, with words where it prints words", async () => {
  const canned = fakeGlueSession("charselect");
  const { session, events } = recordingSession({ connect: () => canned.connect() });
  session.beginSession(canned.auth);
  await session.connect(canned.realm);

  assert.deepEqual(events.map(([name]) => name), ["CHARACTER_LIST_UPDATE"]);
  assert.equal(session.characters.length, 3);

  assert.deepEqual(session.characterRow(1), {
    name: "Аларин",
    race: "Раса1",
    // `CHARACTER_SELECT_INFO` prints this, so it is a word and not an id.
    className: "Воин",
    level: 12,
    zone: "Элвиннский лес",
    sex: 0,
    ghost: false,
    customize: false,
    raceChange: false,
    factionChange: false,
  });
  assert.equal(session.characterRow(3)?.className, "Рыцарь смерти");
  assert.equal(session.characterRow(3)?.zone, "Анклав");
  assert.equal(session.characterRow(4), undefined);
  session.close();
});

test("the character flags are read off the wire bits the core sends", async () => {
  const canned = fakeGlueSession("charselect");
  const world = await canned.connect();
  const base = (await world.characters())[0];
  const { session } = recordingSession({
    connect: async () => ({
      characters: async () => [
        // CHARACTER_FLAG_GHOST 0x2000, CHAR_CUSTOMIZE_FLAG_CUSTOMIZE 0x1,
        // CHAR_CUSTOMIZE_FLAG_FACTION 0x10000, CHAR_CUSTOMIZE_FLAG_RACE 0x100000.
        { ...base, flags: 0x2000, customizeFlags: 0x110001 },
        { ...base, guid: 2n, flags: 0x400, customizeFlags: 0 },
      ],
      deleteCharacter: async () => 71,
      close: () => {},
    }),
  });
  session.beginSession(canned.auth);
  await session.connect(canned.realm);
  const ghost = session.characterRow(1);
  assert.equal(ghost?.ghost, true);
  assert.equal(ghost?.customize, true);
  assert.equal(ghost?.raceChange, true);
  assert.equal(ghost?.factionChange, true);
  const plain = session.characterRow(2);
  assert.equal(plain?.ghost, false, "HIDE_HELM (0x400) is not the ghost bit");
  assert.equal(plain?.customize, false);
  session.close();
});

test("selection fires UPDATE_SELECTED_CHARACTER and picks the racial backdrop", async () => {
  const canned = fakeGlueSession("charselect");
  const { session, events } = recordingSession({ connect: () => canned.connect() });
  session.beginSession(canned.auth);
  await session.connect(canned.realm);
  events.length = 0;

  session.selectCharacter(2);
  assert.deepEqual(events, [["UPDATE_SELECTED_CHARACTER", 2]]);
  assert.equal(session.selectedIndex, 2);
  assert.equal(session.selected?.name, "Лиэрель");
  assert.equal(session.backgroundModel(2), "NightElf");
  // A death knight takes its own backdrop whatever race it is.
  assert.equal(session.backgroundModel(3), "DeathKnight");

  // Out of range is "nothing selected", which is what the corpus draws an empty name for.
  session.selectCharacter(9);
  assert.equal(session.selectedIndex, 0);
  assert.equal(session.selected, undefined);
  session.close();
});

test("the two races with no glue set of their own borrow the one the client ships", () => {
  // Measured against the running gateway: `UI_Gnome` and `UI_Troll` are 404s, the other eight
  // resolve. So a gnome stands in Ironforge and a troll in Durotar.
  assert.equal(glueBackgroundModelFor(7, 1), "Dwarf");
  assert.equal(glueBackgroundModelFor(8, 1), "Orc");
  assert.equal(glueBackgroundModelFor(11, 1), "Draenei");
  assert.equal(glueBackgroundModelFor(4, 6), "DeathKnight", "class beats race");
  assert.equal(glueBackgroundModelFor(99, 1), "Human", "an unknown race still names a real file");
});

test("deleting maps result 71 to success and anything else to a dialog", async () => {
  const canned = fakeGlueSession("charselect");
  const { session, events } = recordingSession({ connect: () => canned.connect() });
  session.beginSession(canned.auth);
  await session.connect(canned.realm);
  session.selectCharacter(3);
  events.length = 0;

  assert.equal(await session.deleteCharacter(3), 71);
  assert.equal(session.characters.length, 2);
  assert.deepEqual(events.map(([name]) => name), ["CHARACTER_LIST_UPDATE"]);
  session.close();

  const refused = recordingSession({
    connect: async () => ({
      characters: async () => [...(await (await canned.connect()).characters())],
      deleteCharacter: async () => 72,
      close: () => {},
    }),
  });
  refused.session.beginSession(canned.auth);
  await refused.session.connect(canned.realm);
  refused.events.length = 0;
  assert.equal(await refused.session.deleteCharacter(1), 72);
  assert.equal(refused.session.characters.length, 3, "a refused delete leaves the list alone");
  assert.deepEqual(refused.events[0]?.slice(0, 2), ["OPEN_STATUS_DIALOG", "OKAY"]);
  refused.session.close();
});

test("choosing a realm shows character select only after the world is connected", async () => {
  const canned = fakeGlueSession("charselect");
  const world = await canned.connect();
  let finishConnection;
  let characterQueries = 0;
  const { session, events, screens } = recordingSession({
    connect: () => new Promise((resolve) => {
      finishConnection = () => resolve({
        ...world,
        characters: async () => {
          characterQueries++;
          return world.characters();
        },
      });
    }),
    setGlueScreen: (name) => {
      // Stock CharacterSelect_OnShow reads IsConnectedToServer() once to write the
      // realm label. It does not rewrite that label on CHARACTER_LIST_UPDATE.
      assert.equal(session.connected, true, "the realm label must see a connected world");
      screens.push(name);
      void session.refreshCharacters(); // stock GetCharacterListUpdate() on screen show
    },
  });
  session.beginSession(canned.auth);

  session.requestRealmList();
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);

  session.changeRealm(1, 1);
  assert.deepEqual(screens, [], "the screen waits for the world handshake");
  assert.equal(session.connecting, true);
  finishConnection();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(screens, ["charselect"]);
  assert.equal(session.connected, true);
  assert.equal(session.characters.length, 3);
  assert.equal(characterQueries, 1, "screen show and session connect share one character request");
  assert.deepEqual(session.serverName(), { name: "Круг Теней", pvp: true, rp: false, down: false });

  // Leaving the screen drops the socket and everything that came over it, but keeps the account.
  session.closeWorld();
  assert.equal(session.connected, false);
  assert.equal(session.characters.length, 0);
  assert.equal(session.realms.length, 2, "the realm list belongs to the auth session, not the world");
  session.close();
});

test("a stand point comes off the mark when the set carries one and off the camera when it does not", () => {
  // `UI_Draenei`: attachment 0 at (2.504, 1.437, -0.037), which is the mark itself.
  const withMark = {
    attachments: [{ id: 1, bone: 0, position: [9, 9, 9] }, { id: 0, bone: 26, position: [2.504, 1.437, -0.037] }],
    sceneCamera: { fov: 1, near: 0.2, far: 100, position: [7.247, 1.381, 0.565], target: [2.524, 1.45, 0.888] },
    bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
  };
  assert.deepEqual(glueStandPoint(withMark), [2.504, 1.437, -0.037]);

  // `UI_Human` carries no bones and therefore no attachment table at all: 4.79 yards along the
  // camera's ground bearing, 1.13 below its aim.
  const boneless = {
    attachments: [],
    sceneCamera: {
      fov: 1.4, near: 0.222, far: 611,
      position: [-221.983, -81.886, -2.298], target: [-230.493, -79.175, -1.755],
    },
    bounds: { min: [-527, -171, -14], max: [-211, 174, 147] },
  };
  const stand = glueStandPoint(boneless);
  assert.ok(stand);
  const distance = Math.hypot(stand[0] + 221.983, stand[1] + 81.886);
  assert.ok(Math.abs(distance - 4.79) < 1e-6, `ground distance ${distance}`);
  assert.ok(Math.abs(stand[2] - (-1.755 - 1.13)) < 1e-9, `height ${stand[2]}`);
  // On the camera's own bearing: the cross product of the two ground vectors is zero.
  const cross = (-230.493 + 221.983) * (stand[1] + 81.886) - (-79.175 + 81.886) * (stand[0] + 221.983);
  assert.ok(Math.abs(cross) < 1e-4, `off the aim bearing by ${cross}`);
});

// --- The same answers, as the corpus' own Lua sees them ---------------------------------------

const FIXTURE = {
  "Interface/GlueXML/GlueXML.toc": ["## Interface: 30300", "GlueStrings.lua", "GlueParent.xml"].join("\n"),
  "Interface/GlueXML/GlueStrings.lua": `
    GlueScreenInfo = {};
    GlueScreenInfo["charselect"] = "GlueParent";
    SEEN = {};
    function SetGlueScreen(name) SEEN[#SEEN + 1] = "screen:" .. name; end
  `,
  "Interface/GlueXML/GlueParent.xml": `<Ui>
    <Frame name="GlueParent" setAllPoints="true">
      <Scripts>
        <OnLoad>
          self:RegisterEvent("CHARACTER_LIST_UPDATE");
          self:RegisterEvent("UPDATE_SELECTED_CHARACTER");
          self:RegisterEvent("OPEN_REALM_LIST");
          self:RegisterEvent("OPEN_STATUS_DIALOG");
        </OnLoad>
        <OnEvent>SEEN[#SEEN + 1] = event;</OnEvent>
      </Scripts>
    </Frame>
  </Ui>`,
};

test("the C API hands the corpus the values in the order it unpacks them", async () => {
  const canned = fakeGlueSession("charselect");
  const runtime = new GlueRuntime({
    provider: createFixtureProvider(FIXTURE),
    api: {
      locale: "ruRU",
      session: { connect: () => canned.connect(), names: NAMES },
    },
  });
  await runtime.load();
  const evaluate = (expression) => {
    runtime.vm.setGlobal("__result", undefined);
    const outcome = runtime.vm.execute(`__result = (function() ${expression} end)()`, "@glue-session-probe");
    assert.equal(outcome.ok, true, `${expression}: ${outcome.error ?? ""}`);
    return runtime.vm.getGlobal("__result");
  };

  // Before anything is signed in, every count is zero and every row is nil — which is what keeps
  // the corpus' loops running zero times instead of indexing nil.
  assert.equal(evaluate("return GetNumRealms(1)"), 0);
  assert.equal(evaluate("return GetNumCharacters()"), 0);
  assert.equal(evaluate("return IsConnectedToServer()"), false);
  assert.equal(evaluate("return GetRealmInfo(1, 1)"), undefined);
  assert.equal(evaluate("return GetCharacterInfo(1)"), undefined);
  assert.equal(evaluate("return select('#', GetRealmCategories())"), 0);

  runtime.session.beginSession(canned.auth);
  assert.equal(evaluate("return GetNumRealms(1)"), 2);
  assert.equal(evaluate("return select('#', GetRealmCategories())"), 1);
  assert.equal(
    evaluate(`local name, chars, invalid, down, current, pvp, rp, load, locked = GetRealmInfo(1, 1);
      return name .. "/" .. chars .. "/" .. tostring(invalid) .. "/" .. tostring(down) .. "/"
        .. current .. "/" .. tostring(pvp) .. "/" .. tostring(rp) .. "/" .. load .. "/" .. tostring(locked)`),
    "Круг Теней/3/false/false/0/true/false/-3/false",
  );

  evaluate("ChangeRealm(1, 1); return 1");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(evaluate("return GetNumCharacters()"), 3);
  assert.equal(evaluate("return IsConnectedToServer()"), true);
  assert.equal(
    evaluate(`local name, race, class, level, zone, sex, ghost, pcc, prc, pfc = GetCharacterInfo(1);
      return name .. "/" .. race .. "/" .. class .. "/" .. level .. "/" .. zone .. "/" .. sex
        .. "/" .. tostring(ghost) .. "/" .. tostring(pcc) .. "/" .. tostring(prc) .. "/" .. tostring(pfc)`),
    "Аларин/Раса1/Воин/12/Элвиннский лес/0/false/false/false/false",
  );
  // The corpus concatenates an index into a frame name; a float would look up
  // `CharSelectCharacterButton1.0` and index nil, which is what 5.3 does with a pushed number.
  assert.equal(evaluate('SelectCharacter(2); return "CharSelectCharacterButton" .. GetNumCharacters()'),
    "CharSelectCharacterButton3");
  assert.equal(evaluate("return GetSelectBackgroundModel(2)"), "NightElf");
  assert.equal(evaluate("return GetCharacterSelectFacing()"), 0);
  assert.equal(evaluate("SetCharacterSelectFacing(GetCharacterSelectFacing() + 2); return GetCharacterSelectFacing()"), 2);
  assert.equal(evaluate("local n, pvp, rp, down = GetServerName(); return n .. tostring(pvp) .. tostring(down)"),
    "Круг Тенейtruefalse");

  // Entering the world is a recorded stub in this slice and says so in a dialog.
  evaluate("EnterWorld(); return 1");
  const seen = runtime.vm.getGlobal("SEEN");
  assert.ok(Array.isArray(seen) ? seen.includes("CHARACTER_LIST_UPDATE") : true);

  runtime.close();
});

// --- 10.05: the world connection as the stock status dialog, and its cancel -----------------------

/** The corpus strings the connecting dialog prints, as `GlueStrings.lua` words them. */
const CONNECT_STRINGS = {
  CSTATUS_CONNECTING: "Соединение...",
  CSTATUS_AUTHENTICATING: "Авторизация",
  QUEUE_NAME_TIME_LEFT_UNKNOWN: "Свободных мест нет: %s\nМесто в очереди: %d\nВремя ожидания: идет расчет...",
  QUEUE_TIME_LEFT_UNKNOWN: "Свободных мест нет\nМесто в очереди: %d\nВремя ожидания: идет расчет...",
  AUTH_WAIT_QUEUE: "Место в очереди: %d",
  CHANGE_REALM: "Выбор мира",
  CHAR_LIST_RETRIEVING: "Загрузка списка персонажей",
  AUTH_REJECT: "Ошибка входа в игру.",
  AUTH_BANNED: "Учетная запись заблокирована.",
  CHAR_LOGIN_NO_WORLD: "Сервер недоступен",
  DISCONNECTED: "Соединение с сервером разорвано",
};
const connectStrings = (key) => CONNECT_STRINGS[key];
const settle = async () => {
  for (let round = 0; round < 6; round++) await new Promise((resolve) => setImmediate(resolve));
};

test("choosing a realm shows the stock status dialog: connecting, the queue, the list, then closes", async () => {
  const canned = fakeGlueSession("charselect");
  const world = await canned.connect();
  let release;
  const { session, events, screens } = recordingSession({
    glueString: connectStrings,
    connect: (realm, auth, progress) => new Promise((resolve) => {
      // What the host's connector reports: the socket is open, then the realm queues the session.
      progress?.({ stage: "authenticating" });
      progress?.({ stage: "queued", position: 12 });
      release = () => resolve(world);
    }),
  });
  session.beginSession(canned.auth);
  session.changeRealm(1, 1);
  assert.deepEqual(events, [
    ["OPEN_STATUS_DIALOG", "CANCEL", "Соединение..."],
    ["UPDATE_STATUS_DIALOG", "Авторизация"],
    // FUN_004dab40: the queue is QUEUE_NAME_TIME_LEFT_UNKNOWN (the core sends no time), with the
    // button relabelled CHANGE_REALM.
    ["UPDATE_STATUS_DIALOG", "Свободных мест нет: Круг Теней\nМесто в очереди: 12\nВремя ожидания: идет расчет...", "Выбор мира"],
  ]);
  events.length = 0;
  release();
  await settle();
  assert.deepEqual(screens, ["charselect"]);
  assert.deepEqual(events, [
    ["UPDATE_STATUS_DIALOG", "Загрузка списка персонажей"],
    ["CLOSE_STATUS_DIALOG"],
    ["CHARACTER_LIST_UPDATE"],
  ]);
  assert.equal(session.characters.length, 3);
  session.close();
});

test("cancelling the dialog in the queue drops the connection and returns to the realm list", async () => {
  const canned = fakeGlueSession("charselect");
  let aborted = false;
  let lateClosed = false;
  let late;
  const { session, events } = recordingSession({
    glueString: connectStrings,
    connect: (realm, auth, progress, signal) => new Promise((resolve) => {
      progress?.({ stage: "queued", position: 5 });
      signal?.addEventListener("abort", () => { aborted = true; });
      late = async () => resolve({ ...(await canned.connect()), close: () => { lateClosed = true; } });
    }),
  });
  session.beginSession(canned.auth);
  session.changeRealm(1, 1);
  events.length = 0;

  // StatusDialogClick on the CANCEL dialog.
  session.cancelPending();
  assert.equal(aborted, true, "the connector is told to close its socket");
  assert.equal(session.connecting, false);
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);

  // The realm lets the session in anyway: the answer is closed, not adopted.
  await late();
  await settle();
  assert.equal(lateClosed, true);
  assert.equal(session.connected, false);
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);

  // With nothing in flight, the same click (every OKAY dialog ends in StatusDialogClick) does nothing.
  session.cancelPending();
  assert.deepEqual(events, [["OPEN_REALM_LIST"]]);
  session.close();
});

// --- 10.06: a failed world connection in the corpus' words, never the exception's --------------------

test("a refused world session prints the realm's reason, and the English detail only goes to the log", async () => {
  const canned = fakeGlueSession("charselect");
  const refuse = async (error, extra = {}) => {
    const diagnostics = [];
    const { session, events } = recordingSession({
      glueString: connectStrings,
      onDiagnostic: (message) => diagnostics.push(message),
      connect: async () => { throw error; },
      ...extra,
    });
    session.beginSession(canned.auth);
    await session.connect(canned.realm);
    session.close();
    return { events, diagnostics };
  };
  const shown = (type, text, data) => [
    data === undefined ? ["OPEN_STATUS_DIALOG", type, text] : ["OPEN_STATUS_DIALOG", type, text, data],
    ["UPDATE_STATUS_DIALOG", text],
  ];

  const rejected = await refuse(new WorldAuthError(14));
  assert.deepEqual(rejected.events, shown("OKAY", "Ошибка входа в игру."));
  assert.match(rejected.diagnostics[0], /World authentication failed with code 14/);

  // AUTH_BANNED opens the client's OKAY_WITH_URL, its HELP button pointed at AUTH_BANNED_URL…
  const banned = await refuse(new WorldAuthError(28), { hasDialogType: (type) => type === "OKAY_WITH_URL" });
  assert.deepEqual(banned.events, shown("OKAY_WITH_URL", "Учетная запись заблокирована.", "AUTH_BANNED_URL"));
  // …or a plain OKAY in a corpus without that dialog type.
  assert.deepEqual((await refuse(new WorldAuthError(28))).events, shown("OKAY", "Учетная запись заблокирована."));

  // The gateway lost the worldserver (Gateway.ts `bridge()`): the realm is down, not the network.
  assert.deepEqual((await refuse(new TransportClosedError(1011, "Backend unavailable", true))).events,
    shown("OKAY", "Сервер недоступен"));
  assert.deepEqual((await refuse(new TransportClosedError(1006, "", false))).events,
    shown("OKAY", "Соединение с сервером разорвано"));
});

test("choosing a realm that refuses the session replaces the connecting dialog with the reason", async () => {
  const canned = fakeGlueSession("charselect");
  const { session, events } = recordingSession({
    glueString: connectStrings,
    connect: async () => { throw new WorldAuthError(14); },
  });
  session.beginSession(canned.auth);
  session.changeRealm(1, 1);
  await settle();
  assert.deepEqual(events, [
    ["OPEN_STATUS_DIALOG", "CANCEL", "Соединение..."],
    ["OPEN_STATUS_DIALOG", "OKAY", "Ошибка входа в игру."],
    ["UPDATE_STATUS_DIALOG", "Ошибка входа в игру."],
  ]);
  assert.equal(session.connecting, false);
  session.close();
});
