/**
 * The options this client actually honours, and how they travel.
 *
 * Deliberately short. An option that nothing reads is worse than no option: it teaches the player
 * that the settings window does not work. Every entry below is wired to something on screen, and
 * the list grows when a feature grows, not before.
 *
 * The blob is JSON. The original client's config cache is a `.wtf` file whose exact layout is not
 * discoverable from anything in this repo — no FrameXML writer, no packet, no reference client —
 * so interoperating with a retail client on the same account was never on the table. What is on
 * the table is the settings following the *account* rather than the browser profile, which is what
 * the eight slots are for.
 *
 * DOM-free: this is the part with the defaults and the clamping in it.
 */

export type SettingKind = "boolean" | "number";

export const SETTING_GROUPS = ["Игра", "Графика", "Эффекты", "Интерфейс", "Звук", "Чат"] as const;
export type SettingGroup = typeof SETTING_GROUPS[number];

export interface SettingDefinition {
  id: string;
  label: string;
  hint?: string | undefined;
  kind: SettingKind;
  fallback: boolean | number;
  /** Numbers only. */
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** Which group the window draws it under. */
  group: SettingGroup;
  /**
   * Drawn by the window it belongs to rather than by the settings window.
   *
   * Stored, clamped and carried on the account blob exactly like the rest — only the control is
   * somewhere else, because that is where the original client puts it. The alternative is two
   * checkboxes for one value on two screens, which is how a settings window stops being believed.
   */
  ownWindow?: boolean | undefined;
}

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    id: "chatBubbles", label: "Пузыри над головами", group: "Игра", kind: "boolean", fallback: true,
    hint: "Что говорят рядом — над головой говорящего, а не только в чате.",
  },
  {
    id: "floatingCombatText", label: "Всплывающий урон", group: "Игра", kind: "boolean", fallback: true,
    hint: "Числа урона и лечения поднимаются над тем, кто их получил.",
  },
  {
    id: "plateEnemies", label: "Таблички над врагами", group: "Игра", kind: "boolean", fallback: true,
    hint: "Имя, уровень, здоровье и полоса каста над всем, что можно ударить.",
  },
  {
    id: "plateFriends", label: "Таблички над союзниками", group: "Игра", kind: "boolean", fallback: false,
    hint: "В городе это табличка над каждым стражником и каждым прохожим, поэтому выключено.",
  },
  {
    id: "renderScale", label: "Масштаб отрисовки, %", group: "Графика", kind: "number", fallback: 100,
    min: 50, max: 100, step: 5,
    hint: "Мир рисуется в этой доле от размера окна и растягивается. Ниже 100 — быстрее и мягче.",
  },
  {
    id: "autoQuality", label: "Автокачество графики", group: "Графика", kind: "boolean", fallback: true,
    hint: "При долгой просадке кадров клиент сам опускает масштаб отрисовки не ниже 40% и возвращает его, когда запас держится. Ручной масштаб выше — потолок, а не приказ.",
  },
  {
    id: "lightingQuality", label: "Качество освещения", group: "Графика", kind: "number", fallback: 1,
    min: 0, max: 2, step: 1,
    hint: "0 — исходное освещение, 1 — мягкий тёплый свет и фонари, 2 — больше источников света и детальные тени.",
  },
  {
    id: "wmoOcclusion", label: "Скрывать невидимые помещения", group: "Графика", kind: "boolean", fallback: true,
    hint: "Порталы зданий не рисуют комнаты за стенами. Выключить — оставить только отсечение по дальности.",
  },
  {
    id: "characterAtlasAnisotropy", label: "Чёткость текстур персонажей", group: "Графика", kind: "boolean", fallback: false,
    hint: "Сохраняет детали одежды и кожи при взгляде под углом. Может увеличить нагрузку на видеокарту.",
  },
  {
    id: "experimentalAerialHeightFog", label: "Атмосферная дымка", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Смягчает дальний пейзаж и подсвечивает дымку со стороны солнца. Сохраняет цвета и погоду текущей зоны.",
  },
  {
    id: "experimentalTerrainMicroNormals", label: "Микрорельеф земли", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Свет подчёркивает мелкие неровности камня, земли и дорог. Вдали эффект плавно ослабевает.",
  },
  {
    id: "experimentalWaterFresnel", label: "Отражения на воде", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Поверхность сильнее отражает свет при взгляде вдоль воды и остаётся прозрачнее при взгляде сверху.",
  },
  {
    id: "experimentalWaterMicroWaves", label: "Рябь на воде", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Мелкие волны оживляют поверхность рек, озёр и моря.",
  },
  {
    id: "experimentalWaterSunSparkle", label: "Солнечные блики на воде", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Добавляет мерцающую дорожку отражённого солнца. Под водой блики затухают.",
  },
  {
    id: "experimentalWaterFoam", label: "Пена у берега", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Тонкая движущаяся полоска пены появляется на мелководье.",
  },
  {
    id: "experimentalVegetationWind", label: "Ветер в листве и траве", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Листья, цветы и трава слегка колышутся на ветру.",
  },
  // Wind, weather and ambient life (AtmosphereEffects.ts). None of these is in the original
  // client; each is its own switch, the «Улучшенная графика» preset turns them all on and the
  // comparison profile turns them all off.
  {
    id: "experimentalWindGusts", label: "Порывы ветра", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Один ветер на всю округу: порывы волнами проходят по траве, деревья клонятся, в непогоду сильнее. Нужен «Ветер в листве и траве».",
  },
  {
    id: "experimentalRainStreaks", label: "Косой дождь и метель", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Дождь, снег и песок летят по ветру, капли вытягиваются в струи, вдали видна пелена дождя.",
  },
  {
    id: "experimentalRainSplashes", label: "Брызги и круги от капель", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Капли разбиваются о землю рядом с персонажем и расходятся кругами по воде и лужам.",
  },
  {
    id: "experimentalWetSurfaces", label: "Мокрая земля в дождь", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Под дождём земля темнеет, блестит и собирает лужи, а после дождя постепенно высыхает.",
  },
  {
    id: "experimentalLightning", label: "Молнии в грозу", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Во время грозы небо вспыхивает, вдали бьют молнии. Только когда сервер присылает грозу.",
  },
  {
    id: "experimentalAmbientMotes", label: "Пыльца, светлячки и листопад", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Иногда на солнечных полянах проплывает пыльца (ярче всего утром и вечером), ночью над травой мерцают светлячки, под деревьями падают листья.",
  },
  {
    // The client's own weather loops and a thunder clap after each lightning strike
    // (WeatherSound.ts). Obeys the ambience slider; OFF plays nothing.
    id: "experimentalWeatherSounds", label: "Звуки грозы и ветра", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Шум дождя, снегопада и песчаной бури, ветер в непогоду и гром после каждой молнии — с задержкой по расстоянию. Громкость — ползунок «Окружение».",
  },
  {
    // The original client's own underwater view, ported from the reference client's overlay: a
    // depth tint and the waterline that sweeps across the screen as the eye crosses the surface.
    // On by default — it is what the client looks like under water, not an addition to it — and
    // off restores the exact frame that pre-dates it, without an extra draw call.
    id: "underwaterOverlay", label: "Эффект под водой", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Добавляет оттенок глубины и мягкую границу поверхности при погружении камеры.",
  },
  {
    // The original client's own `ffxGlow`, and its strength is authored per zone in
    // `LightParams.Glow` rather than chosen here: Stormwind 0.30, Elwynn 0.65, Darnassus 1.00,
    // Ironforge and Dalaran exactly 0. On by default — the owner asked for the WoW look — while
    // its switch remains independent of the solar-rays leaf. The exact direct pre-P4 path is used
    // only when both post-process leaves are off.
    id: "fullscreenGlow", label: "Полноэкранное свечение", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Мягкое сияние вокруг ярких участков. Сила свечения зависит от текущей зоны.",
  },
  {
    id: "godRays", label: "Солнечные лучи", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Солнечный свет пробивается сквозь силуэты деревьев и зданий. Требует качества освещения 1 или 2.",
  },
  {
    // The owner's ask: shafts more pronounced than the quality ceiling allows, without touching the
    // cinematic slider that scales grade, bloom and haze along with them. A multiplier over that
    // ceiling on both shaft paths (the classic radial pass and CinematicPost's march); 100 is
    // exactly the look before the slider existed, and the leaf's own switch still decides whether
    // the effect runs, so this reads nothing while «Солнечные лучи» is off.
    id: "godRayStrength", label: "Сила солнечных лучей, %", group: "Эффекты", kind: "number", fallback: 100,
    min: 25, max: 300, step: 25,
    hint: "Усиливает солнечные лучи поверх потолка качества освещения: 100 — нынешний вид, 300 — самые выраженные. Не действует, пока выключены «Солнечные лучи».",
  },
  {
    id: "experimentalFantasyGlow", label: "Свечение магии и лавы", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Делает ярче светящиеся части заклинаний и раскалённые поверхности.",
  },
  {
    // Cinematic leaves of «Улучшенная графика» (CinematicPost.ts). The four post-process ones share
    // the glow chain's capture and cost a full-screen pass or more, so they are off until the preset
    // or the player turns them on; the two material ones are free and follow the water/wind leaves.
    id: "experimentalCinematicGrade", label: "Кинематографичная цветокоррекция", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Плёночная кривая, тёплые блики и прохладные тени по цветам зоны и времени суток: золотой закат, холодная ночь. Лёгкая виньетка и привыкание глаз при входе в помещение.",
  },
  {
    // One multiplier over the cinematic leaves above and below (CinematicPost `setStrength`): grade,
    // bloom and sun glare, aerial scattering and the sun shafts together. 100 is the tuned look;
    // it reads nothing while those leaves are off, and lighting quality 0 turns them all off.
    id: "cinematicStrength", label: "Сила кинематографичных эффектов, %", group: "Эффекты", kind: "number", fallback: 100,
    min: 0, max: 150, step: 5,
    hint: "Одним движением усиливает или ослабляет цветокоррекцию, свечение и солнце, дымку и солнечные лучи. 0 — эффекты нейтральны, 100 — настроенный вид, 150 — максимум.",
  },
  {
    id: "experimentalCinematicBloom", label: "Мягкое свечение и солнце", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Яркие места мягко светятся, в небе появляется солнечный диск с ореолом, который перекрывают деревья и здания.",
  },
  {
    id: "experimentalSunScattering", label: "Рассеяние света в воздухе", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Воздух между вами и далёкими предметами светлеет, а в сторону низкого солнца дымка окрашивается его светом.",
  },
  {
    id: "experimentalAmbientOcclusion", label: "Контактные тени (SSAO)", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Затеняет углы, щели и землю у стен, деревьев и персонажей. Считается в половинном разрешении и отключается, когда автокачество снижает масштаб ниже 70%.",
  },
  {
    id: "experimentalLowSunRimLight", label: "Контровой свет низкого солнца", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "На закате и рассвете края персонажей, листвы и статуй подсвечиваются тёплым светом. Требует качества освещения 1 или 2.",
  },
  {
    id: "experimentalWaterSunGlitter", label: "Солнечная дорожка на воде", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Низкое солнце рассыпается по волнам дорожкой искрящихся бликов.",
  },
  {
    id: "experimentalWaterSkyReflection", label: "Отражение неба в воде", group: "Эффекты", kind: "boolean", fallback: true,
    hint: "Вода отражает небо текущей зоны и времени суток: на закате золотится, ночью темнеет до синевы. Требует качества освещения 1 или 2.",
  },
  {
    id: "experimentalSceneryShadows", label: "Тени от деревьев и зданий", group: "Эффекты", kind: "boolean", fallback: false,
    hint: "Деревья, здания городов и крупные предметы отбрасывают солнечные тени до дальнего плана; вдали тени плавно исчезают. Требует качества освещения 1 или 2 и добавляет работы видеокарте.",
  },
  {
    // The original client's «Детализация ландшафта» (`environmentDetail`, 0.5–1.5 in steps of a
    // quarter, VideoOptionsPanels.lua), in percent: a multiplier on how far M2 scenery is drawn,
    // each model to a distance scaled by its own size (WorldRenderer3D `environmentSceneryRange`).
    id: "objectDistance", label: "Дальность прорисовки объектов, %", group: "Графика", kind: "number", fallback: 100,
    min: 50, max: 150, step: 25,
    hint: "Как далеко видны деревья, кусты и другие объекты окружения; большие видны дальше мелких. 100 — дерево до 600 ярдов, 150 — до 750. Меньше — быстрее.",
  },
  {
    // The original client's own «Ground Clutter Radius»: ground cover gets a ceiling of its own
    // rather than a share of the doodad range, which is what the reference client does and says
    // why — "grass stops between 70 and 140 yards in the original client while doodads run to the
    // horizon" (`wowee/include/rendering/m2_renderer.hpp:566-575`). The default sits below that
    // range deliberately. The web camera has less distance fog than the reference, so 80 yards and
    // the renderer's soft outer band keep the field from visibly appearing in front of the player.
    // Zero still turns the field off outright.
    id: "grassRadius", label: "Дальность травы", group: "Графика", kind: "number", fallback: 80,
    min: 0, max: 180, step: 10,
    hint: "В ярдах. Трава и кустики рисуются только внутри этого круга; 0 — не рисовать вовсе.",
  },
  {
    // The density unit, which nothing offline settles: `GroundEffectTexture.Density` is either
    // doodads per 4.17-yard detail cell or per 33.3-yard chunk, and the two differ by 64 times.
    // The whole argument is on `ScatterOptions.perCell` in GroundCover.ts; thirty seconds in
    // Elwynn settles it, which is why the other reading is a switch and not a deleted branch.
    id: "grassDense", label: "Густая трава", group: "Графика", kind: "boolean", fallback: true,
    hint: "Плотность из таблицы — на клетку 4,17 ярда. Выключить: та же плотность на чанк, в 64 раза реже.",
  },
  {
    // Multiplier over the authored per-cell density: 1 is what the table says, 2 doubles every
    // clump. Positions stay a pure function of cell and index, so moving the slider thickens the
    // same meadow instead of reshuffling it; the field budget scales with it.
    id: "grassDensity", label: "Густота травы", group: "Графика", kind: "number", fallback: 2,
    min: 1, max: 4, step: 1,
    hint: "Во сколько раз гуще авторской плотности. 1 — как в таблице, 4 — луг стеной (и тяжелее).",
  },
  {
    // The original client's `cameraDistanceMaxFactor` (`InterfaceOptionsPanels.lua:1440`), which is
    // a multiplier from 1 to 2 in steps of a tenth. In yards here rather than in multiples, for a
    // reason that lives in the code above: `coerceSetting` rounds every number setting to a whole
    // one, so a factor slider would collapse to 1 or 2 with nothing in between. Yards is also the
    // unit the wheel already speaks, and 55 is where it has always stopped.
    id: "cameraMaxDistance", label: "Максимальная дистанция камеры", group: "Игра", kind: "number", fallback: 55,
    min: 15, max: 55, step: 5,
    hint: "В ярдах. Как далеко колесо отпускает камеру: меньше — ближе к персонажу и меньше мира в кадре.",
  },
  {
    id: "originalFrameXml", label: "Оригинальный интерфейс WoW", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Включено — оригинальные окна и панели WoW 3.3.5a. Выключено — интерфейс WebClient. Переключается в игре, выбор сохраняется.",
  },
  {
    id: "tswowAddons", label: "Аддоны TSWoW", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Lua-аддоны и пользовательские окна TSWoW. После изменения заново войдите в мир или обновите страницу.",
  },
  {
    id: "showFps", label: "Показывать FPS", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Счётчик сверху: средний FPS, среднее и максимальное время кадра за последние 120 кадров. Горячую клавишу можно изменить в управлении.",
  },
  {
    id: "uiScale", label: "Масштаб интерфейса, %", group: "Интерфейс", kind: "number", fallback: 100,
    min: 75, max: 125, step: 5,
    hint: "Меняет размер HUD и игровых окон, не снижая разрешение мира.",
  },
  {
    id: "actionBarBottomLeft", label: "Нижняя левая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 73-84 из тех 144, что держит сервер. Клавиши для них назначаются в окне привязок.",
  },
  {
    id: "actionBarBottomRight", label: "Нижняя правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 85-96.",
  },
  {
    id: "actionBarRight", label: "Правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 97-108.",
  },
  {
    id: "actionBarRight2", label: "Вторая правая панель команд", group: "Интерфейс", kind: "boolean", fallback: false,
    hint: "Слоты 109-120.",
  },
  {
    id: "minimapRotate", label: "Поворачивать миникарту", group: "Интерфейс", kind: "boolean", fallback: false,
  },
  {
    id: "notices", label: "Показывать отказы сервера", group: "Интерфейс", kind: "boolean", fallback: true,
    hint: "«Вне зоны действия», «нет места» и прочее — посреди экрана.",
  },
  {
    // The original client's `ShowAllSpellRanksCheckBox`, inverted so that the default is the tidy
    // book: on by default because the server has already thrown away the lower ranks of everything
    // that is not stackable, and what it leaves behind is where the pile comes from — a mage's
    // book holds 351 spells on this dataset and 132 of them are the top of their chain.
    // Blizzard hides this switch for warriors and rogues, and the numbers say why: their spells
    // cost rage and energy, `SpellInfo::IsStackableWithRanks` returns false for those, and the
    // server sends one rank of each already.
    id: "spellbookHideLowerRanks", label: "Только высшие ранги", group: "Интерфейс", kind: "boolean",
    fallback: true, ownWindow: true,
    hint: "Книга показывает только старший ранг каждого заклинания. Галочка — в шапке книги.",
  },
  {
    // The stock «Использовать менеджер экипировки» (InterfaceOptionsPanels.xml's Features panel,
    // CVar equipmentManager): PaperDollFrame shows GearManagerToggleButton while it is on
    // (GearManagerDialog_OnEvent VARIABLES_LOADED). Off as the client ships it; drawn by the stock
    // Interface Options, which is the only thing that reads it, and persisted here so it survives a reload.
    id: "equipmentManager", label: "Менеджер экипировки", group: "Интерфейс", kind: "boolean",
    fallback: false, ownWindow: true,
    hint: "Кнопка наборов экипировки в окне персонажа. Галочка — в настройках оригинального интерфейса.",
  },
  {
    id: "volumeMaster", label: "Общая громкость, %", group: "Звук", kind: "number", fallback: 70,
    min: 0, max: 100, step: 5,
    hint: "Ноль — тишина, а не пауза: звуки идут своим чередом, их просто не слышно.",
  },
  {
    id: "volumeEffects", label: "Звуки мира, %", group: "Звук", kind: "number", fallback: 100,
    min: 0, max: 100, step: 5,
    hint: "То, что звучит из точки в мире: заклинания, двери, существа. Слышно с той стороны, где оно стоит.",
  },
  {
    id: "volumeMusic", label: "Музыка, %", group: "Звук", kind: "number", fallback: 60,
    min: 0, max: 100, step: 5,
    hint: "Тема зоны и то, что сервер ставит вместо неё.",
  },
  {
    // The client's own Sound_AmbienceVolume (AudioOptionsPanels.lua), 0.6 there too. The ambience
    // channel followed the music slider before this row existed; the stock audio panel has both.
    id: "volumeAmbience", label: "Звуки окружения, %", group: "Звук", kind: "number", fallback: 60,
    min: 0, max: 100, step: 5,
    hint: "Фон зоны: ветер, вода, шум города.",
  },
  {
    // The four switches of the stock audio panel (Sound_EnableAllSound, _EnableSFX, _EnableMusic,
    // _EnableAmbience): off silences the channel and keeps its slider where it was, as the client does.
    id: "soundEnabled", label: "Включить звук", group: "Звук", kind: "boolean", fallback: true,
    hint: "Выключено — тишина во всём: мир, музыка, окружение и интерфейс.",
  },
  {
    id: "soundEffectsEnabled", label: "Звуки мира", group: "Звук", kind: "boolean", fallback: true,
    hint: "Заклинания, шаги, существа. Громкость остаётся на своём ползунке.",
  },
  {
    id: "musicEnabled", label: "Музыка", group: "Звук", kind: "boolean", fallback: true,
  },
  {
    id: "ambienceEnabled", label: "Звуки окружения", group: "Звук", kind: "boolean", fallback: true,
  },
  {
    id: "autoLoot", label: "Автоподбор добычи", group: "Игра", kind: "boolean", fallback: false,
    hint: "Сразу забирать всё доступное при открытии добычи. Предметы на розыгрыше и закрытые остаются.",
  },
  {
    // The client's lootUnderMouse (LootFrame.lua:168), off by default as InterfaceOptionsFrame.lua:322 has it.
    id: "lootUnderMouse", label: "Добыча под курсором", group: "Игра", kind: "boolean", fallback: false,
    // Only stock LootFrame reads it; the native fallback panel (ui/Npc.ts) keeps its own place.
    hint: "Оригинальное окно добычи открывается там, где стоит указатель мыши, а не у левого края экрана. Запасное окно клиента остаётся на своём месте.",
  },
  {
    id: "chatLogHeight", label: "Высота окна чата", group: "Чат", kind: "number", fallback: 190,
    min: 90, max: 420, step: 10, hint: "В пикселях. От неё считается всё, что стоит на нижнем краю.",
  },
  {
    id: "chatTimestamps", label: "Время у строк чата", group: "Чат", kind: "boolean", fallback: false,
  },
  {
    id: "combatDealt", label: "Бой: нанесённый урон", group: "Чат", kind: "boolean", fallback: true,
    hint: "Строки урона, который нанесли вы.",
  },
  {
    id: "combatTaken", label: "Бой: полученный урон", group: "Чат", kind: "boolean", fallback: true,
    hint: "Строки урона, который получили вы.",
  },
  {
    id: "combatCrit", label: "Бой: криты", group: "Чат", kind: "boolean", fallback: true,
  },
  {
    id: "combatAvoided", label: "Бой: промахи и уклонения", group: "Чат", kind: "boolean", fallback: true,
  },
  {
    id: "combatOther", label: "Бой: прочее", group: "Чат", kind: "boolean", fallback: true,
    hint: "Награды, чужие бои и всё остальное.",
  },
];

