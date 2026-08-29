import * as THREE from "three";

/** One stable subsystem/object identity within a single accounting pass. */
export type ResourceOwnerId = object | string | number | symbol;

/** The small surface retained-resource owners need from the central ledger. */
export interface RetainedResourceVisitor {
  referenceCpu(ownerId: ResourceOwnerId, view: ArrayBufferView): void;
  referenceGpuBuffer(
    ownerId: ResourceOwnerId,
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  ): void;
  referenceGpuTexture(ownerId: ResourceOwnerId, texture: THREE.Texture): void;
  referenceGpuRenderTarget(ownerId: ResourceOwnerId, target: THREE.RenderTarget): void;
  referenceUnsupported(ownerId: ResourceOwnerId, resource: object): void;
}

export interface CpuResourceAccountingSnapshot {
  /** Exact retained allocation size: each backing ArrayBuffer is included once at full size. */
  readonly uniqueRetainedBytes: number;
  readonly uniqueResources: number;
  /** Distinct owners participating in this section. */
  readonly owners: number;
  /** Distinct owner-resource pairs; repeated visits by one owner are idempotent. */
  readonly references: number;
  readonly sharedResources: number;
}

export interface GpuBufferAccountingSnapshot {
  /** Logical upload size from retained Three.js buffer arrays, not measured GPU residency. */
  readonly estimatedGpuBufferBytes: number;
  readonly uniqueResources: number;
  readonly owners: number;
  readonly references: number;
  readonly sharedResources: number;
}

export interface GpuTextureAccountingSnapshot {
  /** Known logical allocations only; unknown layouts are counted separately, never as zero bytes. */
  readonly estimatedLogicalTextureBytes: number;
  readonly knownByteResources: number;
  readonly unknownByteResources: number;
  readonly uniqueResources: number;
  readonly owners: number;
  readonly references: number;
  readonly sharedResources: number;
}

export interface GpuRenderbufferAccountingSnapshot {
  /** Known logical allocations only; driver-dependent topology remains explicitly unknown. */
  readonly estimatedLogicalRenderbufferBytes: number;
  readonly knownByteResources: number;
  readonly unknownByteResources: number;
  readonly uniqueResources: number;
  readonly owners: number;
  readonly references: number;
  readonly sharedResources: number;
}

export interface GpuRenderTargetTopologyAccountingSnapshot {
  /** Distinct render targets whose MSAA auxiliary allocation topology needs renderer capability state. */
  readonly unknownTopologyResources: number;
  readonly uniqueResources: number;
  readonly owners: number;
  readonly references: number;
  readonly sharedResources: number;
}

export interface UnsupportedResourceAccountingSnapshot {
  readonly uniqueResources: number;
  readonly owners: number;
  readonly references: number;
  readonly sharedResources: number;
}

export interface ResourceAccountingSnapshot {
  readonly cpu: Readonly<CpuResourceAccountingSnapshot>;
  readonly gpuBuffers: Readonly<GpuBufferAccountingSnapshot>;
  readonly gpuTextures: Readonly<GpuTextureAccountingSnapshot>;
  readonly gpuRenderbuffers: Readonly<GpuRenderbufferAccountingSnapshot>;
  readonly gpuRenderTargetTopology: Readonly<GpuRenderTargetTopologyAccountingSnapshot>;
  readonly unsupported: Readonly<UnsupportedResourceAccountingSnapshot>;
  readonly coverage: Readonly<{
    /** Deliberately false until every gap named below has an identity and size contract. */
    complete: false;
    gaps: readonly string[];
  }>;
}

/** Known omissions after the ordinary logical texture-allocation slice. */
export const RESOURCE_ACCOUNTING_GAPS = Object.freeze([
  "multisampled, multiview, external, and invalid mixed render-target attachment topologies without renderer capability state",
  "renderer-generated morph-target DataArrayTextures whose allocation depends on renderer capabilities",
  "browser-owned decoded image, canvas, and bitmap CPU storage",
  "standalone cube, video, HTML/external, compressed-array, and other unsupported special texture layouts",
  "opaque JavaScript arrays and engine-owned object overhead",
] as const);

interface ResourceEntry {
  bytes: number | undefined;
  conflictingKnownBytes: boolean;
  unknownBytes: boolean;
  readonly owners: Set<ResourceOwnerId>;
}

