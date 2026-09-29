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

/**
 * How many decoded variants the buffer cache holds. Generous on purpose: eviction only
 * refetches and redecodes, so the cost of guessing low is paid in gateway traffic, while the
 * cost of no bound at all is decoded PCM accumulating for the life of a long session.
 */
const BUFFER_CACHE_LIMIT = 96;

export interface SoundListener {
  x: number;
  y: number;
  z: number;
  /** The direction the camera is facing, so a sound to the left arrives on the left. */
  orientation: number;
}

/** One named weather loop (`SoundPlayer.setAmbientLayer`): its nodes and where it is heading. */
interface AmbientLayer {
  readonly kitId: number;
  readonly volume: number;
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  /** Undefined while the file is still being fetched and decoded. */
  source?: AudioBufferSourceNode;
  level: number;
  lowpass: number;
  readonly ramp: number;
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
  /**
   * Paths whose fetch or decode failed, pinned against eviction below: 124 of the paths the
   * tables name are not in the archives at all, and re-asking for a missing footstep every
   * time it falls out of the cache would be a request per step for the length of the session.
   */
  readonly #failedBufferPaths = new Set<string>();
  /** What is playing on the music channel, so a new track can replace it rather than join it. */
  #music: { source: AudioBufferSourceNode; kitId: number } | undefined;
  /** The music kit that is playing or still being fetched and decoded. */
  #musicWanted: number | undefined;
  /** Invalidates an older asynchronous music decode when a newer request or stop wins. */
  #musicGeneration = 0;
  /** Bumped by `close()`: an in-flight buffer fetch from the old world resolves quietly. */
  #bufferGeneration = 0;
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
  /** Keyed weather loops beside the zone loop (`setAmbientLayer`), on the ambience channel. */
  readonly #layers = new Map<string, AmbientLayer>();
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
   *
   * The cache is bounded (`BUFFER_CACHE_LIMIT`): a long session walks through dozens of zones
   * and hundreds of kits, and decoded PCM is megabytes per minute of music. Only successes are
   * evicted, oldest first — failures stay pinned (see `#failedBufferPaths`).
   */
  #buffer(path: string): Promise<AudioBuffer | undefined> {
    const held = this.#buffers.get(path);
    if (held) return held;
    const pending = (async (): Promise<AudioBuffer | undefined> => {
      const context = this.#audio();
      if (!context) return undefined;
      const generation = this.#bufferGeneration;
      // The player is per world and `close()` clears both the cache and the failure pins: a
      // fetch that outlives its world must resolve quietly instead of pinning a fresh failure
      // into the next session, reporting status to a dead player, or decoding into a closing
      // context (which only throws).
      const retired = (): boolean => generation !== this.#bufferGeneration || this.#context !== context;
      try {
        const response = await fetch(`${this.#baseUrl}/sound?path=${encodeURIComponent(path)}`);
        if (!response.ok) throw new Error(`sound gateway returned ${response.status}`);
        const bytes = await response.arrayBuffer();
        if (retired() || context.state === "closed") return undefined;
        return await context.decodeAudioData(bytes);
      } catch (error) {
        if (retired()) return undefined;
        // Remembered as a failure rather than retried. 124 of the paths `SoundEntries` names are
        // not in the archives at all, and a footstep that asks again every step would be a request
        // per step for the length of the session.
        this.#failedBufferPaths.add(path);
        this.onStatus?.(`звук ${path}: ${error instanceof Error ? error.message : String(error)}`, true);
        return undefined;
      }
    })();
    this.#buffers.set(path, pending);
    this.#evictBuffers();
    return pending;
  }

  /** Drops the oldest decoded successes past the cache bound; failures stay pinned. */
  #evictBuffers(): void {
    while (this.#buffers.size > BUFFER_CACHE_LIMIT) {
      let evicted = false;
      for (const key of this.#buffers.keys()) {
        if (this.#failedBufferPaths.has(key)) continue;
        this.#buffers.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) return;
    }
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
      // Nodes this request owns, released below when a one-shot ends.
      const ownNodes: AudioNode[] = [];

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
        ownNodes.push(panner);
      } else {
        source.connect(gain).connect(destination);
      }
      ownNodes.push(source, gain);

      // One-shot effects own their nodes only for their duration: without an explicit
      // disconnect the graph holds source, gain and panner until GC notices the ended
      // source (or longer in some browsers), which is pure GC pressure in a fight with
      // dozens of swings. Music and loops manage their own lifecycle (stop/replace).
      if (channel !== "music" && !source.loop) {
        source.addEventListener("ended", () => {
          for (const node of ownNodes) {
            try {
              node.disconnect();
            } catch {
              // Already disconnected or torn down with the context.
            }
          }
        }, { once: true });
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

  /**
   * A named loop on the ambience channel beside the zone's own (rain, wind), held at `level` 0..1
   * of the kit's volume and eased there over `rampSeconds`. A different kit in the same slot
   * crossfades; level 0 fades the slot out and stops it. `lowpassHz` muffles it (indoors).
   *
   * Called a few times a second by WeatherSound.ts, so it only ever retargets: the loop is
   * fetched once, starts at a random point of its file (two storms never begin on the same
   * raindrop) and keeps running until its slot is emptied.
   */
  setAmbientLayer(slot: string, kit: SoundKit | undefined, level: number,
    options: { rampSeconds?: number; lowpassHz?: number } = {}): void {
    const target = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
    const ramp = Math.max(0.05, options.rampSeconds ?? 1);
    const lowpass = Math.max(200, Math.min(20000, options.lowpassHz ?? 20000));
    const existing = this.#layers.get(slot);
    if (existing && kit && existing.kitId === kit.id) {
      if (target <= 0) {
        this.#retireLayer(slot, existing, ramp);
        return;
      }
      existing.level = target;
      existing.lowpass = lowpass;
      if (existing.source && this.#context) {
        const now = this.#context.currentTime;
        existing.gain.gain.setTargetAtTime(kit.volume * target, now, ramp / 3);
        existing.filter.frequency.setTargetAtTime(lowpass, now, ramp / 3);
      }
      return;
    }
    if (existing) this.#retireLayer(slot, existing, ramp);
    if (!kit || target <= 0 || kit.files.length === 0) return;
    const context = this.#audio();
    const destination = this.#channels.get("ambience");
    if (!context || !destination) return;
    const gain = context.createGain();
    gain.gain.value = 0;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = lowpass;
    filter.connect(gain).connect(destination);
    const layer: AmbientLayer = { kitId: kit.id, volume: kit.volume, gain, filter, level: target, lowpass, ramp };
    this.#layers.set(slot, layer);
    const file = kit.files[Math.floor(Math.random() * kit.files.length)]!;
    void this.#buffer(file).then((buffer) => {
      if (this.#layers.get(slot) !== layer || !buffer || !this.#context || this.#context !== context) {
        if (this.#layers.get(slot) === layer) this.#layers.delete(slot);
        for (const node of [filter, gain]) {
          try { node.disconnect(); } catch { /* already gone with the context */ }
        }
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(filter);
      const now = context.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.setTargetAtTime(layer.volume * layer.level, now, layer.ramp / 3);
      filter.frequency.setValueAtTime(layer.lowpass, now);
      source.start(now, Math.random() * Math.max(0, buffer.duration - 0.05));
      layer.source = source;
    });
  }

  /** Which kit a named layer is on or heading to (diagnostics and tests). */
  ambientLayer(slot: string): { kitId: number; level: number; playing: boolean } | undefined {
    const layer = this.#layers.get(slot);
    return layer ? { kitId: layer.kitId, level: layer.level, playing: layer.source !== undefined } : undefined;
  }

  /** Fades every named layer out (leaving a world, or the setting switched off). */
  stopAmbientLayers(fadeSeconds = 1): void {
    for (const [slot, layer] of [...this.#layers]) this.#retireLayer(slot, layer, fadeSeconds);
  }

  #retireLayer(slot: string, layer: AmbientLayer, fadeSeconds: number): void {
    if (this.#layers.get(slot) === layer) this.#layers.delete(slot);
    layer.level = 0;
    const context = this.#context;
    if (!layer.source || !context) return;
    const now = context.currentTime;
    layer.gain.gain.cancelScheduledValues(now);
    layer.gain.gain.setValueAtTime(layer.gain.gain.value, now);
    layer.gain.gain.linearRampToValueAtTime(0, now + fadeSeconds);
    const source = layer.source;
    source.addEventListener("ended", () => {
      for (const node of [source, layer.filter, layer.gain]) {
        try { node.disconnect(); } catch { /* already gone with the context */ }
      }
    }, { once: true });
    source.stop(now + fadeSeconds);
  }

  /**
   * One sound on the ambience channel that is not at a place in the world — a thunderclap from a
   * bolt five hundred yards off — heard `delaySeconds` after this call (counted from the call, so a
   * first decode eats into the delay rather than adding to it), at `level` of the kit's volume,
   * muffled above `lowpassHz` and panned -1 (left) … 1 (right).
   */
  playAmbientShot(kit: SoundKit, options: {
    delaySeconds?: number; level?: number; lowpassHz?: number; pan?: number; file?: string;
  } = {}): void {
    const context = this.#audio();
    const destination = this.#channels.get("ambience");
    if (!context || !destination || kit.files.length === 0) return;
    const file = options.file ?? kit.files[Math.floor(Math.random() * kit.files.length)]!;
    const at = context.currentTime + Math.max(0, options.delaySeconds ?? 0);
    const level = Math.max(0, Math.min(1, options.level ?? 1));
    if (level <= 0) return;
    void this.#buffer(file).then((buffer) => {
      if (!buffer || this.#context !== context || context.state === "closed") return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = Math.max(200, Math.min(20000, options.lowpassHz ?? 20000));
      const gain = context.createGain();
      gain.gain.value = kit.volume * level;
      const nodes: AudioNode[] = [source, filter, gain];
      let tail: AudioNode = source.connect(filter).connect(gain);
      if (typeof context.createStereoPanner === "function") {
        const panner = context.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, options.pan ?? 0));
        tail = tail.connect(panner);
        nodes.push(panner);
      }
      tail.connect(destination);
      source.addEventListener("ended", () => {
        for (const node of nodes) {
          try { node.disconnect(); } catch { /* already gone with the context */ }
        }
      }, { once: true });
      source.start(Math.max(context.currentTime, at));
    });
  }

  /** Leaving a world: the buffers belong to a context that is about to be thrown away. */
  close(): void {
    this.stopMusic();
    // Not faded: the context itself is closing, and a ramp on a node that is about to be collected
    // is a promise to a listener who has already left.
    this.#ambience = undefined;
    this.#ambienceWanted = undefined;
    this.#layers.clear();
    this.#bufferGeneration++;
    this.#buffers.clear();
    this.#failedBufferPaths.clear();
    this.#channels.clear();
    this.#master = undefined;
    void this.#context?.close();
    this.#context = undefined;
  }
}
