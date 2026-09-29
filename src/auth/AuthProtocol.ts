import { PacketReader } from "../protocol/PacketReader.js";
import { PacketWriter } from "../protocol/PacketWriter.js";
import { concatBytes, equalBytes, uppercaseBasicLatin, type SrpChallenge, type SrpProof } from "./Srp6.js";

const encoder = new TextEncoder();

export const AUTH_LOGON_CHALLENGE = 0x00;
export const AUTH_LOGON_PROOF = 0x01;
export const REALM_LIST = 0x10;
export const AUTH_SECURITY_PIN = 0x01;
export const AUTH_SECURITY_MATRIX = 0x02;
export const AUTH_SECURITY_TOKEN = 0x04;
export const REALM_FLAG_OFFLINE = 0x02;
export const REALM_FLAG_SPECIFY_BUILD = 0x04;

export class AuthProtocolError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "AuthProtocolError";
    this.code = code;
  }
}

/**
 * The authserver's session proof (M2) did not match the one computed here: whoever answered does
 * not hold the verifier it accepted the password against. The client's LOGIN_BAD_SERVER_PROOF.
 */
export class AuthServerProofError extends AuthProtocolError {
  constructor() {
    super("Authserver returned an invalid SRP6 session proof");
    this.name = "AuthServerProofError";
  }
}

export interface LogonChallenge extends SrpChallenge {
  securityFlags: number;
  crcSalt: Uint8Array;
}

export interface RealmInfo {
  type: number;
  locked: boolean;
  flags: number;
  name: string;
  address: string;
  population: number;
  characters: number;
  timezone: number;
  id: number;
  build: number | undefined;
}

/** The authserver marks stopped realms and incompatible builds as offline. */
export function canSelectRealm(realm: Pick<RealmInfo, "locked" | "flags">): boolean {
  return !realm.locked && (realm.flags & REALM_FLAG_OFFLINE) === 0;
}

function reversedAscii(value: string, includeNull: boolean): Uint8Array {
  const bytes = encoder.encode(value.split("").reverse().join(""));
  return includeNull ? concatBytes(bytes, Uint8Array.of(0)) : bytes;
}

export function buildLogonChallenge(usernameInput: string, locale = "enUS"): Uint8Array {
  const username = uppercaseBasicLatin(usernameInput);
  const usernameBytes = encoder.encode(username);
  if (usernameBytes.byteLength === 0 || usernameBytes.byteLength > 16) {
    throw new RangeError("Account name must contain 1-16 UTF-8 bytes");
  }
  if (!/^[A-Za-z]{2}[A-Z]{2}$/.test(locale)) throw new TypeError("Locale must look like enUS or ruRU");

  return new PacketWriter()
    .u8(AUTH_LOGON_CHALLENGE)
    .u8(0)
    .u16(30 + usernameBytes.byteLength)
    .bytes(Uint8Array.of(0x57, 0x6f, 0x57, 0))
    .u8(3)
    .u8(3)
    .u8(5)
    .u16(12340)
    .bytes(reversedAscii("x86", true))
    .bytes(reversedAscii("Win", true))
    .bytes(reversedAscii(locale, false))
    .u32(0)
    .u32(0)
    .u8(usernameBytes.byteLength)
    .bytes(usernameBytes)
    .toUint8Array();
}

export function challengeSecurityExtraLength(flags: number): number {
  return (flags & AUTH_SECURITY_PIN ? 20 : 0) + (flags & AUTH_SECURITY_MATRIX ? 12 : 0) + (flags & AUTH_SECURITY_TOKEN ? 1 : 0);
}

