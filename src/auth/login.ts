import {
  buildLogonChallenge,
  buildLogonProof,
  buildRealmListRequest,
  challengeSecurityExtraLength,
  parseLogonChallenge,
  parseLogonProof,
  parseRealmList,
  type RealmInfo,
} from "./AuthProtocol.js";
import { computeSrpProof, concatBytes, uppercaseBasicLatin } from "./Srp6.js";
import type { BinaryByteStream } from "../transport/WebSocketByteStream.js";

export interface LoginCredentials {
  username: string;
  password: string;
  locale?: string;
  token?: string;
}

export interface AuthSessionResult {
  username: string;
  sessionKey: Uint8Array;
  realms: RealmInfo[];
}

export async function loginToRealmList(
  stream: BinaryByteStream,
  credentials: LoginCredentials,
): Promise<AuthSessionResult> {
  const username = uppercaseBasicLatin(credentials.username);
  stream.send(buildLogonChallenge(username, credentials.locale));

  const challengeHeader = await stream.readExactly(3);
  if ((challengeHeader[2] ?? 0) !== 0) parseLogonChallenge(challengeHeader);
  const challengeBody = await stream.readExactly(116);
  const securityFlags = challengeBody[115] ?? 0;
  const securityExtra = await stream.readExactly(challengeSecurityExtraLength(securityFlags));
  const challenge = parseLogonChallenge(concatBytes(challengeHeader, challengeBody, securityExtra));

  const proof = await computeSrpProof(username, credentials.password, challenge);
  stream.send(buildLogonProof(proof, challenge.securityFlags, credentials.token));

  const proofHeader = await stream.readExactly(2);
  if ((proofHeader[1] ?? 0) !== 0) parseLogonProof(proofHeader, proof.M2);
  const proofBody = await stream.readExactly(30);
  parseLogonProof(concatBytes(proofHeader, proofBody), proof.M2);

  stream.send(buildRealmListRequest());
  const realmHeader = await stream.readExactly(3);
  const realmPayloadLength = (realmHeader[1] ?? 0) | ((realmHeader[2] ?? 0) << 8);
  const realms = parseRealmList(concatBytes(realmHeader, await stream.readExactly(realmPayloadLength)));

  return { username, sessionKey: proof.sessionKey, realms };
}
