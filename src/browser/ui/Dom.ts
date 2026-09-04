import { GameWindowManager } from "../GameWindows.js";
import { gatewayWebSocketUrl } from "../Environment.js";

/**
 * Every element the interface holds on to, resolved once at start-up.
 *
 * The alternative is what this file grew out of: 166 `element(…)` calls at the top of a 2,600-line
 * module that also owned the render loop, the network wiring and every panel. A panel that lives in
 * its own file needs its own handles, and this is where they come from.
 */
export function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

export const form = element<HTMLFormElement>("login-form");
export const gatewayInput = element<HTMLInputElement>("gateway");
gatewayInput.value = gatewayWebSocketUrl(location);
export const usernameInput = element<HTMLInputElement>("username");
export const passwordInput = element<HTMLInputElement>("password");
export const tokenInput = element<HTMLInputElement>("token");
export const status = element<HTMLParagraphElement>("status");
export const realms = element<HTMLDivElement>("realms");
const loginSubmitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
if (!loginSubmitButton) throw new Error("Missing login submit button");
// Narrowed here rather than at the use site: a `| null` export carries no narrowing across a
// module boundary, and every panel that touched it would have to prove it again.
export const loginSubmit = loginSubmitButton;
/**
 * The DOM login card, which since G6 is the *fallback* front door rather than the only one.
 *
 * It had no id at all while it was the only thing on the page. It needs one now because something
 * has to be able to hide it: the client opens on the GlueXML screens unless `?legacy-login=1` (or
 * the `webclient.frontDoor` storage key) says otherwise.
 */