export function parseLogonChallenge(packet: Uint8Array): LogonChallenge {
  const reader = new PacketReader(packet);
  if (reader.u8() !== AUTH_LOGON_CHALLENGE) throw new AuthProtocolError("Unexpected auth challenge command");
  reader.u8();
  const result = reader.u8();
  if (result !== 0) throw new AuthProtocolError(`Auth challenge failed with code ${result}`, result);

  const B = reader.bytes(32);
  const gLength = reader.u8();
  const g = reader.bytes(gLength);
  const nLength = reader.u8();
  const N = reader.bytes(nLength);
  const salt = reader.bytes(32);
  const crcSalt = reader.bytes(16);
  const securityFlags = reader.u8();
  if (securityFlags & AUTH_SECURITY_PIN) reader.bytes(20);
  if (securityFlags & AUTH_SECURITY_MATRIX) reader.bytes(12);
  if (securityFlags & AUTH_SECURITY_TOKEN) reader.u8();
  reader.assertFinished();

  return { B, g, N, salt, crcSalt, securityFlags };
}

export function buildLogonProof(proof: SrpProof, securityFlags: number, token?: string): Uint8Array {
  if (securityFlags & (AUTH_SECURITY_PIN | AUTH_SECURITY_MATRIX)) {
    throw new AuthProtocolError("PIN and matrix authentication are not supported by this realm");
  }
  if (securityFlags & AUTH_SECURITY_TOKEN && !/^\d{6}$/.test(token ?? "")) {
    throw new AuthProtocolError("This account requires a six-digit authenticator token");
  }

  const writer = new PacketWriter()
    .u8(AUTH_LOGON_PROOF)
    .bytes(proof.A)
    .bytes(proof.M1)
    // The active authserver has StrictVersionCheck=0, so the client version proof is not consumed.
    .bytes(new Uint8Array(20))
    .u8(0)
    .u8(securityFlags);

  if (securityFlags & AUTH_SECURITY_TOKEN) {
    const tokenBytes = encoder.encode(token ?? "");
    writer.u8(tokenBytes.byteLength).bytes(tokenBytes);
  }
  return writer.toUint8Array();
}

export function parseLogonProof(packet: Uint8Array, expectedM2: Uint8Array): void {
  const reader = new PacketReader(packet);
  if (reader.u8() !== AUTH_LOGON_PROOF) throw new AuthProtocolError("Unexpected auth proof command");
  const result = reader.u8();
  if (result !== 0) throw new AuthProtocolError(`Authentication failed with code ${result}`, result);
  const M2 = reader.bytes(20);
  reader.u32();
  reader.u32();
  reader.u16();
  reader.assertFinished();
  if (!equalBytes(M2, expectedM2)) throw new AuthServerProofError();
}

export function buildRealmListRequest(): Uint8Array {
  return new PacketWriter().u8(REALM_LIST).u32(0).toUint8Array();
}

export function parseRealmList(packet: Uint8Array): RealmInfo[] {
  const reader = new PacketReader(packet);
  if (reader.u8() !== REALM_LIST) throw new AuthProtocolError("Unexpected realm-list command");
  const payloadLength = reader.u16();
  if (payloadLength !== reader.remaining) throw new AuthProtocolError("Invalid realm-list payload length");
  reader.u32();
  const count = reader.u16();
  if (count > 1024) throw new AuthProtocolError(`Unreasonable realm count: ${count}`);

  const realms: RealmInfo[] = [];
  for (let index = 0; index < count; index++) {
    const type = reader.u8();
    const locked = reader.u8() !== 0;
    const flags = reader.u8();
    const name = reader.cString();
    const address = reader.cString();
    const population = reader.f32();
    const characters = reader.u8();
    const timezone = reader.u8();
    const id = reader.u8();
    let build: number | undefined;
    if (flags & REALM_FLAG_SPECIFY_BUILD) {
      reader.u8();
      reader.u8();
      reader.u8();
      build = reader.u16();
    }
    realms.push({ type, locked, flags, name, address, population, characters, timezone, id, build });
  }

  if (reader.u8() !== 0x10 || reader.u8() !== 0x00) throw new AuthProtocolError("Invalid realm-list terminator");
  reader.assertFinished();
  return realms;
}
