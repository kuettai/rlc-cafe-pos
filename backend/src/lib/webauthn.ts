/**
 * WebAuthn (passkey) support for the ADMIN page.
 *
 * This module is the ONE place that knows the relying-party identity and the
 * shape of a stored credential. Routes call the four wrappers below and never
 * import `@simplewebauthn/server` directly — the library's option names have
 * changed shape twice across major versions (v11's `authenticator:` became
 * v13+'s `credential:`, and `registrationInfo.credentialID` became
 * `registrationInfo.credential.id`), so a second call site is a second thing to
 * migrate.
 *
 * Installed against @simplewebauthn/server v14: `generate*Options` are async and
 * `verifyRegistrationResponse` returns `registrationInfo.credential.{id,
 * publicKey, counter}`.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { docClient, SETTINGS_TABLE, GetCommand, PutCommand, DeleteCommand } from './db';

// ─── Relying-party configuration ──────────────────────────────────────────
// The live domain (see .kiro/steering/project.md). rpID is the bare host with
// no scheme and no port; origin is the full URL the browser reports. A mismatch
// in either makes every assertion fail verification with no useful client-side
// error, so they are constants here rather than env vars that a deploy could
// blank — the same reasoning that moved the VAPID keys out of the Lambda
// environment.
export const RP_ID = '153.oasisofcare.org';
export const RP_NAME = 'RLC Café POS Admin';
export const ORIGIN = 'https://153.oasisofcare.org';

/** How long a registration/authentication challenge stays usable. */
export const CHALLENGE_TTL_SECONDS = 300;

/**
 * One passkey as stored inside a user record's `passkeyCredentials` list.
 *
 * `publicKey` is a base64url STRING, not the `Uint8Array` the library hands
 * back. The DocumentClient would marshal a Uint8Array as a DynamoDB Binary (B)
 * attribute, which round-trips back as a Buffer-ish value whose exact type
 * depends on the SDK version — storing the base64url text keeps the record a
 * plain JSON object that any script, test fixture or console view can read.
 * `fromBase64Url()` turns it back into bytes on the verify path.
 */
export interface StoredPasskeyCredential {
  credentialId: string;
  /** base64url-encoded COSE public key. */
  publicKey: string;
  /** Signature counter — replay protection. Must be persisted after each login. */
  counter: number;
  transports?: string[];
  deviceLabel: string;
  createdAt: string;
}

/** A challenge record read back out of the settings table. */
export interface StoredChallenge {
  challenge: string;
  /** The user the challenge was issued to, or null for a usernameless login. */
  userId: string | null;
  /** Epoch SECONDS — a DynamoDB TTL attribute. */
  expiresAt: number;
}

// ─── base64url <-> bytes ──────────────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

/** Current time in epoch seconds — the unit DynamoDB TTL uses. */
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ─── Challenge storage ────────────────────────────────────────────────────
// Kept on the SETTINGS table under `WEBAUTHN_CHALLENGE#{requestId}` with a
// numeric `expiresAt` in epoch seconds — the identical TTL idiom `PUSH_SUB#`
// already uses (routes/push.ts). This is NOT the "expiresAt only on PENDING
// orders" hazard: that invariant is about the ORDERS table, where a stray
// numeric TTL deletes a live order. Here the record is meant to be ephemeral
// and TTL is the point.
//
// TTL deletion is best-effort and can lag by hours, so every reader still
// compares `expiresAt` itself rather than trusting absence.

export async function putChallenge(
  requestId: string,
  challenge: string,
  userId: string | null,
): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: SETTINGS_TABLE,
    Item: {
      PK: `WEBAUTHN_CHALLENGE#${requestId}`,
      SK: 'META',
      challenge,
      userId,
      expiresAt: nowEpochSeconds() + CHALLENGE_TTL_SECONDS,
    },
  }));
}

/** The stored challenge, or null if there is no such record. */
export async function getChallenge(requestId: string): Promise<StoredChallenge | null> {
  const result = await docClient.send(new GetCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `WEBAUTHN_CHALLENGE#${requestId}`, SK: 'META' },
  }));
  const item = result.Item;
  if (!item || typeof item.challenge !== 'string') return null;
  return {
    challenge: item.challenge,
    userId: typeof item.userId === 'string' ? item.userId : null,
    expiresAt: typeof item.expiresAt === 'number' ? item.expiresAt : 0,
  };
}

/**
 * Challenges are single-use. Callers delete on EVERY outcome — including a
 * failed verification — so a captured response cannot be replayed against a
 * challenge that is still sitting in the table.
 */
export async function deleteChallenge(requestId: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: SETTINGS_TABLE,
    Key: { PK: `WEBAUTHN_CHALLENGE#${requestId}`, SK: 'META' },
  }));
}

/** True when the challenge is past its own recorded expiry. */
export function isChallengeExpired(stored: StoredChallenge): boolean {
  return stored.expiresAt <= nowEpochSeconds();
}

// ─── Library wrappers ─────────────────────────────────────────────────────

/**
 * Registration options for one admin.
 *
 * `residentKey: 'required'` is load-bearing: it asks for a DISCOVERABLE
 * credential, which is what lets the login page call
 * `navigator.credentials.get()` with an empty `allowCredentials` and no
 * username. Drop it and login-options has nothing to offer the browser.
 *
 * `userVerification: 'preferred'` (not `'required'`) so a device without a
 * biometric or PIN can still enrol — and the verify wrappers below therefore
 * pass `requireUserVerification: false`, because requiring at verification what
 * was only preferred at generation rejects legitimate authenticators.
 */
export async function buildRegistrationOptions(
  user: { userId: string; name: string },
  existing: StoredPasskeyCredential[],
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: user.userId,
    userDisplayName: user.name || user.userId,
    userID: new Uint8Array(Buffer.from(user.userId, 'utf8')),
    attestationType: 'none',
    // Stops the same authenticator enrolling twice for the same admin.
    excludeCredentials: existing
      .filter(c => typeof c?.credentialId === 'string' && c.credentialId)
      .map(c => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}

export async function verifyRegistration(
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<VerifiedRegistrationResponse> {
  return verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    requireUserVerification: false,
  });
}

/**
 * Authentication options with NO `allowCredentials` — usernameless login. The
 * browser offers whichever discoverable passkey it holds for this rpID, and the
 * server learns who it is from the credential ID in the response.
 */
export async function buildAuthenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  return generateAuthenticationOptions({
    rpID: RP_ID,
    allowCredentials: [],
    userVerification: 'preferred',
  });
}

export async function verifyAuthentication(
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  stored: StoredPasskeyCredential,
): Promise<VerifiedAuthenticationResponse> {
  return verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    credential: {
      id: stored.credentialId,
      publicKey: fromBase64Url(stored.publicKey),
      counter: typeof stored.counter === 'number' ? stored.counter : 0,
      transports: stored.transports,
    },
    requireUserVerification: false,
  });
}
