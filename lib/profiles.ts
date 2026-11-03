/**
 * Handling profiles: how hard a knock a package type can take.
 *
 * These numbers are demo defaults, not industry standards. A company picks a profile
 * per parcel and may override single limits. The tag only reports raw readings; the
 * server applies the limits, so they can be changed without touching any device.
 */

export type ProfileName = "fragile" | "standard" | "rugged";

export interface Limits {
  /** Force at or above this counts as an impact, in g. */
  shockG: number;
  /** Force at or below this counts as free fall, in g. */
  freeFallG: number;
  /** Angle from the tag's upright axis above this counts as tilted, in degrees. 180 turns the check off. */
  maxTiltDeg: number;
}

export interface Overrides {
  shockG?: number;
  freeFallG?: number;
  maxTiltDeg?: number;
}

export const PROFILES: Record<ProfileName, { label: string; description: string; limits: Limits }> = {
  fragile: {
    label: "Fragile",
    description: "Glass, electronics, ceramics. Low impact limit and keep upright.",
    limits: { shockG: 1.8, freeFallG: 0.4, maxTiltDeg: 60 },
  },
  standard: {
    label: "Standard",
    description: "Everyday goods in a normal box.",
    limits: { shockG: 2.5, freeFallG: 0.3, maxTiltDeg: 100 },
  },
  rugged: {
    label: "Rugged",
    description: "Tools, sealed goods, anything that takes a beating. Orientation doesn't matter.",
    limits: { shockG: 4, freeFallG: 0.2, maxTiltDeg: 180 },
  },
};

export function isProfileName(x: unknown): x is ProfileName {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PROFILES, x);
}

const BOUNDS = {
  shockG: [1.1, 10],
  freeFallG: [0.05, 0.8],
  maxTiltDeg: [10, 180],
} as const;

/** Returns cleaned overrides, or an error message. Unknown keys are rejected. */
export function parseOverrides(input: unknown): Overrides | string {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) return "overrides must be an object";
  const out: Overrides = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(key in BOUNDS)) return `unknown override "${key}"`;
    const [min, max] = BOUNDS[key as keyof typeof BOUNDS];
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      return `${key} must be a number from ${min} to ${max}`;
    }
    out[key as keyof Overrides] = value;
  }
  return out;
}

export function limitsFor(profile: ProfileName, overrides?: Overrides): Limits {
  return { ...PROFILES[profile].limits, ...(overrides ?? {}) };
}