export const loginPanel = element<HTMLElement>("login-panel");
/** Where the client's own GlueXML screens mount, when they are the front door. See `glue/`. */
export const glueHost = element<HTMLElement>("glue-host");
export const glueStage = element<HTMLElement>("glue-stage");
export const glueStatus = element<HTMLElement>("glue-status");
export const characterPanel = element<HTMLElement>("character-panel");
export const characterStatus = element<HTMLParagraphElement>("character-status");
export const characters = element<HTMLDivElement>("characters");
export const createForm = element<HTMLFormElement>("create-form");
export const characterName = element<HTMLInputElement>("character-name");
export const characterRace = element<HTMLSelectElement>("character-race");
export const characterClass = element<HTMLSelectElement>("character-class");
export const characterGender = element<HTMLSelectElement>("character-gender");
const createSubmitButton = createForm.querySelector<HTMLButtonElement>('button[type="submit"]');
if (!createSubmitButton) throw new Error("Missing character create button");
export const createSubmit = createSubmitButton;
export const worldPanel = element<HTMLElement>("world-panel");
export const worldStatus = element<HTMLParagraphElement>("world-status");
export const playerPosition = element<HTMLParagraphElement>("player-position");
export const worldObjects = element<HTMLDivElement>("world-objects");
export const worldCanvas = element<HTMLCanvasElement>("world-canvas");
export const world3dCanvas = element<HTMLCanvasElement>("world-3d-canvas");
export const playerHudName = element<HTMLElement>("player-hud-name");
export const playerHudDetails = element<HTMLElement>("player-hud-details");
export const characterSkin = element<HTMLSelectElement>("character-skin");
export const characterFace = element<HTMLSelectElement>("character-face");
export const characterHair = element<HTMLSelectElement>("character-hair");
export const characterHairColor = element<HTMLSelectElement>("character-hair-color");
export const characterFacial = element<HTMLSelectElement>("character-facial");
export const characterFacialLabel = element<HTMLElement>("character-facial-label");
export const playerIcon = element<HTMLImageElement>("player-icon");
export const playerHealthBar = element<HTMLElement>("player-health-bar");
export const playerHealthText = element<HTMLElement>("player-health-text");
export const playerPowerBar = element<HTMLElement>("player-power-bar");
export const playerExperience = element<HTMLElement>("player-experience");
export const playerCast = element<HTMLElement>("player-cast");
export const targetPower = element<HTMLElement>("target-power");
export const targetCast = element<HTMLElement>("target-cast");
export const actionBar = element<HTMLElement>("action-bar");
export const movementStatus = element<HTMLParagraphElement>("movement-status");
export const terrainStatus = element<HTMLParagraphElement>("terrain-status");
export const environmentStatus = element<HTMLParagraphElement>("environment-status");
export const renderStatus = element<HTMLParagraphElement>("render-status");
export const fullFrameStatus = element<HTMLParagraphElement>("full-frame-status");
export const creatureStatus = element<HTMLParagraphElement>("creature-status");
export const modelStatus = element<HTMLParagraphElement>("model-status");
export const targetPanel = element<HTMLElement>("target-panel");
export const targetIcon = element<HTMLImageElement>("target-icon");
export const targetName = element<HTMLElement>("target-name");
export const targetDetails = element<HTMLElement>("target-details");
/** The target frame's button row — and the `target-frame/actions` slot a patch fills (М7). */
export const targetActions = element<HTMLElement>("target-actions");
export const targetHealthBar = element<HTMLElement>("target-health-bar");
export const targetHealthText = element<HTMLElement>("target-health-text");
export const playerAuras = element<HTMLDivElement>("player-auras");
export const targetAuras = element<HTMLDivElement>("target-auras");
export const attackButton = element<HTMLButtonElement>("attack-button");
export const interactButton = element<HTMLButtonElement>("interact-button");
export const clearTargetButton = element<HTMLButtonElement>("clear-target-button");
export const combatStatus = element<HTMLParagraphElement>("combat-status");
export const swingWarning = element<HTMLParagraphElement>("swing-warning");
export const spellStatus = element<HTMLParagraphElement>("spell-status");
export const spellbookList = element<HTMLDivElement>("spellbook-list");
export const spellbookSearch = element<HTMLInputElement>("spellbook-search");
export const spellbookHideRanks = element<HTMLInputElement>("spellbook-hide-ranks");
export const characterWindow = element<HTMLElement>("character-window");
export const inventoryWindow = element<HTMLElement>("inventory-window");
export const spellbookWindow = element<HTMLElement>("spellbook-window");
export const gossipWindow = element<HTMLElement>("gossip-window");
export const questWindow = element<HTMLElement>("quest-window");
export const diagnosticsWindow = element<HTMLElement>("diagnostics-window");
export const unhandledStatus = element<HTMLElement>("unhandled-status");
export const unhandledOpcodeList = element<HTMLDivElement>("unhandled-opcodes");
export const unhandledSave = element<HTMLButtonElement>("unhandled-save");
/** The capsule counter: how many units are still stand-ins, and which of the five reasons it was. */
export const capsuleStatus = element<HTMLElement>("capsule-status");
export const capsuleReasons = element<HTMLDivElement>("capsule-reasons");
/** The two panes of the diagnostics window and the strip that switches between them. */
export const diagnosticsTabs = element<HTMLDivElement>("diagnostics-tabs");
export const diagnosticsState = element<HTMLDivElement>("diagnostics-state");
export const diagnosticsPackets = element<HTMLDivElement>("diagnostics-packets");
export const customPacketStatus = element<HTMLElement>("custom-packet-status");
export const customPacketModules = element<HTMLDivElement>("custom-packet-modules");
export const customPacketList = element<HTMLDivElement>("custom-packet-list");
export const customPacketWarnings = element<HTMLDivElement>("custom-packet-warnings");
/** The «Окна» pane: which module windows are live, and the two that can be tried without a module. */
export const diagnosticsWindows = element<HTMLDivElement>("diagnostics-windows");
export const moduleWindowStatus = element<HTMLElement>("module-window-status");
export const moduleWindowExample = element<HTMLButtonElement>("module-window-example");
export const moduleWindowStudio = element<HTMLButtonElement>("module-window-studio");
export const modulePatchExample = element<HTMLButtonElement>("module-patch-example");
/** Opens М8's editor. The same overlay the unbound `toggleWindowBuilder` action reaches. */
export const moduleWindowBuilder = element<HTMLButtonElement>("module-window-builder");
export const moduleWindowList = element<HTMLDivElement>("module-window-list");
export const moduleWindowProblems = element<HTMLDivElement>("module-window-problems");
export const lootButton = element<HTMLButtonElement>("loot-button");
export const chatLog = element<HTMLDivElement>("chat-log");
export const chatTabs = element<HTMLDivElement>("chat-tabs");
export const playerHud = element<HTMLDivElement>("player-hud");
export const spellbookTabs = element<HTMLDivElement>("spellbook-tabs");
export const partyFrames = element<HTMLDivElement>("party-frames");
/** Slice I2's frames. Each is an empty box in the page; the widget kit fills it at start-up. */
export const targetOfTargetFrame = element<HTMLDivElement>("tot-frame");
export const focusFrame = element<HTMLDivElement>("focus-frame");
export const petFrame = element<HTMLDivElement>("pet-frame");
export const raidFrames = element<HTMLDivElement>("raid-frames");
export const bossFrames = element<HTMLDivElement>("boss-frames");
/** The right-hand column the minimap, the quest tracker and the boss and arena frames share. */
export const rightRail = element<HTMLDivElement>("right-rail");
export const arenaFrames = element<HTMLDivElement>("arena-frames");
export const auctionWindow = element<HTMLElement>("auction-window");
export const auctionMessage = element<HTMLElement>("auction-message");
export const auctionSearch = element<HTMLInputElement>("auction-search");
export const auctionFind = element<HTMLButtonElement>("auction-find");
export const auctionMine = element<HTMLButtonElement>("auction-mine");
export const auctionList = element<HTMLDivElement>("auction-list");
export const lfgWindow = element<HTMLElement>("lfg-window");
export const lfgMessage = element<HTMLElement>("lfg-message");
export const lfgQueue = element<HTMLElement>("lfg-queue");
export const lfgProposalBox = element<HTMLElement>("lfg-proposal");
export const lfgProposalText = element<HTMLElement>("lfg-proposal-text");
export const lfgAccept = element<HTMLButtonElement>("lfg-accept");
export const lfgDecline = element<HTMLButtonElement>("lfg-decline");
export const lfgTank = element<HTMLInputElement>("lfg-tank");
export const lfgHealer = element<HTMLInputElement>("lfg-healer");
export const lfgDamage = element<HTMLInputElement>("lfg-damage");
export const lfgDungeons = element<HTMLInputElement>("lfg-dungeons");
export const lfgJoin = element<HTMLButtonElement>("lfg-join");
export const lfgLeave = element<HTMLButtonElement>("lfg-leave");
export const lfgTeleport = element<HTMLButtonElement>("lfg-teleport");
export const guildWindow = element<HTMLElement>("guild-window");
export const guildTitle = element<HTMLElement>("guild-title");
export const guildMessage = element<HTMLElement>("guild-message");
export const guildMotd = element<HTMLElement>("guild-motd");
export const guildRoster = element<HTMLDivElement>("guild-roster");
export const guildInviteWindow = element<HTMLElement>("guild-invite");
export const guildInviteText = element<HTMLElement>("guild-invite-text");
export const guildAccept = element<HTMLButtonElement>("guild-accept");
export const guildDecline = element<HTMLButtonElement>("guild-decline");
export const mailWindow = element<HTMLElement>("mail-window");
export const mailMessage = element<HTMLElement>("mail-message");
export const mailList = element<HTMLDivElement>("mail-list");
export const mailTo = element<HTMLInputElement>("mail-to");
export const mailSubject = element<HTMLInputElement>("mail-subject");
export const mailBody = element<HTMLTextAreaElement>("mail-body");
export const mailMoney = element<HTMLInputElement>("mail-money");
export const mailSend = element<HTMLButtonElement>("mail-send");
export const tradeWindow = element<HTMLElement>("trade-window");
export const tradeTitle = element<HTMLElement>("trade-title");
export const tradeMessage = element<HTMLElement>("trade-message");
export const tradeMine = element<HTMLDivElement>("trade-mine");
export const tradeTheirs = element<HTMLDivElement>("trade-theirs");
export const tradeTheirTitle = element<HTMLElement>("trade-their-title");
export const tradeGold = element<HTMLInputElement>("trade-gold");
export const tradeSetGold = element<HTMLButtonElement>("trade-set-gold");
export const tradeAccept = element<HTMLButtonElement>("trade-accept");
export const tradeCancel = element<HTMLButtonElement>("trade-cancel");
export const duelWindow = element<HTMLElement>("duel-window");
export const duelText = element<HTMLElement>("duel-text");
export const duelAccept = element<HTMLButtonElement>("duel-accept");
export const duelDecline = element<HTMLButtonElement>("duel-decline");
export const groupInviteWindow = element<HTMLElement>("group-invite");
export const groupInviteText = element<HTMLElement>("group-invite-text");
export const groupAccept = element<HTMLButtonElement>("group-accept");
export const groupDecline = element<HTMLButtonElement>("group-decline");
export const chatForm = element<HTMLFormElement>("chat-form");
export const chatInput = element<HTMLInputElement>("chat-input");
export const vendorButton = element<HTMLButtonElement>("vendor-button");
export const trainerButton = element<HTMLButtonElement>("trainer-button");
export const bankerButton = element<HTMLButtonElement>("banker-button");
export const vendorWindow = element<HTMLElement>("vendor-window");
export const vendorItems = element<HTMLDivElement>("vendor-items");
export const buybackTitle = element<HTMLElement>("buyback-title");
export const buybackItems = element<HTMLDivElement>("buyback-items");
export const merchantMessage = element<HTMLElement>("merchant-message");
export const trainerWindow = element<HTMLElement>("trainer-window");
export const trainerGreeting = element<HTMLElement>("trainer-greeting");
export const trainerMessage = element<HTMLElement>("trainer-message");
export const trainerSpells = element<HTMLDivElement>("trainer-spells");
export const lootWindow = element<HTMLElement>("loot-window");
export const lootError = element<HTMLElement>("loot-error");
export const lootMoney = element<HTMLButtonElement>("loot-money");
export const lootItems = element<HTMLDivElement>("loot-items");
export const deathWindow = element<HTMLElement>("death-window");
export const deathStatus = element<HTMLElement>("death-status");
export const deathRelease = element<HTMLButtonElement>("death-release");
export const deathReclaim = element<HTMLButtonElement>("death-reclaim");
export const deathSpirit = element<HTMLButtonElement>("death-spirit");
export const resurrectRequest = element<HTMLElement>("resurrect-request");
export const resurrectText = element<HTMLElement>("resurrect-text");
export const resurrectAccept = element<HTMLButtonElement>("resurrect-accept");
export const resurrectDecline = element<HTMLButtonElement>("resurrect-decline");
export const characterToggle = element<HTMLButtonElement>("character-toggle");
export const characterMicroIcon = element<HTMLImageElement>("character-micro-icon");
export const inventoryToggle = element<HTMLButtonElement>("inventory-toggle");
export const spellbookToggle = element<HTMLButtonElement>("spellbook-toggle");
export const talentsToggle = element<HTMLButtonElement>("talents-toggle");
export const gameMenuToggle = element<HTMLButtonElement>("game-menu-toggle");
export const characterWindowTitle = element<HTMLElement>("character-window-title");
export const characterTabs = element<HTMLElement>("character-tabs");
export const characterTabSheet = element<HTMLButtonElement>("character-tab-sheet");
export const characterTabSkills = element<HTMLButtonElement>("character-tab-skills");
export const characterTabCollections = element<HTMLButtonElement>("character-tab-collections");
export const characterSheetPane = element<HTMLDivElement>("character-sheet-pane");
export const characterSkillsPane = element<HTMLDivElement>("character-skills-pane");
export const characterCollectionsPane = element<HTMLDivElement>("character-collections-pane");
export const characterMounts = element<HTMLDivElement>("character-mounts");
export const characterCompanions = element<HTMLDivElement>("character-companions");
export const characterCombatPets = element<HTMLDivElement>("character-combat-pets");
export const characterIdentity = element<HTMLElement>("character-identity");
export const characterModel = element<HTMLDivElement>("character-model");
export const characterStats = element<HTMLDivElement>("character-stats");
export const equipmentSlots = element<HTMLDivElement>("equipment-slots");
export const equipmentSets = element<HTMLDivElement>("equipment-sets");
export const bagBar = element<HTMLDivElement>("bag-bar");
export const inventorySlots = element<HTMLDivElement>("inventory-slots");
export const inventoryMoney = element<HTMLDivElement>("inventory-money");
export const inventoryMessage = element<HTMLElement>("inventory-message");
export const gossipTitle = element<HTMLElement>("gossip-title");
export const gossipText = element<HTMLParagraphElement>("gossip-text");
export const gossipOptions = element<HTMLDivElement>("gossip-options");
export const gossipQuests = element<HTMLDivElement>("gossip-quests");
export const questTitle = element<HTMLElement>("quest-title");
export const questBody = element<HTMLParagraphElement>("quest-body");
export const questObjectives = element<HTMLParagraphElement>("quest-objectives");
export const questRequired = element<HTMLDivElement>("quest-required");
export const questRewards = element<HTMLDivElement>("quest-rewards");
export const questStatus = element<HTMLParagraphElement>("quest-status");
export const questActions = element<HTMLElement>("quest-actions");
export const resetLayout = element<HTMLButtonElement>("reset-layout");

export const gameWindows = new GameWindowManager(element<HTMLElement>("world-viewport"));
for (const gameWindow of document.querySelectorAll<HTMLElement>("#world-viewport .game-window")) gameWindows.attach(gameWindow);
