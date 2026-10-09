import type { GlueLuaVm } from "./GlueLua.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { loginToRealmList, readRealmList, type AuthSessionResult } from "../../auth/login.js";
import { AuthProtocolError, canSelectRealm, type RealmInfo } from "../../auth/AuthProtocol.js";
import { AUTH_RESULTS } from "../../generated/authResults.js";
import type { BinaryByteStream } from "../../transport/WebSocketByteStream.js";
import { GlueSession, type GlueSessionOptions } from "./GlueSession.js";
import {
  installGlueCharacterApi, type GlueCharacterView, type GlueEnterWorldRequest,
} from "./GlueCharacterApi.js";
import { GlueCreation, type GlueCreationOptions } from "./GlueCreation.js";
import { installGlueCreateApi, type GlueCreationView } from "./GlueCreateApi.js";
import {
  CLIENT_LOGIN_REFUSALS, authKey, describeFailure, openStatusDialog, showStatusMessage, type GlueAuthMessage,
} from "./GlueMessages.js";
import type { GlueNameRuleOptions } from "./GlueNameRules.js";
import { GLUE_ADDON_GLOBALS, type GlueAddonList } from "./GlueAddons.js";
import type { GlueCVarStore } from "./GlueCVarStore.js";
import {
  frameXmlLuaDeclensionSetCount, frameXmlLuaDeclineName,
} from "../ui/framexml_compat/FrameXmlDeclension.js";

/**
 * Where glue sound goes.
 *
 * The corpus calls `PlaySound` 29 times before anything is even clicked, so the
 * seam has to exist in G2 even though no audio is wired yet: a recording sink
 * makes the calls testable now and swappable for the real mixer in G3.
 */
export interface GlueAudioSink {
  playSound(kit: string): void;
  playSoundFile(path: string): void;
  playMusic(track: string): void;
  playAmbience(track: string, fadeSeconds: number): void;
  stopAmbience(fadeSeconds: number): void;
  stopMusic(): void;
  stopAllSfx(): void;
}

/** A sink that only remembers; the default until G3 wires the mixer. */
export class RecordingGlueAudioSink implements GlueAudioSink {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = [];
  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }
  playSound(kit: string): void { this.record("PlaySound", kit); }
  playSoundFile(path: string): void { this.record("PlaySoundFile", path); }
  playMusic(track: string): void { this.record("PlayGlueMusic", track); }
  playAmbience(track: string, fade: number): void { this.record("PlayGlueAmbience", track, fade); }
  stopAmbience(fade: number): void { this.record("StopGlueAmbience", fade); }
  stopMusic(): void { this.record("StopGlueMusic"); }
  stopAllSfx(): void { this.record("StopAllSFX"); }
}

export interface GlueApiOptions {
  readonly vm: GlueLuaVm;
  readonly bridge: FrameXmlUiBridge;
  readonly audio?: GlueAudioSink;
  /** Four-character locale reported by `GetLocale()`; defaults to the client's. */
  readonly locale?: string;
  /** Logical screen size reported to `GetScreenWidth/Height`, in UI units. */
  readonly screenWidth?: number;
  readonly screenHeight?: number;
  /**
   * The live screen size, when the host has one that can change.
   *
   * `GetScreenWidth()` is not a constant: `GlueParent_OnLoad` pillarboxes itself from the ratio and
   * the owner's `lgzg.lua` divides the two numbers to lay its whole scene out, so a browser window
   * that has been resized has to be able to answer with its current size. Wins over the two static
   * numbers, which stay for the tests, where there is no window at all.
   */
  readonly screen?: () => { readonly width: number; readonly height: number };
  /** WebSocket URL of the gateway's auth route; without it login is refused. */
  readonly authUrl?: string;
  /** Injected so tests can drive the SRP6 flow without a socket. */
  readonly connect?: (url: string) => Promise<BinaryByteStream>;
  /** Called when the SRP6 handshake produced a session and a realm list. */
  readonly onSession?: (session: AuthSessionResult) => void;
  /** Numeric authserver rejection only; never receives account or password. */
  readonly onAuthDiagnostic?: (code: number) => void;
  /** Reported once per C-API global that is only a recorded stub. */
  readonly onStub?: (name: string) => void;
  readonly onLaunchUrl?: (url: string) => void;
  /**
   * How the realm list and the character list reach a world server.
   *
   * The session is built here when the host does not pass one, so the realm and character C-API is
   * always the real implementation answering out of an empty session rather than a second set of
   * constant stubs — which is what lets the corpus smoke exercise it with no server at all.
   */
  readonly session?: Omit<GlueSessionOptions, "fireEvent" | "setGlueScreen" | "glueString" | "hasDialogType">;
  /**
   * «Вход в игровой мир» — where the character-select screen hands the player over.
   *
   * The glue runtime does no world work of its own: it names the character it is showing and stops
   * there. A host without this option gets the honest dialog instead, which is what `glue.html` —
   * a page with no renderer behind it — shows.
   */
  readonly enterWorld?: (request: GlueEnterWorldRequest) => void;
  /** The 3D character behind the character-select screen, when the host draws one. */
  readonly characterView?: GlueCharacterView;
  /** The 3D character behind the creation screen, which is rebuilt on every customisation change. */
  readonly creationView?: GlueCreationView;
  /**
   * Where the creation screen's tables and per-profile answers come from.
   *
   * Injected for the same reason the session's connector is: `/dbc/character-options` and
   * `/dbc/char-start-outfit` are gateway routes, and the corpus smoke has no gateway. Without it
   * the screen still loads — every list is empty and the preview draws nothing — which is what an
   * unreachable gateway looks like and is deliberately not an error.
   */
  readonly creation?: Pick<GlueCreationOptions, "source" | "tables" | "random">;
  /** The pointer in UI units, y from the bottom; without it the drag rotation cannot move. */
  readonly cursor?: () => readonly [number, number];
  /**
   * What this browser can actually show (10.19): the display's measured refresh rate and WebGL2's
   * `MAX_SAMPLES`. Without it the video queries keep their constant answers.
   */
  readonly video?: GlueVideoCaps;
  /**
   * `QuitGame()` — «Выход» on the login screen (`AccountLogin_Exit`). The host closes its window;
   * without it the call stays a recorded stub.
   */
  readonly onQuit?: () => void;
  /** «Модификации» (10.09): the gateway's add-on list and this browser's switches; else stubs. */
  readonly addons?: GlueAddonList;
  /**
   * Where the CVars that outlive a reload are kept (10.07): account name, realm, last character,
   * `usesToken` — never a password (`GlueCVarStore`). Without it everything stays in memory.
   */
  readonly cvarStore?: GlueCVarStore;
}