type ResourceEntries = Map<object, ResourceEntry>;

function identitySummary(entries: ResourceEntries): {
  uniqueResources: number;
  owners: number;
  references: number;
  sharedResources: number;
} {
  const owners = new Set<ResourceOwnerId>();
  let references = 0;
  let sharedResources = 0;
  for (const entry of entries.values()) {
    references += entry.owners.size;
    if (entry.owners.size > 1) sharedResources++;
    for (const owner of entry.owners) owners.add(owner);
  }
  return {
    uniqueResources: entries.size,
    owners: owners.size,
    references,
    sharedResources,
  };
}

function totalKnownBytes(entries: ResourceEntries): number {
  let total = 0;
  for (const entry of entries.values()) {
    if (entry.bytes !== undefined) total += entry.bytes;
  }
  return total;
}

function textureByteKnowledge(entries: ResourceEntries): {
  knownByteResources: number;
  unknownByteResources: number;
} {
  let knownByteResources = 0;
  let unknownByteResources = 0;
  for (const entry of entries.values()) {
    if (entry.bytes === undefined) unknownByteResources++;
    else knownByteResources++;
  }
  return { knownByteResources, unknownByteResources };
}

/** Defensive immutable copy used both by the live ledger and by render telemetry capture. */
export function immutableResourceAccountingSnapshot(
  snapshot: Readonly<ResourceAccountingSnapshot>,
): Readonly<ResourceAccountingSnapshot> {
  const renderbuffers = snapshot.gpuRenderbuffers;
  const renderTargetTopology = snapshot.gpuRenderTargetTopology;
  return Object.freeze({
    cpu: Object.freeze({ ...snapshot.cpu }),
    gpuBuffers: Object.freeze({ ...snapshot.gpuBuffers }),
    gpuTextures: Object.freeze({ ...snapshot.gpuTextures }),
    ...(renderbuffers ? { gpuRenderbuffers: Object.freeze({ ...renderbuffers }) } : {}),
    ...(renderTargetTopology
      ? { gpuRenderTargetTopology: Object.freeze({ ...renderTargetTopology }) } : {}),
    unsupported: Object.freeze({ ...snapshot.unsupported }),
    coverage: Object.freeze({
      complete: false as const,
      gaps: Object.freeze([...snapshot.coverage.gaps]),
    }),
  }) as Readonly<ResourceAccountingSnapshot>;
}

/**
 * One identity ledger for one render telemetry capture.
 *
 * CPU and GPU identity intentionally differ. Multiple typed views retain one full backing buffer,
 * while two Three.js BufferAttribute objects can upload that same CPU buffer twice. Interleaved
 * attributes are the exception on the GPU side: their shared InterleavedBuffer is the allocation.
 */
export class ResourceAccountingLedger implements RetainedResourceVisitor {
  readonly #cpu = new Map<object, ResourceEntry>();
  readonly #gpuBuffers = new Map<object, ResourceEntry>();
  readonly #gpuTextures = new Map<object, ResourceEntry>();
  readonly #gpuRenderbuffers = new Map<object, ResourceEntry>();
  readonly #gpuRenderTargetTopology = new Map<object, ResourceEntry>();
  readonly #gpuTextureIdentities = new Map<object, Map<string, object>>();
  readonly #renderbufferIdentities = new Map<object, Map<string, object>>();
  readonly #unsupported = new Map<object, ResourceEntry>();

  referenceCpu(ownerId: ResourceOwnerId, view: ArrayBufferView): void {
    this.#reference(this.#cpu, ownerId, view.buffer, view.buffer.byteLength);
  }

  referenceGpuBuffer(
    ownerId: ResourceOwnerId,
    attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  ): void {
    const interleaved = "isInterleavedBufferAttribute" in attribute
      && attribute.isInterleavedBufferAttribute === true;
    const identity = interleaved ? attribute.data : attribute;
    const array = identity.array;
    if (!ArrayBuffer.isView(array)) {
      this.referenceUnsupported(ownerId, identity);
      return;
    }
    this.referenceCpu(ownerId, array);
    this.#reference(this.#gpuBuffers, ownerId, identity, array.byteLength);
  }