export type SettingValues = Record<string, boolean | number>;

export function settingDefinition(id: string): SettingDefinition | undefined {
  return SETTING_DEFINITIONS.find((definition) => definition.id === id);
}

/** Search the words players can see, rather than exposing the internal setting id as UI copy. */
export function settingMatchesQuery(definition: SettingDefinition, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  if (!needle) return true;
  return `${definition.label} ${definition.hint ?? ""}`.toLocaleLowerCase("ru-RU").includes(needle);
}

export function defaultSettings(): SettingValues {
  const values: SettingValues = {};
  for (const definition of SETTING_DEFINITIONS) values[definition.id] = definition.fallback;
  return values;
}

/** Clamps a number into its declared range and keeps a boolean a boolean. */
export function coerceSetting(definition: SettingDefinition, value: unknown): boolean | number {
  if (definition.kind === "boolean") return value === true;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return definition.fallback;
  const min = definition.min ?? Number.NEGATIVE_INFINITY;
  const max = definition.max ?? Number.POSITIVE_INFINITY;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function settingBoolean(values: SettingValues, id: string): boolean {
  const value = values[id];
  return typeof value === "boolean" ? value : settingDefinition(id)?.fallback === true;
}

export function settingNumber(values: SettingValues, id: string): number {
  const value = values[id];
  const definition = settingDefinition(id);
  if (typeof value === "number") return value;
  return typeof definition?.fallback === "number" ? definition.fallback : 0;
}

/**
 * Reads a stored blob.
 *
 * Anything unrecognised is dropped rather than kept: the slot is shared with whatever version of
 * this client wrote it last, and a setting that no longer exists must not survive as a value
 * nothing clamps.
 */
export function parseSettings(text: string): SettingValues | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const values = defaultSettings();
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const definition = settingDefinition(id);
    if (definition) values[id] = coerceSetting(definition, value);
  }
  return values;
}

/** Only what differs from the defaults, so the blob does not grow with every option added. */
export function serialiseSettings(values: SettingValues): string {
  const changed: SettingValues = {};
  for (const definition of SETTING_DEFINITIONS) {
    const value = values[definition.id];
    if (value !== undefined && value !== definition.fallback) changed[definition.id] = value;
  }
  return JSON.stringify(changed);
}