/** The CVar `GetUsesToken`/`SetUsesToken` keep (10.10). */
const USES_TOKEN_CVAR = "usesToken";

export interface GlueVideoCaps {
  /** Frames per second the page is being painted at; 60 until measured. */
  refreshRate(): number;
  /** `gl.getParameter(gl.MAX_SAMPLES)` of a WebGL2 context; 1 or less means no multisampling. */
  maxSamples(): number;
}

/** The video queries `GlueApiOptions.video` answers for real; the constant stubs step aside. */
const VIDEO_GLOBALS: ReadonlySet<string> = new Set([
  "GetRefreshRates", "GetMultisampleFormats", "GetCurrentMultisampleFormat",
]);

/** Colour and depth bits of a multisample format triple; every WebGL2 default framebuffer is 24/24. */
const MULTISAMPLE_COLOR_BITS = 24;
const MULTISAMPLE_DEPTH_BITS = 24;

/**
 * What the creation screen is told when nobody has given it a gateway.
 *
 * Deliberately answers rather than throws: the corpus smoke and any host without the DBC routes
 * still load `CharacterCreate`, and an empty option list is a screen with nothing to cycle, not an
 * error dialog.
 */
const EMPTY_CREATION_SOURCE: GlueCreationOptions["source"] = {
  options: async () => undefined,
  startOutfit: async () => [],
  displayId: () => undefined,
};

/**
 * 06.10-glue-fix: the glue `GetBuildInfo()` — Wow.exe 0x004dbe60 (registration 0x00ac3e08), not the
 * in-game one (0x0050f890: version, build, date, TOC number). It answers five strings: the localized
 * `VERSION` and `RELEASE_BUILD` (through the GetText lookup 0x00819d40, "" when absent), then these
 * three. AccountLogin.lua:15-16 prints all five through `SetFormattedText(VERSION_TEMPLATE, …)`.
 */
export const GLUE_BUILD_INFO: readonly [string, string, string] =
  Object.freeze(["3.3.5", "12340", "Jun 24 2010"]) as readonly [string, string, string];

/** The logon challenge's account name: one length byte, at most 16 UTF-8 bytes (`buildLogonChallenge`). */
const MAX_ACCOUNT_NAME_BYTES = 16;
const ACCOUNT_NAME_ENCODER = new TextEncoder();

/** The Lua global `hasDialogType` answers through, cleared again after every question. */
const DIALOG_TYPE_PROBE = "__glueDialogTypeProbe";

/**
 * CVars the glue screens read before anything has written one.
 *
 * Measured from the corpus' own `GetCVar` call sites plus the values
 * `AccountLogin.lua` expects to round-trip through `SetSavedAccountName`.
 */
const CVAR_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  accountName: "",
  accountList: "",
  useEnglishAudio: "0",
  readTOS: "0",
  readEULA: "0",
  readScanning: "0",
  readContest: "0",
  readTerminationWithoutNotice: "0",
  showTooltips: "1",
  realmName: "",
  lastCharacterIndex: "0",
  gxWindow: "1",
  gxResolution: "1024x768",
  gxRefresh: "60",
  gxMultisample: "1",
  gxTextureCacheSize: "1",
  Sound_EnableAllSound: "1",
  Sound_MasterVolume: "1",
  Sound_OutputDriverName: "System Default",
  serverAlert: "",
  playIntroMovie: "1",
  useUiScale: "0",
  uiScale: "1",
  // Registered by the client's name checks (FUN_007e2250) with "0"; anything else limits a new
  // character name to ASCII letters (`GlueNameRules`).
  forceEnglishNames: "0",
});

/**
 * Constant-result C-API globals.
 *
 * Every name here is one the corpus calls and G2 cannot answer honestly: realm
 * lists, the character list, video capabilities, addon metadata and the account
 * message queue all belong to G4/G5. The value is chosen so the *caller* stays
 * on a sane path — a count is 0 so the corpus' loops run zero times, a
 * capability query is false so the panel that would need it hides itself —
 * rather than nil, which is what turns a stub into an arithmetic error four
 * lines later. Each call is recorded once; that list is the G3/G4 work queue.
 */
