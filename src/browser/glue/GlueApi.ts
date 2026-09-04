import type { GlueLuaVm } from "./GlueLua.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import { loginToRealmList, type AuthSessionResult } from "../../auth/login.js";
import type { BinaryByteStream } from "../../transport/WebSocketByteStream.js";
import { GlueSession, type GlueSessionOptions } from "./GlueSession.js";
import {
  installGlueCharacterApi, type GlueCharacterView, type GlueEnterWorldRequest,
} from "./GlueCharacterApi.js";
import { GlueCreation, type GlueCreationOptions } from "./GlueCreation.js";
import { installGlueCreateApi, type GlueCreationView } from "./GlueCreateApi.js";

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
  readonly session?: Omit<GlueSessionOptions, "fireEvent" | "setGlueScreen">;
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
}

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

/** The 3.3.5a build this client speaks, as `GetBuildInfo()` returns it. */
export const GLUE_BUILD_INFO: readonly [string, string, string, number] =
  Object.freeze(["3.3.5", "12340", "Jun 24 2010", 30300]) as readonly [string, string, string, number];

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
  // Character select / create — the rest of the list is real in `GlueCharacterApi.ts`; these are
  // paid services and declension, which this server has no packets for.
  RenameCharacter: [], DeclineCharacter: [], DeclineName: [],
  // The whole of `CharacterCreate` is real in `GlueCreateApi.ts`; what stays here is the paid
  // services this server has no packets for, and the random-name generator, which in the original
  // is a server call (`CMSG_CHAR_RENAME`'s cousin) and not a table this client can carry.
  CustomizeExistingCharacter: [], GetRandomName: [""],
  PaidChange_GetCurrentRaceIndex: [1], PaidChange_GetCurrentClassIndex: [1], PaidChange_GetName: [""],
  GetNumDeclensionSets: [0],
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
  TokenEntered: [], PINEntered: [], GetUsesToken: [false], SetUsesToken: [],
  // Addons: this client loads no glue addons.
  GetNumAddOns: [0], GetAddOnInfo: [], GetAddOnDependencies: [], GetAddOnEnableState: [0],
  EnableAddOn: [], DisableAddOn: [], EnableAllAddOns: [], DisableAllAddOns: [], ResetAddOns: [],
  SaveAddOns: [], LaunchAddOnURL: [], IsAddonVersionCheckEnabled: [false], SetAddonVersionCheck: [],
  // Video and audio options — the whole options tree is out of this slice.
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

  constructor(options: GlueApiOptions) {
    this.#vm = options.vm;
    this.#bridge = options.bridge;
    this.#options = options;
    this.#audio = options.audio ?? new RecordingGlueAudioSink();
    this.#session = new GlueSession({
      ...options.session,
      fireEvent: (event, ...args) => { this.fireEvent(event, ...args); },
      setGlueScreen: (name) => { this.setGlueScreen(name); },
    });
    this.#creation = new GlueCreation({
      // An empty dataset is a working screen with nothing on it, which is what a gateway that is
      // down looks like — the same floor `GlueSession` stands on with no realm list.
      source: options.creation?.source ?? EMPTY_CREATION_SOURCE,
      tables: options.creation?.tables ?? (() => ({ races: [], classes: [] })),
      ...(options.creation?.random ? { random: options.creation.random } : {}),
      create: async (request) => await this.#session.createCharacter(request),
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

  cvar(name: string): string | undefined {
    return this.#cvars.get(name);
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
    installGlueCharacterApi({
      vm: this.#vm,
      session: this.#session,
      setGlueScreen: (name) => { this.setGlueScreen(name); },
      fireEvent: (event, ...args) => { this.fireEvent(event, ...args); },
      ...(this.#options.characterView ? { view: this.#options.characterView } : {}),
      ...(this.#options.cursor ? { cursor: this.#options.cursor } : {}),
      ...(this.#options.enterWorld ? { enterWorld: this.#options.enterWorld } : {}),
      onStub: (name) => { this.recordStub(name); },
    });
    installGlueCreateApi({
      vm: this.#vm,
      creation: this.#creation,
      ...(this.#options.creationView ? { view: this.#options.creationView } : {}),
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

  /** The logical screen, live where the host has one and static where it does not. */
  get screenSize(): { readonly width: number; readonly height: number } {
    return this.#options.screen?.()
      ?? { width: this.#options.screenWidth ?? 1024, height: this.#options.screenHeight ?? 768 };
  }

  private installClientInfo(): void {
    const vm = this.#vm;
    vm.registerGlobal("GetBuildInfo", () => [...GLUE_BUILD_INFO]);
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
      if (name) this.#cvars.set(name, args[1] === undefined ? "" : String(args[1]));
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
      this.#cvars.set("accountName", String(args[0] ?? ""));
      return [];
    });
    vm.registerGlobal("GetSavedAccountList", () => [this.#cvars.get("accountList") ?? ""]);
    vm.registerGlobal("SetSavedAccountList", (args) => {
      this.#cvars.set("accountList", String(args[0] ?? ""));
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
    vm.registerGlobal("CancelLogin", () => { this.cancelLogin(); return []; });
    vm.registerGlobal("StatusDialogClick", () => { this.cancelLogin(); return []; });
  }

  private status(text: string): void {
    this.fireEvent("UPDATE_STATUS_DIALOG", text);
  }

  private glueString(key: string, fallback: string): string {
    return this.#vm.globalString(key) ?? fallback;
  }

  async login(account: string, password: string): Promise<void> {
    const generation = ++this.#loginGeneration;
    const connect = this.#options.connect;
    const url = this.#options.authUrl;
    this.fireEvent("OPEN_STATUS_DIALOG", "CANCEL", this.glueString("CONNECTING", "Соединение..."));
    if (!connect || !url) {
      this.fireEvent("CLOSE_STATUS_DIALOG");
      this.fireEvent("OPEN_STATUS_DIALOG", "OKAY", "Шлюз недоступен: логин не настроен.");
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
      });
      if (generation !== this.#loginGeneration) return;
      this.#loginStream = undefined;
      stream.close();
      this.fireEvent("CLOSE_STATUS_DIALOG");
      this.#session.beginSession(session);
      this.#options.onSession?.(session);
      // Straight to the realm list rather than to `charselect`, and that is the corpus' own route:
      // `RequestRealmList` fires OPEN_REALM_LIST, `RealmList:Show()` draws the dialog over the
      // login screen, and its OK button calls `ChangeRealm`, which is what connects to a world and
      // moves the screen on. The original has one more step in front of it — a preferred-realm
      // reply that skips the dialog — and this build has nothing to answer it with, so the dialog
      // always opens instead of a realm being chosen on the player's behalf.
      this.#session.requestRealmList();
    } catch (error) {
      if (generation !== this.#loginGeneration) return;
      this.#loginStream?.close();
      this.#loginStream = undefined;
      this.fireEvent("CLOSE_STATUS_DIALOG");
      const message = error instanceof Error ? error.message : String(error);
      this.fireEvent("OPEN_STATUS_DIALOG", "OKAY", message);
    }
  }

  cancelLogin(): void {
    this.#loginGeneration += 1;
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
