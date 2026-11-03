import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { canonicalString, type Reading } from "./reading.ts";

/**
 * Device public keys are registered as the raw uncompressed P-256 point:
 * 65 bytes (0x04 || X || Y), base64 encoded. That is what WebCrypto's
 * exportKey("raw") returns and what mbedTLS writes for an uncompressed point.
 */
export function publicKeyFromRaw(rawB64: string): KeyObject {
  const raw = Buffer.from(rawB64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("public key must be a 65-byte uncompressed P-256 point");
  }
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

/** True only if `reading.sig` is a valid signature by this key over the canonical string. */
export function verifyReading(reading: Reading, publicKeyRawB64: string): boolean {
  let key: KeyObject;
  try {
    key = publicKeyFromRaw(publicKeyRawB64);
  } catch {
    return false;
  }
  const sig = Buffer.from(reading.sig, "base64");
  if (sig.length !== 64) return false;
  const { sig: _sig, ...unsigned } = reading;
  const data = Buffer.from(canonicalString(unsigned), "utf8");
  try {
    return verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}

/** True only if `sigB64` is a valid signature by this key over the UTF-8 text. */
export function verifyText(text: string, sigB64: string, publicKeyRawB64: string): boolean {
  try {
    const key = publicKeyFromRaw(publicKeyRawB64);
    const sig = Buffer.from(sigB64, "base64");
    if (sig.length !== 64) return false;
    return verify("sha256", Buffer.from(text, "utf8"), { key, dsaEncoding: "ieee-p1363" }, sig);
  } catch {
    return false;
  }
}
