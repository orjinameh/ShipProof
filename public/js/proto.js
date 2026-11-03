// ShipProof reading protocol, browser side. No DOM access, so it also runs in Node for tests.
// Must stay byte-for-byte compatible with lib/reading.ts (canonicalString) and lib/verify.ts.

export const SHOCK_HIGH_G = 2.5; // hard knock
export const SHOCK_LOW_G = 0.3; // free fall

export function canonicalString(r) {
  return [
    "v1",
    r.deviceId,
    r.parcelId,
    r.ts,
    r.ax,
    r.ay,
    r.az,
    r.shock,
    r.latE6 ?? "",
    r.lonE6 ?? "",
  ].join("|");
}

export function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Private key is non-extractable: it can sign but can never be read back out. */
export function generateDeviceKey() {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

/** 65-byte uncompressed point, the format POST /api/devices expects. */
export async function publicKeyRaw(publicKey) {
  return new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
}

export async function deviceIdFor(rawPublicKey) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  let hex = "";
  for (const b of hash.slice(0, 6)) hex += b.toString(16).padStart(2, "0");
  return "ph-" + hex;
}

/** Adds `sig`: base64 of the 64-byte r||s ECDSA P-256 signature over SHA-256(canonical string). */
export async function signReading(privateKey, reading) {
  const data = new TextEncoder().encode(canonicalString(reading));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data);
  return { ...reading, sig: b64(sig) };
}

/**
 * m/s^2 to integer milli-g. `flip` handles iOS, which reports the opposite sign to the
 * W3C convention. After this, a phone lying flat and screen-up reads az = +1000.
 */
export function toMilliG(ms2, flip) {
  const v = Math.round((ms2 / 9.80665) * 1000);
  return (flip ? -v : v) + 0; // + 0 turns -0 into 0
}

export function magnitudeG(ax, ay, az) {
  return Math.hypot(ax, ay, az) / 1000;
}

export function isShock(g) {
  return g >= SHOCK_HIGH_G || g <= SHOCK_LOW_G;
}

/** Of the samples in one second, the one furthest from resting (1 g). */
export function pickRepresentative(samples) {
  let best = samples[0];
  let bestDev = -1;
  for (const s of samples) {
    const dev = Math.abs(magnitudeG(s.ax, s.ay, s.az) - 1);
    if (dev > bestDev) {
      bestDev = dev;
      best = s;
    }
  }
  return best;
}
