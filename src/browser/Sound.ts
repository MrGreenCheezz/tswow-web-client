import type { SoundKit } from "../gateway/SoundMetadata.js";

export type { SoundKit };

/** What a sound is for, and therefore which slider it obeys. */
export type SoundChannel = "effects" | "music" | "ambience" | "interface";

/**
 * How long one ambience loop takes to give way to the next, in seconds.
 *
 * Two, because that is roughly how long it takes to walk out of a zone border's own width and
 * because the zone is looked at every two seconds anyway — a fade shorter than the poll would be
 * heard as a cut, and a much longer one would still be playing the forest in the middle of town.
 */
const AMBIENCE_FADE_SECONDS = 2;

export interface SoundListener {
  x: number;
  y: number;
  z: number;
  /** The direction the camera is facing, so a sound to the left arrives on the left. */
  orientation: number;
}

/**
 * The one thing the client had no way to make: a noise.
 *
 * Every piece of this was already here. Three opcodes carry a `SoundEntries` id and have been
 * parsed into an event since the packet slice; seven sound tables are vendored and their layouts
 * generated; the archives hold 19,786 `.wav` and 1,194 `.mp3` and not a single `.ogg`, so a browser
 * plays every one of them with no conversion anywhere. What was missing was the gateway route and
 * somebody listening — and this is the listening half.
 *
 * The `AudioContext` is not built until the first sound is asked for, and even then a browser will
 * hold it suspended until the page has been clicked. That is not a workaround: it is the rule every
 * browser enforces, and a context built at load time is a context that is already suspended when
 * the first sound arrives.
 */
export class SoundPlayer {
  readonly #baseUrl: string;
  #context: AudioContext | undefined;
  #master: GainNode | undefined;
  readonly #channels = new Map<SoundChannel, GainNode>();
  readonly #buffers = new Map<string, Promise<AudioBuffer | undefined>>();
  /** What is playing on the music channel, so a new track can replace it rather than join it. */
  #music: { source: AudioBufferSourceNode; kitId: number } | undefined;
  /** The music kit that is playing or still being fetched and decoded. */
  #musicWanted: number | undefined;
  /** Invalidates an older asynchronous music decode when a newer request or stop wins. */
  #musicGeneration = 0;
  /** The loop on the ambience channel and the gain it is faded in and out through. */
  #ambience: { source: AudioBufferSourceNode; gain: GainNode; kitId: number } | undefined;
  /**
   * The kit the ambience channel is on **or heading to**.
   *
   * Separate from `#ambience` because a kit has to be fetched and decoded before it can start, and
   * that takes longer than the two seconds between two looks at the zone. Without it, walking into
   * a forest asks for the forest three times before the first request lands.
   */
  #ambienceWanted: number | undefined;
  #volumes: Record<SoundChannel, number> = { effects: 1, music: 0.6, ambience: 0.7, interface: 1 };
  #masterVolume = 1;
  onStatus: ((message: string, error: boolean) => void) | undefined;