const CONSTANT_STUBS: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  // The realm split is a Blizzard-only migration screen: nothing on the wire this client speaks
  // ever fires SERVER_SPLIT_NOTICE, so `SERVER_SPLIT_STATE_PENDING` stays at -1 and
  // `CharacterSelect_OnUpdate` keeps the button hidden — which is the correct screen.
  RequestRealmSplitInfo: [], SetRealmSplitState: [], SetPreferredInfo: [], IsStreamingTrial: [false],
  // Character select / create — the list is real in `GlueCharacterApi.ts`, the forced rename and
  // `DeclineCharacter` (10.09) included; declining a name is client-side and real: `installDeclension`.
  // The whole of `CharacterCreate` is real in `GlueCreateApi.ts`, the paid services (2.08) included;
  // what stays here is the random-name generator. It is not a server call: this core's 3.3.5
  // protocol has no random-name opcode, and the name table (NameGen.dbc) ships in the dataset. The
  // stock button that calls it shows only under `ALLOW_RANDOM_NAME_BUTTON`, which this ruRU
  // GlueXML never defines (CharacterCreate.lua), so the empty answer is not reached from stock Lua.
  GetRandomName: [""],
  // Account, billing and messages.
  GetGameAccountInfo: [], GetNumGameAccounts: [0], SetGameAccount: [], IsTrialAccount: [false],
  GetBillingPlan: [0], GetBillingTimeRemaining: [0], GetClientExpansionLevel: [2],
  AccountMsg_GetNumUnreadMsgs: [0], AccountMsg_LoadHeaders: [], AccountMsg_LoadBody: [],
  AccountMsg_SetMsgRead: [], AccountMsg_GetIndexNextUnreadMsg: [], AccountMsg_GetHeaderSubject: [""],
  SurveyNotificationDone: [], SetClearConfigData: [],
  // Legal notices: the `Show*Notice` half only says whether to print the red banner above the
  // text. The `*Accepted` half is what gates the screen and is bound for real below.
  ShowTOSNotice: [false], ShowEULANotice: [false], ShowScanningNotice: [false],
  ShowContestNotice: [false], ShowTerminationWithoutNoticeNotice: [false],
  AcceptChangedOptionWarnings: [],
  GetChangedOptionWarnings: [""], ShowChangedOptionWarnings: [false],
  // Warden scan: nothing to scan, so report finished and clean.
  ScanDLLStart: [], ScanDLLContinueAnyway: [], IsScanDLLFinished: [true],
  // Security matrix and token.
  GetMatrixCoordinates: [], MatrixCommit: [], MatrixRevert: [], MatrixEntered: [],
  // `TokenEntered`/`GetUsesToken`/`SetUsesToken` are real (10.10); PIN and matrix are never asked
  // for by a 3.3.5 TrinityCore (AuthSession.cpp:422-435 sends neither), so they stay answers.
  PINEntered: [],
  // Addons: the constant answers for a host without `GlueApiOptions.addons` (`GlueAddons.ts`).
  GetNumAddOns: [0], GetAddOnInfo: [], GetAddOnDependencies: [], GetAddOnEnableState: [0],
  EnableAddOn: [], DisableAddOn: [], EnableAllAddOns: [], DisableAllAddOns: [], ResetAddOns: [],
  SaveAddOns: [], LaunchAddOnURL: [], IsAddonVersionCheckEnabled: [false], SetAddonVersionCheck: [],
  // Video and audio options. `OptionsFrame.xml` is zero bytes in this corpus, so nothing builds the
  // panel that reads these; the three `GlueApiOptions.video` answers for real are replaced below,
  // the rest are things a browser has no such control over (stereo, gamma, terrain mip, sound drivers).
  GetVideoCaps: [],
  IsPlayerResolutionAvailable: [true], SetScreenResolution: [], GetRefreshRates: [60],
  GetMultisampleFormats: [], GetCurrentMultisampleFormat: [1], SetMultisampleFormat: [],
  IsStereoVideoAvailable: [false], RestoreVideoEffectsDefaults: [],
  RestoreVideoResolutionDefaults: [], RestoreVideoStereoDefaults: [], RestartGx: [],
  GetGamma: [1], SetGamma: [], GetTerrainMip: [0], SetTerrainMip: [],
  Sound_GameSystem_GetNumOutputDrivers: [0], Sound_GameSystem_GetOutputDriverNameByIndex: [""],
  Sound_GameSystem_RestartSoundSystem: [],
  // Movies and cinematics.
  GetMovieResolution: [1024, 768], HideCursor: [], ShowCursor: [], PlayCreditsMusic: [],
  GetCreditsText: [""], Cinematics_PlayMovie: [],
  // Patch download.
  PatchDownloadProgress: [0], PatchDownloadApply: [], PatchDownloadCancel: [],
  // Miscellany.
  Screenshot: [], QuitGame: [], QuitGameAndRunLauncher: [], ConsoleExec: [],
  IsShiftKeyDown: [false], IsWindowsClient: [true], IsMacClient: [false],
  IsSystemSupported: [true], ShowUIPanel: [], CloseMenus: [],
});

/**
 * The glue screens' C API.
 *
 * Real bindings where a real answer exists (build, locale, cvars, the SRP6
 * login), a recording seam where the subsystem is coming later (audio,
 * screens), and constant stubs everywhere else — because the one thing this
 * slice has to guarantee is that the login screen finishes loading without a
 * Lua error, and a nil global is an error the moment the corpus calls it.
 */