  /**
   * Registers retained upload inputs and a logical GPU allocation.
   *
   * This intentionally includes version-0 textures: it describes retained/intended resources,
   * not renderer-properties residency. Ordinary DOM-backed dimensions are only a source-defined
   * logical allocation estimate; the browser's decoded CPU storage remains explicitly unsupported.
   */
  referenceGpuTexture(ownerId: ResourceOwnerId, texture: THREE.Texture): void {
    visitTextureCpuInputs(this, ownerId, texture);
    const identity = usesTextureObjectIdentity(texture) ? texture : this.#textureIdentity(texture);
    const target = renderTargetBackReference(texture);
    if (target && target.depthTexture !== texture && !target.textures.includes(texture)) {
      // A cloned render-target texture keeps the back-reference, but WebGLTextures only uploads
      // attachments that are actually present in target.textures/depthTexture. Keep its identity
      // explicit and unknown instead of mistaking the source dimensions for a GPU allocation.
      this.#reference(this.#gpuTextures, ownerId, identity, undefined);
      this.referenceUnsupported(ownerId, texture);
      return;
    }
    let bytes: number | undefined;
    if (target?.depthTexture === texture) {
      bytes = logicalRenderTargetDepthTextureBytes(target, texture);
    } else if (target?.textures.includes(texture)) {
      bytes = logicalRenderTargetColorTextureBytes(target, texture);
    } else {
      bytes = knownLogicalTextureBytes(texture);
    }
    this.#reference(this.#gpuTextures, ownerId, identity, bytes);
  }

  /** Registers color/depth textures and synthetic identities for non-texture renderbuffers. */
  referenceGpuRenderTarget(ownerId: ResourceOwnerId, target: THREE.RenderTarget): void {
    const value = target as RenderTargetLike;
    const topologyUnknown = renderTargetTopologyUnknown(value);
    for (const texture of target.textures) {
      visitTextureCpuInputs(this, ownerId, texture);
      const identity = usesTextureObjectIdentity(texture)
        ? texture
        : this.#textureIdentity(texture);
      this.#reference(
        this.#gpuTextures,
        ownerId,
        identity,
        topologyUnknown ? undefined : logicalRenderTargetColorTextureBytes(value, texture),
        !usesTextureObjectIdentity(texture),
      );
    }

