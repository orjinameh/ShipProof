/**
 * ShipProof reading format, version 1.
 *
 * Every device (phone page, ESP32 tag, anything else) sends this same record.
 * All numbers are integers so the signed bytes are identical on every platform
 * (no float formatting differences between JavaScript and C++).
 *
 *   v        1
 *   deviceId string, 1-64 chars of [A-Za-z0-9_-]
 *   parcelId string, 1-64 chars of [A-Za-z0-9_-]
 *   ts       unix seconds (integer)
 *   ax,ay,az acceleration in milli-g (integer), 1 g = 1000
 *   shock    0 or 1 (device-detected shock event)
 *   latE6    optional latitude  in micro-degrees (integer)
 *   lonE6    optional longitude in micro-degrees (integer)
 *   snd      version 2 only: loudest sound level since the previous reading, an integer 0-100.
 *            A level only, never audio: the tag does not record sound.
 *   sig      base64 of the 64-byte ECDSA P-256 signature (r || s) over SHA-256
 *            of the canonical string below
 *
 * Canonical string (UTF-8, no trailing newline), fields joined by "|":
 *   v1|deviceId|parcelId|ts|ax|ay|az|shock|latE6|lonE6
 * A missing latE6 / lonE6 is written as an empty string, e.g. "...|0||".
 * Version 2 uses "v2" and appends |snd:  v2|deviceId|parcelId|ts|ax|ay|az|shock|latE6|lonE6|snd
 */

export interface Reading {
  v: 1 | 2;
  deviceId: string;
  parcelId: string;
  ts: number;
  ax: number;
  ay: number;
  az: number;
  shock: 0 | 1;
  latE6?: number;
  lonE6?: number;
  snd?: number;
  sig: string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_ACCEL = 1_000_000; // 1000 g in milli-g, far above any real value

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x);
}

export type ParseResult =
  | { ok: true; reading: Reading }
  | { ok: false; error: string };

export function parseReading(input: unknown): ParseResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "reading must be an object" };
  }
  const r = input as Record<string, unknown>;
  if (r.v !== 1 && r.v !== 2) return { ok: false, error: "unsupported version" };
  if (typeof r.deviceId !== "string" || !ID_RE.test(r.deviceId)) {
    return { ok: false, error: "invalid deviceId" };
  }
  if (typeof r.parcelId !== "string" || !ID_RE.test(r.parcelId)) {
    return { ok: false, error: "invalid parcelId" };
  }
  if (!isInt(r.ts) || r.ts <= 0) return { ok: false, error: "invalid ts" };
  for (const k of ["ax", "ay", "az"] as const) {
    const val = r[k];
    if (!isInt(val) || Math.abs(val) > MAX_ACCEL) {
      return { ok: false, error: `invalid ${k}` };
    }
  }
  if (r.shock !== 0 && r.shock !== 1) return { ok: false, error: "invalid shock" };

  const hasLat = r.latE6 !== undefined;
  const hasLon = r.lonE6 !== undefined;
  if (hasLat !== hasLon) {
    return { ok: false, error: "latE6 and lonE6 must be sent together" };
  }
  if (hasLat) {
    if (!isInt(r.latE6) || Math.abs(r.latE6) > 90_000_000) {
      return { ok: false, error: "invalid latE6" };
    }
    if (!isInt(r.lonE6) || Math.abs(r.lonE6) > 180_000_000) {
      return { ok: false, error: "invalid lonE6" };
    }
  }
  if (r.v === 2) {
    if (!isInt(r.snd) || r.snd < 0 || r.snd > 100) return { ok: false, error: "invalid snd" };
  } else if (r.snd !== undefined) {
    return { ok: false, error: "snd needs version 2" };
  }
  if (typeof r.sig !== "string" || r.sig.length === 0 || r.sig.length > 200) {
    return { ok: false, error: "invalid sig" };
  }

  const reading: Reading = {
    v: r.v,
    deviceId: r.deviceId,
    parcelId: r.parcelId,
    ts: r.ts,
    ax: r.ax as number,
    ay: r.ay as number,
    az: r.az as number,
    shock: r.shock,
    sig: r.sig,
  };
  if (r.v === 2) reading.snd = r.snd as number;
  if (hasLat) {
    reading.latE6 = r.latE6 as number;
    reading.lonE6 = r.lonE6 as number;
  }
  return { ok: true, reading };
}

/** The exact string that devices sign. Must match firmware byte for byte. */
export function canonicalString(r: Omit<Reading, "sig">): string {
  return [
    r.v === 2 ? "v2" : "v1",
    r.deviceId,
    r.parcelId,
    r.ts,
    r.ax,
    r.ay,
    r.az,
    r.shock,
    r.latE6 ?? "",
    r.lonE6 ?? "",
    ...(r.v === 2 ? [r.snd ?? 0] : []),
  ].join("|");
}