  constructor(gatewayWebSocketUrl: string) {
    const url = new URL(gatewayWebSocketUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : "http:";
    this.#baseUrl = url.origin;
  }

  /**
   * The context, built on the first sound and resumed on every one after that.
   *
   * Resuming costs nothing when it is already running, and the alternative is tracking the page's
   * gesture state in a second place that would only ever be an out-of-date copy of this one.
   */
  #audio(): AudioContext | undefined {
    if (!this.#context) {
      const Constructor = globalThis.AudioContext
        ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return undefined;
      this.#context = new Constructor();
      this.#master = this.#context.createGain();
      this.#master.gain.value = this.#masterVolume;
      this.#master.connect(this.#context.destination);
      for (const channel of ["effects", "music", "ambience", "interface"] as const) {
        const gain = this.#context.createGain();
        gain.gain.value = this.#volumes[channel];
        gain.connect(this.#master);
        this.#channels.set(channel, gain);
      }
    }
    if (this.#context.state === "suspended") void this.#context.resume();
    return this.#context;
  }

  /** 0 to 1. Zero is silence and not a pause: nothing stops, it is simply not heard. */
  setVolume(channel: SoundChannel | "master", value: number): void {
    const level = Math.max(0, Math.min(1, value));
    if (channel === "master") {
      this.#masterVolume = level;
      if (this.#master) this.#master.gain.value = level;
      return;
    }
    this.#volumes[channel] = level;
    const gain = this.#channels.get(channel);
    if (gain) gain.gain.value = level;
  }

  /**
   * Where the ears are.
   *
   * The listener stands at the camera and faces where the camera faces, not where the character
   * does: what the player hears has to match what the player sees, and in this client those two
   * part company every time the camera is dragged around.
   */
  setListener(at: SoundListener): void {
    const context = this.#context;
    if (!context) return;
    const listener = context.listener;
    const forwardX = Math.cos(at.orientation);
    const forwardY = Math.sin(at.orientation);
    // The old six-argument form is still the only one Safari implements, so both are attempted.
    if (listener.positionX) {
      listener.positionX.value = at.x;
      listener.positionY.value = at.y;
      listener.positionZ.value = at.z;
      listener.forwardX.value = forwardX;
      listener.forwardY.value = forwardY;
      listener.forwardZ.value = 0;
      listener.upX.value = 0;
      listener.upY.value = 0;
      listener.upZ.value = 1;
      return;
    }
    const legacy = listener as unknown as {
      setPosition?: (x: number, y: number, z: number) => void;
      setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
    };
    legacy.setPosition?.(at.x, at.y, at.z);
    legacy.setOrientation?.(forwardX, forwardY, 0, 0, 0, 1);
  }

  /**
   * One variant of a kit, decoded and cached.
   *
   * `fetch` rather than `new Audio(url)`, and this is not a preference: the gateway refuses a
   * request with no `Origin` header and a browser sends none for a media element's own load, so
   * an `<audio src>` at this route is a silent 403. The same trap `TextureBitmaps` documents.
   */
  #buffer(path: string): Promise<AudioBuffer | undefined> {
    const held = this.#buffers.get(path);
    if (held) return held;
    const pending = (async (): Promise<AudioBuffer | undefined> => {
      const context = this.#audio();
      if (!context) return undefined;
      try {
        const response = await fetch(`${this.#baseUrl}/sound?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
        return await context.decodeAudioData(await response.arrayBuffer());
      } catch (error) {
        // Remembered as a failure rather than retried. 124 of the paths `SoundEntries` names are
        // not in the archives at all, and a footstep that asks again every step would be a request
        // per step for the length of the session.
        this.onStatus?.(`звук ${path}: ${error instanceof Error ? error.message : String(error)}`, true);
        return undefined;
      }
    })();
    this.#buffers.set(path, pending);
    return pending;
  }

  /**
   * Plays one kit, at a place in the world or at the listener.
   *
   * The variant is chosen at random and evenly. `SoundEntries` carries a `Freq` weight per slot
   * and 25,703 of its 25,740 slots hold a 1, so a weighted draw would be arithmetic in aid of
   * thirty-seven rows.
   */
  play(kit: SoundKit, options: {
    channel?: SoundChannel;
    at?: { x: number; y: number; z: number };
    loop?: boolean;
    /** Optional lifecycle guard checked again after asynchronous decode completes. */
    guard?: () => boolean;
    /** Called only when this source reaches its natural end while it still owns its channel. */
    onEnded?: () => void;
    /** Called when the current request cannot fetch, decode or start its source. */
    onFailed?: () => void;
  } = {}): void {
    if (options.guard && !options.guard()) return;
    const channel = options.channel ?? (options.at ? "effects" : "interface");
    const context = this.#audio();
    if (!context || kit.files.length === 0) {
      options.onFailed?.();
      return;
    }
    const musicGeneration = channel === "music" ? ++this.#musicGeneration : undefined;
    if (musicGeneration !== undefined) this.#musicWanted = kit.id;
    const file = kit.files[Math.floor(Math.random() * kit.files.length)]!;
    void this.#buffer(file).then((buffer) => {
      if (options.guard && !options.guard()) {
        if (musicGeneration !== undefined && musicGeneration === this.#musicGeneration) {
          this.#musicGeneration++;
          this.#musicWanted = undefined;
        }
        return;
      }
      if (musicGeneration !== undefined && musicGeneration !== this.#musicGeneration) return;
      const failed = (): void => {
        if (musicGeneration !== undefined && musicGeneration === this.#musicGeneration) {
          this.#musicWanted = undefined;
        }
        options.onFailed?.();
      };
      if (!buffer || !this.#context) {
        failed();
        return;
      }
      const destination = this.#channels.get(channel);
      if (!destination) {
        failed();
        return;
      }
      const source = this.#context.createBufferSource();
      source.buffer = buffer;
      source.loop = options.loop ?? false;

      // The row's own volume, which runs from 0.01 to 1.0 across the table and is the difference
      // between a footstep and a thunderclap.
      const gain = this.#context.createGain();
      gain.gain.value = kit.volume;

      if (options.at) {
        // `MinDistance` and `DistanceCutoff` are `refDistance` and `maxDistance` without
        // conversion: both are already yards, which is the unit the listener is placed in.
        const panner = this.#context.createPanner();
        panner.panningModel = "HRTF";
        panner.distanceModel = "linear";
        panner.refDistance = Math.max(1, kit.minDistance);
        panner.maxDistance = Math.max(panner.refDistance + 1, kit.maxDistance);
        if (panner.positionX) {
          panner.positionX.value = options.at.x;
          panner.positionY.value = options.at.y;
          panner.positionZ.value = options.at.z;
        } else {
          (panner as unknown as { setPosition(x: number, y: number, z: number): void })
            .setPosition(options.at.x, options.at.y, options.at.z);
        }
        source.connect(gain).connect(panner).connect(destination);
      } else {
        source.connect(gain).connect(destination);
      }

      if (channel === "music") {
        const previous = this.#music;
        this.#music = { source, kitId: kit.id };
        // Install the new owner first. `stop()` may dispatch `ended` synchronously in a test
        // implementation, and the old listener must then see that it no longer owns the channel.
        previous?.source.stop();
        source.addEventListener("ended", () => {
          if (this.#music?.source !== source) return;
          this.#music = undefined;
          // A newer request can be decoding while this older source is still audible. Its natural
          // end no longer ends the programme and must not clear the newer wanted kit or run the
          // older scheduler callback — especially when both requests use the same kit id.
          if (musicGeneration !== this.#musicGeneration) return;
          if (this.#musicWanted === kit.id) this.#musicWanted = undefined;
          options.onEnded?.();
        });
      }
      try {
        source.start();
      } catch {
        if (this.#music?.source === source) this.#music = undefined;
        failed();
      }
    });
  }

  /** Which kit the music channel is on or heading to, so a slow decode is not requested twice. */
  get playingMusic(): number | undefined {
    return this.#musicWanted;
  }

  stopMusic(): void {
    this.#musicGeneration++;
    this.#musicWanted = undefined;
    const playing = this.#music;
    this.#music = undefined;
    playing?.source.stop();
  }

  /**
   * The wind, the crickets and the surf: one looping kit on the ambience channel, crossfaded.
   *
   * Crossfaded and not swapped because a zone border is a line on a map and not a door: cutting
   * one loop off to start another is a click at the exact moment the player is looking at the
   * seam. Both ramps run over the same window, so the two overlap rather than leaving a gap.
   */
  playAmbience(kit: SoundKit, fadeSeconds = AMBIENCE_FADE_SECONDS): void {
    const context = this.#audio();
    if (!context || kit.files.length === 0 || this.#ambienceWanted === kit.id) return;
    this.#ambienceWanted = kit.id;
    const file = kit.files[Math.floor(Math.random() * kit.files.length)]!;
    void this.#buffer(file).then((buffer) => {
      // The area can change again while a loop is being fetched, and the answer to «which zone am
      // I in» is the last one asked for, not the first one that finished loading.
      if (this.#ambienceWanted !== kit.id) return;
      const destination = this.#channels.get("ambience");
      if (!buffer || !this.#context || !destination) {
        // A file that would not decode is not this zone's last word. `playingAmbience` is what the
        // zone walk compares against and what this method refuses a repeat on, so leaving it set
        // to a loop that is not running is the zone staying silent until the player leaves it and
        // comes back. Cleared instead, and the walk two seconds from now asks again — and asks for
        // another of the kit's files, since the variant is drawn per call. It costs nothing when
        // the failure is permanent: `#buffer` holds the failed decode, so the retry is a resolved
        // promise rather than a request, and all 412 `SoundAmbience` slots name a file that is in
        // the archives, so this is a transport failure rather than a missing sound.
        this.#ambienceWanted = undefined;
        return;
      }
      const gain = this.#context.createGain();
      const now = this.#context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(kit.volume, now + fadeSeconds);
      const source = this.#context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain).connect(destination);
      source.start();
      this.#fadeOutAmbience(fadeSeconds);
      this.#ambience = { source, gain, kitId: kit.id };
    });
  }

  /** Which kit the ambience channel is on or fading into, so an unchanged zone is left alone. */
  get playingAmbience(): number | undefined {
    return this.#ambienceWanted;
  }

  stopAmbience(fadeSeconds = AMBIENCE_FADE_SECONDS): void {
    this.#ambienceWanted = undefined;
    this.#fadeOutAmbience(fadeSeconds);
  }

  /** Rides the current loop down to nothing and stops it at the bottom of the ramp. */
  #fadeOutAmbience(fadeSeconds: number): void {
    const playing = this.#ambience;
    this.#ambience = undefined;
    if (!playing || !this.#context) return;
    const now = this.#context.currentTime;
    // From wherever the ramp had got to: a zone crossed twice in four seconds would otherwise fade
    // out from full volume having never reached it, which is a jump up before the fade down.
    playing.gain.gain.cancelScheduledValues(now);
    playing.gain.gain.setValueAtTime(playing.gain.gain.value, now);
    playing.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
    playing.source.stop(now + fadeSeconds);
  }

  /** Leaving a world: the buffers belong to a context that is about to be thrown away. */
  close(): void {
    this.stopMusic();
    // Not faded: the context itself is closing, and a ramp on a node that is about to be collected
    // is a promise to a listener who has already left.
    this.#ambience = undefined;
    this.#ambienceWanted = undefined;
    this.#buffers.clear();
    this.#channels.clear();
    this.#master = undefined;
    void this.#context?.close();
    this.#context = undefined;
  }
}