export class GlueApi {
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #options: GlueApiOptions;
  readonly #audio: GlueAudioSink;
  readonly #cvars = new Map<string, string>(Object.entries(CVAR_DEFAULTS));
  readonly #stubbed = new Set<string>();
  readonly #acceptedNotices = new Set<string>([
    "TOSAccepted", "EULAAccepted", "ScanningAccepted", "ContestAccepted",
    "TerminationWithoutNoticeAccepted",
  ]);
  readonly #session: GlueSession;
  readonly #creation: GlueCreation;
  #currentScreen = "";
  #loginStream: BinaryByteStream | undefined;
  #loginGeneration = 0;
  /**
   * The auth connection a login opened, kept after it succeeded so `RequestRealmList` can ask the
   * authserver again (10.08). Closed by the next login, `DisconnectFromServer`, entering the world
   * and `close`.
   */
  #authStream: BinaryByteStream | undefined;
  /** The login waiting for `TokenEntered` (10.10), and how to abandon it. */
  #tokenWait: { resolve(token: string): void; reject(error: Error): void } | undefined;

  constructor(options: GlueApiOptions) {
    this.#vm = options.vm;
    this.#bridge = options.bridge;
    this.#options = options;
    this.#audio = options.audio ?? new RecordingGlueAudioSink();
    for (const [name, value] of Object.entries(options.cvarStore?.load() ?? {})) this.#cvars.set(name, value);
    this.#session = new GlueSession({
      ...options.session,
      fireEvent: (event, ...args) => { this.fireEvent(event, ...args); },
      setGlueScreen: (name) => { this.setGlueScreen(name); },
      glueString: (key) => this.#vm.globalString(key),
      hasDialogType: (type) => this.hasDialogType(type),
      // 10.07: the realm a player picks is remembered, and the character list opens on the one they
      // last entered the world with (the client writes `lastCharacterIndex` in EnterWorld, 0x4d9bd0).
      onRealmChosen: (realm) => { this.setCVar("realmName", realm.name); },
      refreshRealms: () => this.refreshRealms(),
      lastCharacterIndex: () => {
        // 0, the default, is the first character — which CharacterSelect.lua picks by itself.
        const index = Number.parseInt(this.#cvars.get("lastCharacterIndex") ?? "", 10);
        return Number.isInteger(index) && index > 0 ? index : undefined;
      },
    });
    this.#creation = new GlueCreation({
      // An empty dataset is a working screen with nothing on it, which is what a gateway that is
      // down looks like — the same floor `GlueSession` stands on with no realm list.
      source: options.creation?.source ?? EMPTY_CREATION_SOURCE,
      tables: options.creation?.tables ?? (() => ({ races: [], classes: [] })),
      ...(options.creation?.random ? { random: options.creation.random } : {}),
      create: async (request) => await this.#session.createCharacter(request),
      paid: async (request) => await this.#session.paidService(request),
      nameRules: () => this.nameRules(),
      hasDialogType: (type) => this.hasDialogType(type),
      // The five axes and the start outfit arrive after the C call that asked for them returned.
      onChanged: () => { this.#options.creationView?.update(); },
      fireEvent: (event, ...args) => { this.fireEvent(event, ...args); },
      setGlueScreen: (name) => { this.setGlueScreen(name); },
      glueString: (key) => this.#vm.globalString(key),
    });
  }

  /** The race, class, sex and five appearance indices the creation screen is holding. */
  get creation(): GlueCreation {
    return this.#creation;
  }

  /** The realm list, the world connection and the character list this screen is showing. */
  get session(): GlueSession {
    return this.#session;
  }

  /** C-API globals the corpus called that only recorded; the G3/G4 work queue. */
  get stubbedGlobals(): readonly string[] {
    return [...this.#stubbed];
  }

  get currentScreen(): string {
    return this.#currentScreen;
  }

  get audio(): GlueAudioSink {
    return this.#audio;
  }

  /** Every CVar write goes through here, so the store sees the ones it keeps (10.07). */
  private setCVar(name: string, value: string): void {
    this.#cvars.set(name, value);
    this.#options.cvarStore?.save(name, this.#cvars);
  }

  cvar(name: string): string | undefined {
    return this.#cvars.get(name);
  }

  /**
   * What decides the alphabets of a new character name: the CVar `forceEnglishNames`, read as the
   * client reads a CVar's number (a value that does not parse is 0), and the chosen realm's
   * category's `Cfg_Categories` mask (`GlueSession.nameAlphabetMask`, 1.19) — 0, what the client
   * uses without a row, while `/dbc/realm-categories` has not answered.
   */
  nameRules(): GlueNameRuleOptions {
    const force = Number.parseInt(this.#cvars.get("forceEnglishNames") ?? "0", 10);
    return { forceEnglishNames: Number.isFinite(force) && force !== 0, alphabetMask: this.#session.nameAlphabetMask() };
  }

  /**
   * A message in the corpus' own words and dialog (`showStatusMessage`): for a host outside the
   * glue modules — the way back from the world — that has a coded message and no corpus of its own.
   */
  showMessage(message: GlueAuthMessage, fallback?: string): void {
    showStatusMessage({
      fire: (event, ...args) => { this.fireEvent(event, ...args); },
      glueString: (key) => this.#vm.globalString(key),
      hasDialogType: (type) => this.hasDialogType(type),
      dialogShown: (type) => this.dialogShown(type), // 3.35-review
    }, message, fallback);
  }

  install(): void {
    this.installClientInfo();
    this.installCVars();
    this.installScreens();
    this.installAudio();
    this.installFrameApi();
    this.installBackgroundModels();
    this.installLogin();
    this.installLegalNotices();
    this.installDeclension();
    installGlueCharacterApi({
      vm: this.#vm,
      session: this.#session,
      setGlueScreen: (name) => { this.setGlueScreen(name); },
      fireEvent: (event, ...args) => { this.fireEvent(event, ...args); },
      ...(this.#options.characterView ? { view: this.#options.characterView } : {}),
      ...(this.#options.cursor ? { cursor: this.#options.cursor } : {}),
      ...(this.#options.enterWorld ? { enterWorld: (request: GlueEnterWorldRequest) => {
        // 0x4d9bd0 writes the 0-based index as it hands the character over.
        this.setCVar("lastCharacterIndex", String(request.index - 1));
        // The auth connection kept for the realm dialog (10.08) has nothing to do in the world: held
        // there it would pin a gateway socket and an authserver session per player for the whole
        // game (and count twice against the gateway's per-address budget). Back at character select
        // the dialog opens over the list it has.
        this.closeAuth();
        this.#options.enterWorld?.(request);
      } } : {}),
      onStub: (name) => { this.recordStub(name); },
      nameRules: () => this.nameRules(),
      currentScreen: () => this.#currentScreen,
      locale: () => this.#options.locale ?? "ruRU",
      onDisconnect: () => { this.closeAuth(); },
    });
    installGlueCreateApi({
      vm: this.#vm,
      creation: this.#creation,
      ...(this.#options.creationView ? { view: this.#options.creationView } : {}),
      character: (index) => this.#session.characters[index - 1],
    });
    this.installConstantStubs();
  }

  /**
   * The agreement gate, which is the first thing the login screen asks about.
   *
   * `AccountLogin_ShowUserAgreements` runs `if ( not EULAAccepted() ) then AccountLoginUI:Hide();
   * … TOSFrame:Show() end` and walks five of these in turn. A stub that returned *nothing* made
   * every one of them read as "not accepted", so the screen came up on the EULA panel with the
   * login form hidden behind it — measured in the live page, where `TOSFrame` was the only visible
   * thing on the whole screen.
   *
   * They answer "accepted" by default because this build has no agreement flow to run: the text
   * files the panel scrolls (`eula.html`, `tos.html`, …) are not in the patch chain at all, so the
   * gate could never be passed by reading anything. `Accept*` still writes, so a corpus that
   * re-asks inside one session gets a consistent answer.
   */
  private installLegalNotices(): void {
    const vm = this.#vm;
    const pairs: readonly [string, string][] = [
      ["TOSAccepted", "AcceptTOS"],
      ["EULAAccepted", "AcceptEULA"],
      ["ScanningAccepted", "AcceptScanning"],
      ["ContestAccepted", "AcceptContest"],
      ["TerminationWithoutNoticeAccepted", "AcceptTerminationWithoutNotice"],
    ];
    for (const [query, accept] of pairs) {
      vm.registerGlobal(query, () => [this.#acceptedNotices.has(query)]);
      vm.registerGlobal(accept, () => { this.#acceptedNotices.add(query); return []; });
    }
  }

  /**
   * The ruRU declension step (`GlueLocalizationPost.lua`'s DeclensionFrame, shown on
   * FORCE_DECLINE_CHARACTER): `GetNumDeclensionSets(name, sex)` pages the sets and
   * `DeclineName(name, sex, set)` fills the five boxes. Both are the client's own rule engine
   * (FrameXmlDeclension.ts, from Wow.exe 12340), not a server answer, so they are real here; they
   * were constant stubs answering 0 sets and no forms.
   */
  private installDeclension(): void {
    const vm = this.#vm;
    vm.registerGlobal("DeclineName", (args) =>
      frameXmlLuaDeclineName(typeof args[0] === "string" ? args[0] : String(args[0] ?? ""), args[1], args[2]));
    vm.registerGlobal("GetNumDeclensionSets", (args) =>
      [frameXmlLuaDeclensionSetCount(typeof args[0] === "string" ? args[0] : String(args[0] ?? ""), args[1])]);
  }

  /** The logical screen, live where the host has one and static where it does not. */
  get screenSize(): { readonly width: number; readonly height: number } {
    return this.#options.screen?.()
      ?? { width: this.#options.screenWidth ?? 1024, height: this.#options.screenHeight ?? 768 };
  }

  private installClientInfo(): void {
    const vm = this.#vm;
    // 06.10-glue-fix: five values, as 0x004dbe60 (see GLUE_BUILD_INFO).
    vm.registerGlobal("GetBuildInfo", () => [
      vm.globalString("VERSION") ?? "", vm.globalString("RELEASE_BUILD") ?? "", ...GLUE_BUILD_INFO,
    ]);
    vm.registerGlobal("GetLocale", () => [this.#options.locale ?? "ruRU"]);
    // GlueParent_OnLoad divides these to decide whether to pillarbox itself.
    vm.registerGlobal("GetScreenWidth", () => [this.screenSize.width]);
    vm.registerGlobal("GetScreenHeight", () => [this.screenSize.height]);
    vm.registerGlobal("GetTime", () => [Date.now() / 1000]);
    // The resolution list is a real answer, not a stub: the server's own
    // `lgzg.lua` immediately does
    // `({GetScreenResolutions()})[GetCurrentResolution()]` and divides the two
    // numbers it parses out of the string. An empty list made that a nil
    // arithmetic error before the login screen had drawn anything.
    vm.registerGlobal("GetScreenResolutions", () => [
      `${Math.round(this.screenSize.width)}x${Math.round(this.screenSize.height)}`,
    ]);
    vm.registerGlobal("GetCurrentResolution", () => [1]);
    this.#options.addons?.install(vm);
    const onQuit = this.#options.onQuit;
    if (onQuit) {
      // Both spellings end the game; there is no launcher to run.
      vm.registerGlobal("QuitGame", () => { onQuit(); return []; });
      vm.registerGlobal("QuitGameAndRunLauncher", () => { onQuit(); return []; });
    }
    const video = this.#options.video;
    if (video) {
      // `GetRefreshRates()` lists the rates the mode offers; a page is painted at one, the display's.
      vm.registerGlobal("GetRefreshRates", () => [Math.max(1, Math.round(video.refreshRate()))]);
      // Triples of (colour bits, depth bits, samples): 1, 2, 4, 8… up to what WebGL2 allows.
      const sampleCounts = (): number[] => {
        const counts = [1];
        for (let samples = 2; samples <= video.maxSamples(); samples *= 2) counts.push(samples);
        return counts;
      };
      vm.registerGlobal("GetMultisampleFormats", () =>
        sampleCounts().flatMap((samples) => [MULTISAMPLE_COLOR_BITS, MULTISAMPLE_DEPTH_BITS, samples]));
      // 1-based index of the format `gxMultisample` names; a value no format has is the first.
      vm.registerGlobal("GetCurrentMultisampleFormat", () => {
        const wanted = Number.parseInt(this.#cvars.get("gxMultisample") ?? "1", 10);
        const index = sampleCounts().indexOf(wanted);
        return [index < 0 ? 1 : index + 1];
      });
    }
    vm.registerGlobal("LaunchURL", (args) => {
      const url = String(args[0] ?? "");
      // Never navigate on the corpus' say-so: a URL out of a patch archive is
      // untrusted input. The host decides what, if anything, opening means.
      this.#options.onLaunchUrl?.(url);
      return [];
    });
    vm.registerGlobal("MinutesToTime", (args) => {
      const minutes = Math.max(0, Math.floor(Number(args[0]) || 0));
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor((minutes % 1440) / 60);
      const rest = minutes % 60;
      const parts: string[] = [];
      if (days > 0) parts.push(`${days} д.`);
      if (hours > 0) parts.push(`${hours} ч.`);
      if (rest > 0 || parts.length === 0) parts.push(`${rest} мин.`);
      return [parts.join(" ")];
    });
  }

  private installCVars(): void {
    const vm = this.#vm;
    vm.registerGlobal("GetCVar", (args) => [this.#cvars.get(String(args[0] ?? ""))]);
    vm.registerGlobal("GetCVarBool", (args) => {
      const value = this.#cvars.get(String(args[0] ?? ""));
      return [value !== undefined && value !== "0" && value !== ""];
    });
    vm.registerGlobal("SetCVar", (args) => {
      const name = String(args[0] ?? "");
      if (name) this.setCVar(name, args[1] === undefined ? "" : String(args[1]));
      return [];
    });
    vm.registerGlobal("RegisterCVar", (args) => {
      const name = String(args[0] ?? "");
      if (name && !this.#cvars.has(name)) this.#cvars.set(name, args[1] === undefined ? "" : String(args[1]));
      return [];
    });
    vm.registerGlobal("GetCVarDefault", (args) => [CVAR_DEFAULTS[String(args[0] ?? "")] ?? ""]);
    vm.registerGlobal("GetCVarMin", () => [0]);
    vm.registerGlobal("GetCVarMax", () => [1]);
    // The saved-account pair is the one cvar path the login screen writes on
    // every attempt, so it is bound rather than stubbed.
    vm.registerGlobal("GetSavedAccountName", () => [this.#cvars.get("accountName") ?? ""]);
    vm.registerGlobal("SetSavedAccountName", (args) => {
      this.setCVar("accountName", String(args[0] ?? ""));
      return [];
    });
    vm.registerGlobal("GetSavedAccountList", () => [this.#cvars.get("accountList") ?? ""]);
    vm.registerGlobal("SetSavedAccountList", (args) => {
      this.setCVar("accountList", String(args[0] ?? ""));
      return [];
    });
  }

  /**
   * The screen registry.
   *
   * `SetGlueScreen` itself is Lua (GlueParent.lua walks `GlueScreenInfo` and
   * shows one frame); the C side only records which screen won, which is what
   * `GetCurrentGlueScreenName` reads back. Mirroring it in TS is what lets the
   * host ask which screen is up without reaching into the VM.
   */
  private installScreens(): void {
    const vm = this.#vm;
    vm.registerGlobal("SetCurrentScreen", (args) => {
      this.#currentScreen = String(args[0] ?? "");
      return [];
    });
    vm.registerGlobal("SetCurrentGlueScreenName", (args) => {
      this.#currentScreen = String(args[0] ?? "");
      return [];
    });
  }

  /** Ask the corpus to switch screens, exactly as the real client's C side does. */
  setGlueScreen(name: string): boolean {
    return this.#bridge.runInMutationBatch(() => {
      const ref = this.#vm.globalFunction("SetGlueScreen");
      if (!ref) return false;
      try {
        this.#vm.call(ref, [name], 0);
      } finally {
        this.#vm.release(ref);
      }
      return true;
    });
  }

  private installAudio(): void {
    const vm = this.#vm;
    const sink = this.#audio;
    vm.registerGlobal("PlaySound", (args) => { sink.playSound(String(args[0] ?? "")); return []; });
    vm.registerGlobal("PlaySoundFile", (args) => { sink.playSoundFile(String(args[0] ?? "")); return []; });
    vm.registerGlobal("PlayGlueMusic", (args) => { sink.playMusic(String(args[0] ?? "")); return []; });
    vm.registerGlobal("PlayMusic", (args) => { sink.playMusic(String(args[0] ?? "")); return []; });
    vm.registerGlobal("StopGlueMusic", () => { sink.stopMusic(); return []; });
    vm.registerGlobal("PlayGlueAmbience", (args) => {
      sink.playAmbience(String(args[0] ?? ""), Number(args[1]) || 0);
      return [];
    });
    vm.registerGlobal("StopGlueAmbience", (args) => { sink.stopAmbience(Number(args[0]) || 0); return []; });
    vm.registerGlobal("StopAllSFX", () => { sink.stopAllSfx(); return []; });
  }

  /**
   * The stock background-model route, which is a C call and not a widget method.
   *
   * `GlueParent.lua`'s `SetBackgroundModel(frame, name)` composes the path and then hands it to
   * `SetCharSelectBackground`/`SetCharCustomizeBackground` — the model never passes through
   * `model:SetModel` at all. Recorded, that made the whole stock path (and therefore every
   * `Interface\Glues\Models\UI_*` set, the ones that carry authored cameras) unreachable.
   */
  private installBackgroundModels(): void {
    const vm = this.#vm;
    const point = (frameName: string, path: string): void => {
      const frame = this.#bridge.getFrame(frameName);
      if (!frame) return;
      this.#bridge.update(frame, (mutable) => { mutable.model.file = path; });
    };
    vm.registerGlobal("SetCharSelectBackground", (args) => {
      point("CharacterSelect", String(args[0] ?? ""));
      return [];
    });
    vm.registerGlobal("SetCharCustomizeBackground", (args) => {
      point("CharacterCreate", String(args[0] ?? ""));
      return [];
    });
  }

  private installFrameApi(): void {
    const vm = this.#vm;
    const bridge = this.#bridge;
    vm.registerGlobal("CreateFrame", (args) => {
      const type = String(args[0] ?? "Frame");
      const name = args[1] === undefined ? undefined : String(args[1]);
      const parent = args[2] as FrameXmlFrame | undefined;
      const inherits = args[3] === undefined ? undefined : String(args[3]);
      return [bridge.CreateFrame(type, name, parent, inherits)];
    });
  }

  /** Fire a glue event into the corpus, as the real client's C side does. */
  fireEvent(event: string, ...args: readonly unknown[]): number {
    return this.#bridge.dispatchEvent(event, ...args);
  }

  /**
   * `DefaultServerLogin(account, password)` — the one C-API entry in this slice
   * that talks to the server.
   *
   * It runs the same SRP6 handshake the DOM login uses (`loginToRealmList` over
   * a `WebSocketByteStream` to the gateway's `/auth` route), and reports back
   * through the events the corpus already listens for, so `GlueDialog.lua`
   * shows the status dialog it has always shown. The mapping is kept small and
   * honest: connecting, authenticating, and then either a close plus a screen
   * transition attempt, or a close plus the failure dialog.
   */
  private installLogin(): void {
    const vm = this.#vm;
    vm.registerGlobal("DefaultServerLogin", (args) => {
      void this.login(String(args[0] ?? ""), String(args[1] ?? ""));
      return [];
    });
    // Both end whatever the CANCEL dialog was waiting for: the login, a realm's connection or its
    // queue, a rename's answer.
    vm.registerGlobal("CancelLogin", () => { this.cancelLogin(); this.#session.cancelPending(); return []; });
    vm.registerGlobal("StatusDialogClick", () => { this.cancelLogin(); this.#session.cancelPending(); return []; });
    // 10.10: the authenticator code. `TokenEntered(code)` (Wow.exe 0x4dc4d0 → 0x4d8080) hands the
    // typed code to the login that is waiting for it and puts the CANCEL dialog back up.
    vm.registerGlobal("TokenEntered", (args) => {
      const wait = this.#tokenWait;
      if (wait === undefined || args[0] === undefined || args[0] === null) return [];
      this.#tokenWait = undefined;
      this.fireEvent("OPEN_STATUS_DIALOG", "CANCEL", this.glueString("AUTHENTICATING", "Проверка учётной записи..."));
      wait.resolve(String(args[0]));
      return [];
    });
    // `GetUsesToken()`/`SetUsesToken(flag)` (0x4dbf10/0x4dbf30): a remembered flag the login screen
    // reads to show its code field up front; AccountLogin.lua sets it when a code is asked for.
    vm.registerGlobal("GetUsesToken", () => [this.#cvars.get(USES_TOKEN_CVAR) === "1"]);
    vm.registerGlobal("SetUsesToken", (args) => {
      const value = args[0];
      const on = value === true || (typeof value === "number" && value !== 0) || value === "1";
      this.setCVar(USES_TOKEN_CVAR, on ? "1" : "0");
      return [];
    });
  }

  /**
   * The login is past the challenge and the account wants an authenticator code: the status dialog
   * goes, PLAYER_ENTER_TOKEN brings up the corpus' own code dialog (or its pre-filled field), and the
   * proof waits for `TokenEntered`. A cancel, or a newer login, abandons the wait.
   */
  private awaitToken(generation: number): Promise<string> {
    if (generation !== this.#loginGeneration) return Promise.reject(new Error("login superseded"));
    this.#tokenWait?.reject(new Error("login superseded"));
    const waiting = new Promise<string>((resolve, reject) => { this.#tokenWait = { resolve, reject }; });
    this.fireEvent("CLOSE_STATUS_DIALOG");
    this.fireEvent("PLAYER_ENTER_TOKEN");
    return waiting;
  }

  private status(text: string): void {
    this.fireEvent("UPDATE_STATUS_DIALOG", text);
  }

  private glueString(key: string, fallback: string): string {
    return this.#vm.globalString(key) ?? fallback;
  }

  async login(account: string, password: string): Promise<void> {
    const generation = ++this.#loginGeneration;
    // What the client's DefaultServerLogin (FUN_004d8a30) refuses before it connects anywhere. The
    // logon challenge carries at most 16 bytes of name: no authserver holds a longer one, and what it
    // answers for a name it does not hold is WOW_FAIL_UNKNOWN_ACCOUNT.
    const unsendable = !account ? CLIENT_LOGIN_REFUSALS.noAccountName
      : !password ? CLIENT_LOGIN_REFUSALS.noPassword
        : ACCOUNT_NAME_ENCODER.encode(account).byteLength > MAX_ACCOUNT_NAME_BYTES
          ? authKey(AUTH_RESULTS.WOW_FAIL_UNKNOWN_ACCOUNT)
          : undefined;
    if (unsendable) {
      this.showLoginRefusal(unsendable);
      return;
    }
    this.closeAuth();
    const connect = this.#options.connect;
    const url = this.#options.authUrl;
    this.fireEvent("OPEN_STATUS_DIALOG", "CANCEL", this.glueString("CONNECTING", "Соединение..."));
    if (!connect || !url) {
      this.fireEvent("CLOSE_STATUS_DIALOG");
      openStatusDialog((event, ...args) => { this.fireEvent(event, ...args); }, "OKAY",
        "Шлюз недоступен: логин не настроен.");
      return;
    }
    try {
      const stream = await connect(url);
      if (generation !== this.#loginGeneration) {
        stream.close();
        return;
      }
      this.#loginStream = stream;
      this.status(this.glueString("AUTHENTICATING", "Проверка учётной записи..."));
      const session = await loginToRealmList(stream, {
        username: account,
        password,
        locale: this.#options.locale ?? "ruRU",
        onTokenRequired: () => this.awaitToken(generation),
      });
      if (generation !== this.#loginGeneration) return;
      this.#loginStream = undefined;
      // Kept open for the realm dialog's refreshes (10.08) rather than closed here.
      this.#authStream = stream;
      this.fireEvent("CLOSE_STATUS_DIALOG");
      this.#session.beginSession(session);
      this.#options.onSession?.(session);
      this.chooseRealmAfterLogin();

    } catch (error) {
      if (generation !== this.#loginGeneration) return;
      this.#loginStream?.close();
      this.#loginStream = undefined;
      this.fireEvent("CLOSE_STATUS_DIALOG");
      if (error instanceof AuthProtocolError && error.code !== undefined) {
        this.#options.onAuthDiagnostic?.(error.code);
      } else {
        // No result byte to name it: the player reads the client's words, the detail goes to the log.
        this.#options.session?.onDiagnostic?.(`login: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.showLoginRefusal(describeFailure(error, "auth"));
    }
  }

  /**
   * After a login: the realm this browser last chose on this gateway (10.07), when it is in the list
   * and open — SUGGEST_REALM, which the stock CharacterSelect answers with SetGlueScreen("charselect")
   * and ChangeRealm. Otherwise, or in a corpus with nobody listening for it, the realm list: the
   * corpus' own route, `RequestRealmList` → OPEN_REALM_LIST → `RealmList:Show()`, whose OK calls
   * `ChangeRealm`.
   */
  chooseRealmAfterLogin(): void {
    const remembered = this.#cvars.get("realmName");
    const position = remembered ? this.#session.realmPosition(remembered) : undefined;
    if (!position || !canSelectRealm(position.realm)
      || this.fireEvent("SUGGEST_REALM", position.category, position.index) === 0) {
      this.#session.showRealmList();
    }
  }

  /**
   * A refused login as the client shows it: its text, its fallback in a corpus without that text,
   * and its stock dialog — or OKAY in a corpus without that type (`showStatusMessage`).
   */
  private showLoginRefusal(refusal: GlueAuthMessage): void {
    this.showMessage(refusal, "Ошибка авторизации");
  }

  /** Whether the corpus defines `GlueDialogTypes[type]`. */
  private hasDialogType(type: string): boolean {
    const vm = this.#vm;
    vm.setGlobal(DIALOG_TYPE_PROBE, undefined);
    const ran = vm.execute(
      `local which = ...; ${DIALOG_TYPE_PROBE} = type(GlueDialogTypes) == "table" and GlueDialogTypes[which] ~= nil`,
      "@GlueApi:hasDialogType",
      [type],
    );
    const present = ran.ok && vm.getGlobal(DIALOG_TYPE_PROBE) === true;
    vm.setGlobal(DIALOG_TYPE_PROBE, undefined);
    return present;
  }

  /** 3.35-review: whether GlueDialog is shown with `type` — GlueDialog_Show ran to its end. */
  private dialogShown(type: string): boolean {
    const vm = this.#vm;
    vm.setGlobal(DIALOG_TYPE_PROBE, undefined);
    const ran = vm.execute(
      `local which = ...; ${DIALOG_TYPE_PROBE} = type(GlueDialog) == "table" and GlueDialog:IsShown() and GlueDialog.which == which and true or false`,
      "@GlueApi:dialogShown",
      [type],
    );
    const shown = ran.ok && vm.getGlobal(DIALOG_TYPE_PROBE) === true;
    vm.setGlobal(DIALOG_TYPE_PROBE, undefined);
    return shown;
  }

  /** `REALM_LIST` again on the auth connection, or `undefined` when none is open. */
  private refreshRealms(): Promise<RealmInfo[]> | undefined {
    const stream = this.#authStream;
    if (!stream) return undefined;
    return readRealmList(stream).catch((error: unknown) => {
      // A dead connection is not asked again; the list the login brought stays up.
      if (this.#authStream === stream) this.closeAuth();
      throw error;
    });
  }

  /** Drop the kept auth connection (a new login, `DisconnectFromServer`, the runtime closing). */
  closeAuth(): void {
    const stream = this.#authStream;
    this.#authStream = undefined;
    stream?.close();
  }

  cancelLogin(): void {

    this.#loginGeneration += 1;
    const wait = this.#tokenWait;
    this.#tokenWait = undefined;
    wait?.reject(new Error("login cancelled"));
    this.#loginStream?.close();
    this.#loginStream = undefined;
  }

  /** Report a name the corpus reached that only records, once per session. */
  private recordStub(name: string): void {
    if (this.#stubbed.has(name)) return;
    this.#stubbed.add(name);
    this.#options.onStub?.(name);
  }

  private installConstantStubs(): void {
    const vm = this.#vm;
    for (const [name, results] of Object.entries(CONSTANT_STUBS)) {
      if (this.#options.video && VIDEO_GLOBALS.has(name)) continue;
      if (this.#options.onQuit && (name === "QuitGame" || name === "QuitGameAndRunLauncher")) continue;
      if (this.#options.addons && GLUE_ADDON_GLOBALS.has(name)) continue;
      vm.registerGlobal(name, () => {
        this.recordStub(name);
        return results;
      });
    }
  }
}

/** Exported so a test can assert the stub table without re-deriving it. */
export const GLUE_CONSTANT_STUBS = CONSTANT_STUBS;
export const GLUE_CVAR_DEFAULTS = CVAR_DEFAULTS;
