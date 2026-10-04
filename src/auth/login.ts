import {
  AUTH_SECURITY_TOKEN,
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
  /**
   * Asked only when the challenge says the account needs an authenticator code (`securityFlags & 4`,
   * `AuthSession::LogonChallengeCallback`) and no `token` was given: the player types the code after
   * the challenge, as the client's PLAYER_ENTER_TOKEN → `TokenEntered` does (10.10). Rejecting it
   * abandons the login before the proof is sent.
   */
  onTokenRequired?: () => Promise<string>;
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

  // The proof is computed while the player types the code; nothing is sent before both exist.
  const proofReady = computeSrpProof(username, credentials.password, challenge);
  let token = credentials.token;
  if ((challenge.securityFlags & AUTH_SECURITY_TOKEN) !== 0 && token === undefined && credentials.onTokenRequired) {
    try {
      token = await credentials.onTokenRequired();
    } catch (error) {
      proofReady.catch(() => {});
      throw error;
    }
  }
  const proof = await proofReady;
  stream.send(buildLogonProof(proof, challenge.securityFlags, token));

  const proofHeader = await stream.readExactly(2);
  if ((proofHeader[1] ?? 0) !== 0) parseLogonProof(proofHeader, proof.M2);
  const proofBody = await stream.readExactly(30);
  parseLogonProof(concatBytes(proofHeader, proofBody), proof.M2);

  const realms = await readRealmList(stream);

  return { username, sessionKey: proof.sessionKey, realms };
}

/**
 * `REALM_LIST` (0x10) on an authenticated auth connection, and its answer. The authserver answers
 * it as often as it is asked (`AuthSession` handles it in `STATUS_AUTHED`, refreshing its own list
 * every `RealmsStateUpdateDelay`), which is how the realm dialog keeps population and status
 * current while it is open (10.08).
 */
export async function readRealmList(stream: BinaryByteStream): Promise<RealmInfo[]> {
  stream.send(buildRealmListRequest());
  const realmHeader = await stream.readExactly(3);
  const realmPayloadLength = (realmHeader[1] ?? 0) | ((realmHeader[2] ?? 0) << 8);
  return parseRealmList(concatBytes(realmHeader, await stream.readExactly(realmPayloadLength)));
}
