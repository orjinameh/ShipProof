// Types for proto.js, so the TypeScript tests can import the browser module.

export const SHOCK_HIGH_G: number;
export const SHOCK_LOW_G: number;

export interface ReadingFields {
  v: number;
  deviceId: string;
  parcelId: string;
  ts: number;
  ax: number;
  ay: number;
  az: number;
  shock: number;
  latE6?: number;
  lonE6?: number;
}

export function canonicalString(reading: ReadingFields): string;
export function b64(bytes: ArrayBuffer | Uint8Array): string;
export function generateDeviceKey(): Promise<CryptoKeyPair>;
export function publicKeyRaw(publicKey: CryptoKey): Promise<Uint8Array>;
export function deviceIdFor(rawPublicKey: Uint8Array): Promise<string>;
export function signReading<T extends ReadingFields>(
  privateKey: CryptoKey,
  reading: T,
): Promise<T & { sig: string }>;
export function toMilliG(ms2: number, flip: boolean): number;
export function magnitudeG(ax: number, ay: number, az: number): number;
export function isShock(g: number): boolean;
export function pickRepresentative<T extends { ax: number; ay: number; az: number }>(samples: T[]): T;