    if (target.samples > 0) {
      if (target.depthBuffer && target.depthTexture) {
        visitTextureCpuInputs(this, ownerId, target.depthTexture);
        this.#reference(
          this.#gpuTextures,
          ownerId,
          target.depthTexture,
          topologyUnknown
            ? undefined
            : logicalRenderTargetDepthTextureBytes(value, target.depthTexture),
        );
      }
      // Whether WEBGL_multisampled_render_to_texture is used changes both the number and kind of
      // auxiliary allocations. One topology marker represents that uncertainty; it is not an
      // invented allocation and requested samples are deliberately never multiplied into guessed bytes.
      this.#reference(
        this.#gpuRenderTargetTopology,
        ownerId,
        target,
        undefined,
      );
      return;
    }
    if (!target.depthBuffer) return;
    if (target.depthTexture) {
      visitTextureCpuInputs(this, ownerId, target.depthTexture);
      this.#reference(
        this.#gpuTextures,
        ownerId,
        target.depthTexture,
        topologyUnknown ? undefined : logicalRenderTargetDepthTextureBytes(value, target.depthTexture),
      );
      return;
    }

    const faces = value.isWebGLCubeRenderTarget === true ? 6 : 1;
    const bytes = topologyUnknown ? undefined : logicalDepthRenderbufferBytes(target);
    for (let face = 0; face < faces; face++) {
      this.#reference(
        this.#gpuRenderbuffers,
        ownerId,
        this.#renderbufferIdentity(target, `depth-${face}`),
        bytes,
      );
    }
  }

  referenceUnsupported(ownerId: ResourceOwnerId, resource: object): void {
    this.#reference(this.#unsupported, ownerId, resource, 0);
  }

  snapshot(): Readonly<ResourceAccountingSnapshot> {
    return immutableResourceAccountingSnapshot({
      cpu: {
        uniqueRetainedBytes: totalKnownBytes(this.#cpu),
        ...identitySummary(this.#cpu),
      },
      gpuBuffers: {
        estimatedGpuBufferBytes: totalKnownBytes(this.#gpuBuffers),
        ...identitySummary(this.#gpuBuffers),
      },
      gpuTextures: {
        estimatedLogicalTextureBytes: totalKnownBytes(this.#gpuTextures),
        ...textureByteKnowledge(this.#gpuTextures),
        ...identitySummary(this.#gpuTextures),
      },
      gpuRenderbuffers: {
        estimatedLogicalRenderbufferBytes: totalKnownBytes(this.#gpuRenderbuffers),
        ...textureByteKnowledge(this.#gpuRenderbuffers),
        ...identitySummary(this.#gpuRenderbuffers),
      },
      gpuRenderTargetTopology: {
        unknownTopologyResources: this.#gpuRenderTargetTopology.size,
        ...identitySummary(this.#gpuRenderTargetTopology),
      },
      unsupported: identitySummary(this.#unsupported),
      coverage: {
        complete: false,
        gaps: RESOURCE_ACCOUNTING_GAPS,
      },
    });
  }

  #textureIdentity(texture: THREE.Texture): object {
    const source = texture.source;
    let identities = this.#gpuTextureIdentities.get(source);
    if (!identities) {
      identities = new Map<string, object>();
      this.#gpuTextureIdentities.set(source, identities);
    }
    const wrapR = (texture as THREE.Texture & { wrapR?: number }).wrapR || 0;
    const key = [
      texture.wrapS,
      texture.wrapT,
      wrapR,
      texture.magFilter,
      texture.minFilter,
      texture.anisotropy,
      texture.internalFormat,
      texture.format,
      texture.type,
      texture.generateMipmaps,
      texture.premultiplyAlpha,
      texture.flipY,
      texture.unpackAlignment,
      texture.colorSpace,
    ].join();
    let identity = identities.get(key);
    if (!identity) {
      identity = {};
      identities.set(key, identity);
    }
    return identity;
  }

  #renderbufferIdentity(target: THREE.RenderTarget, slot: string): object {
    let identities = this.#renderbufferIdentities.get(target);
    if (!identities) {
      identities = new Map<string, object>();
      this.#renderbufferIdentities.set(target, identities);
    }
    let identity = identities.get(slot);
    if (!identity) {
      identity = {};
      identities.set(slot, identity);
    }
    return identity;
  }

  #reference(
    entries: ResourceEntries,
    ownerId: ResourceOwnerId,
    identity: object,
    bytes: number | undefined,
    unknownBytes = false,
  ): void {
    let entry = entries.get(identity);
    if (!entry) {
      entry = {
        bytes: unknownBytes ? undefined : bytes,
        conflictingKnownBytes: false,
        unknownBytes,
        owners: new Set<ResourceOwnerId>(),
      };
      entries.set(identity, entry);
    } else if (unknownBytes) {
      entry.bytes = undefined;
      entry.unknownBytes = true;
    } else if (!entry.unknownBytes && !entry.conflictingKnownBytes
      && entry.bytes === undefined && bytes !== undefined) {
      entry.bytes = bytes;
    } else if (!entry.unknownBytes && !entry.conflictingKnownBytes && entry.bytes !== undefined
      && bytes !== undefined && entry.bytes !== bytes) {
      entry.bytes = undefined;
      entry.conflictingKnownBytes = true;
    }
    entry.owners.add(ownerId);
  }
}

type TextureLike = THREE.Texture & Record<string, unknown>;
type TextureImage = { readonly data?: unknown; readonly width?: unknown; readonly height?: unknown; readonly depth?: unknown };
type RenderTargetLike = THREE.RenderTarget & {
  readonly isWebGLCubeRenderTarget?: boolean;
  readonly isWebGLArrayRenderTarget?: boolean;
  readonly isWebGL3DRenderTarget?: boolean;
};

function renderTargetBackReference(texture: THREE.Texture): RenderTargetLike | undefined {
  const target = texture.renderTarget;
  return typeof target === "object" && target !== null
    && (target as { readonly isRenderTarget?: unknown }).isRenderTarget === true
    ? target as RenderTargetLike
    : undefined;
}

function isUnknownTextureLayout(texture: THREE.Texture): boolean {
  const value = texture as TextureLike;
  return value.isCubeTexture === true
    || value.isCompressedCubeTexture === true
    || value.isVideoTexture === true
    || value.isVideoFrameTexture === true
    || value.isHTMLTexture === true
    || value.isExternalTexture === true
    || value.isCubeDepthTexture === true
    || value.isFramebufferTexture === true
    || value.isCompressedArrayTexture === true;
}

function usesTextureObjectIdentity(texture: THREE.Texture): boolean {
  const value = texture as TextureLike;
  return texture.renderTarget !== null
    || value.isRenderTargetTexture === true
    || value.isExternalTexture === true
    || "sourceTexture" in value;
}

function visitTextureCpuInputs(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  texture: THREE.Texture,
): void {
  visitTextureCpuValue(visitor, ownerId, texture.image);
  for (const mipmap of texture.mipmaps) visitTextureCpuValue(visitor, ownerId, mipmap);
}

function visitTextureCpuValue(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  value: unknown,
): void {
  if (ArrayBuffer.isView(value)) {
    visitor.referenceCpu(ownerId, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitTextureCpuValue(visitor, ownerId, item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const data = (value as { data?: unknown }).data;
  if (data !== undefined) {
    visitTextureCpuValue(visitor, ownerId, data);
    return;
  }
  const browserSource = value as {
    readonly getContext?: unknown;
    readonly naturalWidth?: unknown;
    readonly videoWidth?: unknown;
    readonly close?: unknown;
    readonly src?: unknown;
  };
  if (typeof browserSource.getContext === "function"
    || typeof browserSource.naturalWidth === "number"
    || typeof browserSource.videoWidth === "number"
    || typeof browserSource.close === "function"
    || typeof browserSource.src === "string") {
    visitor.referenceUnsupported(ownerId, value);
  }
}

function positiveDimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function textureDimensions(value: unknown): { width: number; height: number; depth?: number } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const image = value as TextureImage & { naturalWidth?: unknown; naturalHeight?: unknown };
  const width = positiveDimension(image.naturalWidth) ?? positiveDimension(image.width);
  const height = positiveDimension(image.naturalHeight) ?? positiveDimension(image.height);
  if (width === undefined || height === undefined) return undefined;
  const depth = positiveDimension(image.depth);
  return depth === undefined ? { width, height } : { width, height, depth };
}

function byteLength(width: number, height: number, texture: THREE.Texture): number | undefined {
  try {
    const bytes = THREE.TextureUtils.getByteLength(width, height, texture.format, texture.type);
    return Number.isFinite(bytes) && Number.isInteger(bytes) && bytes >= 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function safeAllocationProduct(...values: number[]): number | undefined {
  let total = 1;
  for (const value of values) total *= value;
  return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
}

function renderTargetTopologyUnknown(target: RenderTargetLike): boolean {
  if (target.multiview || target.useArrayDepthTexture) return true;
  const hasManualMipmaps = target.textures.some((texture) => texture.mipmaps.length > 0);
  if (target.isWebGLCubeRenderTarget === true
    && (target.textures.length !== 1 || hasManualMipmaps)) return true;
  if (target.textures.length > 1 && hasManualMipmaps) return true;
  if (target.depth > 1
    && target.isWebGLArrayRenderTarget !== true
    && target.isWebGL3DRenderTarget !== true) return true;
  return false;
}

function logicalRenderTargetColorTextureBytes(
  target: RenderTargetLike,
  texture: THREE.Texture,
): number | undefined {
  if (renderTargetTopologyUnknown(target)
    || texture.internalFormat !== null
    || texture.normalized === true
    || isUnknownRenderTargetColorLayout(texture)) return undefined;
  const width = positiveDimension(target.width);
  const height = positiveDimension(target.height);
  if (width === undefined || height === undefined) return undefined;

  const isCube = target.isWebGLCubeRenderTarget === true;
  const isArray = target.isWebGLArrayRenderTarget === true;
  const is3d = target.isWebGL3DRenderTarget === true;
  const depth = isArray || is3d ? positiveDimension(target.depth) : 1;
  if (depth === undefined) return undefined;

  // MRT setup only allocates level zero from each attachment. A single-target manual mip list,
  // however, creates one framebuffer/allocation per declared level. Generated mipmaps allocate
  // the complete chain in either case.
  const levels = texture.generateMipmaps
    ? Math.floor(Math.log2(Math.max(width, height))) + 1
    : target.textures.length === 1 && texture.mipmaps.length > 0
      ? texture.mipmaps.length
      : 1;
  let total = 0;
  for (let level = 0; level < levels; level++) {
    const levelWidth = Math.max(1, Math.floor(width / (2 ** level)));
    const levelHeight = Math.max(1, Math.floor(height / (2 ** level)));
    const levelDepth = is3d && texture.generateMipmaps
      ? Math.max(1, Math.floor(depth / (2 ** level)))
      : depth;
    const levelBytes = byteLength(levelWidth, levelHeight, texture);
    if (levelBytes === undefined) return undefined;
    total += levelBytes * levelDepth * (isCube ? 6 : 1);
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

function isUnknownRenderTargetColorLayout(texture: THREE.Texture): boolean {
  const value = texture as TextureLike;
  return value.isVideoTexture === true
    || value.isVideoFrameTexture === true
    || value.isHTMLTexture === true
    || value.isExternalTexture === true
    || value.isDepthTexture === true
    || value.isCubeDepthTexture === true
    || value.isFramebufferTexture === true
    || value.isCompressedTexture === true
    || value.isCompressedArrayTexture === true;
}

function depthAttachmentBytesPerPixel(texture: THREE.Texture): number | undefined {
  if (texture.format === THREE.DepthStencilFormat) {
    return texture.type === THREE.FloatType ? 8 : 4;
  }
  if (texture.format !== THREE.DepthFormat) return undefined;
  if (texture.type === THREE.UnsignedShortType) return 2;
  if (texture.type === THREE.FloatType) return 4;
  if (texture.type === THREE.UnsignedIntType || texture.type === THREE.UnsignedInt248Type) return 3;
  return undefined;
}

function logicalRenderTargetDepthTextureBytes(
  target: RenderTargetLike,
  texture: THREE.Texture,
): number | undefined {
  if (renderTargetTopologyUnknown(target)) return undefined;
  const width = positiveDimension(target.width);
  const height = positiveDimension(target.height);
  const bytesPerPixel = depthAttachmentBytesPerPixel(texture);
  if (width === undefined || height === undefined || bytesPerPixel === undefined) return undefined;
  return safeAllocationProduct(
    width,
    height,
    bytesPerPixel,
    target.isWebGLCubeRenderTarget === true ? 6 : 1,
  );
}

function logicalDepthRenderbufferBytes(target: THREE.RenderTarget): number | undefined {
  const width = positiveDimension(target.width);
  const height = positiveDimension(target.height);
  if (width === undefined || height === undefined) return undefined;
  return safeAllocationProduct(width, height, target.stencilBuffer ? 4 : 3);
}

function logicalStandaloneDepthTextureBytes(texture: THREE.Texture): number | undefined {
  const dimensions = textureDimensions(texture.image);
  const bytesPerPixel = depthAttachmentBytesPerPixel(texture);
  if (!dimensions || bytesPerPixel === undefined) return undefined;
  // DepthTexture is uploaded as TEXTURE_2D in r185; image.depth is not an allocated layer count.
  return safeAllocationProduct(dimensions.width, dimensions.height, bytesPerPixel);
}

/**
 * Safely known logical allocation for one standalone texture.
 *
 * This is source/layout arithmetic only: browser decoded storage and driver residency are not
 * observable here. Unsupported layouts remain unknown rather than becoming a misleading zero.
 */
export function knownLogicalTextureBytes(texture: THREE.Texture): number | undefined {
  if (isUnknownTextureLayout(texture)) return undefined;
  if ((texture as TextureLike).isDepthTexture === true) return logicalStandaloneDepthTextureBytes(texture);
  if (texture.internalFormat !== null || texture.normalized === true) return undefined;
  const value = texture as TextureLike;
  const isArray = value.isDataArrayTexture === true;
  const is3d = value.isData3DTexture === true;
  const base = textureDimensions(texture.image);
  if (!base) return undefined;
  const baseDepth = isArray || is3d ? base.depth : 1;
  if (baseDepth === undefined) return undefined;

  const manualBase = texture.mipmaps.length > 0 ? textureDimensions(texture.mipmaps[0]) : undefined;
  if (texture.mipmaps.length > 0 && !manualBase) return undefined;
  // r185 texStorage uses the first manual mip's dimensions and the declared level count. When
  // generation is enabled it takes priority and allocates the full chain from the source base.
  const allocationBase = manualBase && !isArray && !is3d
    ? manualBase
    : base;
  const levels = texture.generateMipmaps
    ? Math.floor(Math.log2(Math.max(base.width, base.height))) + 1
    : Math.max(1, texture.mipmaps.length);
  let total = 0;
  for (let level = 0; level < levels; level++) {
    const width = Math.max(1, Math.floor(allocationBase.width / (2 ** level)));
    const height = Math.max(1, Math.floor(allocationBase.height / (2 ** level)));
    const depth = is3d ? Math.max(1, Math.floor(baseDepth / (2 ** level))) : baseDepth;
    const levelBytes = byteLength(width, height, texture);
    if (levelBytes === undefined) return undefined;
    total += levelBytes * depth;
  }
  return Number.isSafeInteger(total) ? total : undefined;
}

export interface GeometryInstanceBuffers {
  readonly instanceMatrix?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
  readonly instanceColor?: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined;
}

function referenceAttributeCpu(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): void {
  const interleaved = "isInterleavedBufferAttribute" in attribute
    && attribute.isInterleavedBufferAttribute === true;
  const identity = interleaved ? attribute.data : attribute;
  if (ArrayBuffer.isView(identity.array)) visitor.referenceCpu(ownerId, identity.array);
  else visitor.referenceUnsupported(ownerId, identity);
}

/** Registers direct buffers, morph CPU inputs, and optional instanced-mesh buffers. */
export function visitGeometryBuffers(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  geometry: THREE.BufferGeometry,
  instance: GeometryInstanceBuffers = {},
): void {
  if (geometry.index) visitor.referenceGpuBuffer(ownerId, geometry.index);
  for (const attribute of Object.values(geometry.attributes)) {
    visitor.referenceGpuBuffer(ownerId, attribute);
  }
  let hasMorphAttributes = false;
  for (const attributes of Object.values(geometry.morphAttributes)) {
    if (!attributes) continue;
    for (const attribute of attributes) {
      hasMorphAttributes = true;
      // Three r185 repacks morph inputs into a renderer-owned DataArrayTexture. Retain their CPU
      // inputs exactly, but do not report them as direct WebGLAttributes buffers.
      referenceAttributeCpu(visitor, ownerId, attribute);
    }
  }
  if (hasMorphAttributes) visitor.referenceUnsupported(ownerId, geometry.morphAttributes);
  if (instance.instanceMatrix) visitor.referenceGpuBuffer(ownerId, instance.instanceMatrix);
  if (instance.instanceColor) visitor.referenceGpuBuffer(ownerId, instance.instanceColor);
}

/**
 * Visits only Three's direct material texture properties and ShaderMaterial uniform values.
 * Arbitrary nested material objects are intentionally not walked: that would turn userData and
 * renderer internals into accidental ownership claims.
 */
export function visitMaterialTextures(
  visitor: RetainedResourceVisitor,
  material: THREE.Material | readonly (THREE.Material | undefined)[],
): void {
  const materials = Array.isArray(material) ? material : [material];
  for (const entry of materials) {
    if (!isThreeMaterial(entry)) continue;
    for (const value of Object.values(entry)) {
      if (isThreeTexture(value)) visitor.referenceGpuTexture(entry, value);
    }
    const shader = entry as THREE.ShaderMaterial & { readonly isShaderMaterial?: unknown };
    if (shader.isShaderMaterial !== true) continue;
    for (const uniform of Object.values(shader.uniforms)) {
      visitUniformTextureValue(visitor, entry, uniform.value);
    }
  }
}

function visitUniformTextureValue(
  visitor: RetainedResourceVisitor,
  ownerId: ResourceOwnerId,
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (isThreeTexture(value)) {
    visitor.referenceGpuTexture(ownerId, value);
  } else if (Array.isArray(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const item of value) visitUniformTextureValue(visitor, ownerId, item, seen);
  } else if (isPlainObject(value)) {
    if (seen.has(value)) return;
    seen.add(value);
    for (const member of Object.values(value)) {
      visitUniformTextureValue(visitor, ownerId, member, seen);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isThreeMaterial(value: unknown): value is THREE.Material {
  return typeof value === "object" && value !== null
    && (value as { readonly isMaterial?: unknown }).isMaterial === true;
}

function isThreeTexture(value: unknown): value is THREE.Texture {
  return typeof value === "object" && value !== null
    && (value as { readonly isTexture?: unknown }).isTexture === true;
}
