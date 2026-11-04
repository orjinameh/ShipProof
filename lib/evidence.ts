import { createHash } from "node:crypto";
import { canonicalString, type Reading } from "./reading.ts";
import type { Limits } from "./profiles.ts";

/** A silence longer than this between readings counts as a coverage gap. */
export const GAP_SECONDS = 60;
/** Readings this long after delivery are kept, apart from the evidence. */
export const AFTER_DELIVERY_SECONDS = 24 * 3600;
/** Flagged readings closer together than this belong to the same event. */
export const EVENT_MERGE_SECONDS = 3;
const MAX_EVENTS = 50;
const MAX_GAPS = 20;
const BUCKETS = 48;

/**
 * What a tag can and cannot see. Handling limits are about rough handling, not breakage:
 * a hard knock that breaks something lasts milliseconds and can exceed this range, and
 * a tag only reports one reading per window. The investigator is told this.
 */
export const SENSOR = { rangeG: 8, note: "Accelerometer range is about +-8 g and each reading is the strongest sample of a few seconds. Short, hard impacts, crushing and punctures can happen without any event being recorded." } as const;

/** A measured free fall shorter than this is sensor jitter, not a drop (50 ms is about 1 cm). */
export const MIN_FALL_MS = 50;
/** Drop height in centimetres from fall time in milliseconds. */
export const dropCmFor = (ms: number) => Math.round(0.5 * 9.81 * (ms / 1000) ** 2 * 100);

/** A sound level at or above this (0-100 scale) counts as a loud event. */
export const SOUND_LOUD = 60;

export type EventKind = "impact" | "free_fall" | "tilt" | "loud";

export interface EvidenceEvent {
  kind: EventKind;
  startTs: number;
  endTs: number;
  /** impact: highest force in g. free_fall: lowest force in g. tilt: largest angle in degrees. loud: highest sound level, 0-100. */
  peak: number;
  samples: number;
  /** free_fall only, when the tag measures it: the longest unbroken fall in milliseconds. */
  fallMs?: number;
  /** free_fall only: drop height in centimetres estimated from fallMs (h = g t^2 / 2, no air drag). */
  dropCm?: number;
  /** impact only: a loud sound was recorded within a few seconds of it. */
  withSound?: boolean;
}

export interface Gap {
  fromTs: number;
  toTs: number;
  seconds: number;
}

export interface Evidence {
  deviceId: string;
  window: { from: number; to: number };
  /** True while the parcel is still in transit, so the window ends "now". */
  windowOpen: boolean;
  limits: Limits;
  readingCount: number;
  firstTs: number | null;
  lastTs: number | null;
  peakG: number | null;
  peakTs: number | null;
  /** Loudest sound level, 0-100, or null when the tag has no microphone. Levels only, never audio. */
  peakSound: number | null;
  gaps: Gap[];
  gapSeconds: number;
  /** Share of the window not lost to gaps, 0 to 1. */
  coverage: number;
  events: EvidenceEvent[];
  eventsTruncated: boolean;
  /** How many readings the tag itself flagged as shocks. Informational: the limits above decide. */
  deviceFlaggedShocks: number;
  afterDelivery: { readingCount: number; firstTs: number | null; lastTs: number | null; events: EvidenceEvent[] };
  /** Strongest and weakest force per slice of the window, for a coarse picture. */
  buckets: { startTs: number; maxG: number; minG: number }[];
  /** SHA-256 over the parcel facts and every reading used, including their signatures. */
  evidenceHash: string;
}

export interface EvidenceInput {
  parcelId: string;
  deviceId: string;
  profile: string;
  limits: Limits;
  dispatchedAt: number;
  deliveredAt?: number;
  /** All readings from the assigned device, from dispatch to a day after delivery. */
  readings: Reading[];
  nowSeconds: number;
}

export const forceG = (r: Pick<Reading, "ax" | "ay" | "az">) => Math.hypot(r.ax, r.ay, r.az) / 1000;

/** Angle between the tag's upright (+z) axis and straight up. Null in free fall, where up is unknown. */
export function tiltDeg(r: Pick<Reading, "ax" | "ay" | "az">): number | null {
  const m = Math.hypot(r.ax, r.ay, r.az);
  if (m < 500) return null;
  return (Math.acos(Math.max(-1, Math.min(1, r.az / m))) * 180) / Math.PI;
}

function findEvents(readings: Reading[], limits: Limits): { events: EvidenceEvent[]; truncated: boolean } {
  const kinds: EventKind[] = ["impact", "free_fall", "tilt", "loud"];
  const all: EvidenceEvent[] = [];
  for (const kind of kinds) {
    let open: EvidenceEvent | undefined;
    for (const r of readings) {
      const g = forceG(r);
      const tilt = tiltDeg(r);
      let value: number | undefined;
      if (kind === "impact" && g >= limits.shockG) value = g;
      else if (kind === "free_fall" && g <= limits.freeFallG && (r.ff === undefined || r.ff >= MIN_FALL_MS)) value = g;
      else if (kind === "tilt" && limits.maxTiltDeg < 180 && tilt !== null && tilt > limits.maxTiltDeg) value = tilt;
      else if (kind === "loud" && r.snd !== undefined && r.snd >= SOUND_LOUD) value = r.snd;
      if (value === undefined) continue;
      if (open && r.ts - open.endTs <= EVENT_MERGE_SECONDS) {
        open.endTs = r.ts;
        open.samples++;
        open.peak = kind === "free_fall" ? Math.min(open.peak, value) : Math.max(open.peak, value);
        if (kind === "free_fall" && r.ff !== undefined) open.fallMs = Math.max(open.fallMs ?? 0, r.ff);
      } else {
        open = { kind, startTs: r.ts, endTs: r.ts, peak: value, samples: 1 };
        if (kind === "free_fall" && r.ff !== undefined) open.fallMs = r.ff;
        all.push(open);
      }
    }
  }
  // an impact with a loud sound at the same moment is stronger evidence than either alone
  const loud = all.filter((e) => e.kind === "loud");
  for (const e of all) if (e.kind === "impact") e.withSound = loud.some((l) => l.startTs <= e.endTs + EVENT_MERGE_SECONDS && l.endTs >= e.startTs - EVENT_MERGE_SECONDS);
  all.sort((a, b) => a.startTs - b.startTs || a.kind.localeCompare(b.kind));
  const round = (e: EvidenceEvent): EvidenceEvent => ({ ...e, peak: Math.round(e.peak * 100) / 100, ...(e.fallMs !== undefined ? { dropCm: dropCmFor(e.fallMs) } : {}) });
  return { events: all.slice(0, MAX_EVENTS).map(round), truncated: all.length > MAX_EVENTS };
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const from = input.dispatchedAt;
  const windowOpen = input.deliveredAt === undefined;
  const to = input.deliveredAt ?? input.nowSeconds;
  const sorted = [...input.readings]
    .filter((r) => r.deviceId === input.deviceId)
    .sort((a, b) => a.ts - b.ts);
  const inWindow = sorted.filter((r) => r.ts >= from && r.ts <= to);
  const after = windowOpen
    ? []
    : sorted.filter((r) => r.ts > to && r.ts <= to + AFTER_DELIVERY_SECONDS);

  // coverage gaps: before the first reading, between readings, after the last one
  const gaps: Gap[] = [];
  let prev = from;
  const stamps = inWindow.map((r) => r.ts);
  for (const ts of [...stamps, to]) {
    if (ts - prev > GAP_SECONDS) gaps.push({ fromTs: prev, toTs: ts, seconds: ts - prev });
    prev = ts;
  }
  const gapSeconds = gaps.reduce((a, g) => a + g.seconds, 0);
  const windowSeconds = Math.max(0, to - from);
  const coverage = windowSeconds > 0 ? Math.max(0, Math.min(1, 1 - gapSeconds / windowSeconds)) : 0;

  let peakG: number | null = null;
  let peakTs: number | null = null;
  for (const r of inWindow) {
    const g = forceG(r);
    if (peakG === null || g > peakG) {
      peakG = g;
      peakTs = r.ts;
    }
  }

  const found = findEvents(inWindow, input.limits);
  const afterFound = findEvents(after, input.limits);

  const bucketSec = Math.max(1, Math.ceil(windowSeconds / BUCKETS));
  const bucketMap = new Map<number, { maxG: number; minG: number }>();
  for (const r of inWindow) {
    const k = Math.floor((r.ts - from) / bucketSec);
    const g = forceG(r);
    const b = bucketMap.get(k);
    if (!b) bucketMap.set(k, { maxG: g, minG: g });
    else {
      b.maxG = Math.max(b.maxG, g);
      b.minG = Math.min(b.minG, g);
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const buckets = [...bucketMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, b]) => ({ startTs: from + k * bucketSec, maxG: r2(b.maxG), minG: r2(b.minG) }));

  const hashLines = [
    ["parcel", input.parcelId, input.deviceId, input.profile, input.limits.shockG, input.limits.freeFallG, input.limits.maxTiltDeg, from, input.deliveredAt ?? "open"].join("|"),
    "window",
    ...inWindow.map((r) => `${canonicalString(r)}|${r.sig}`),
  ];
  // After-delivery readings are shown to the investigator as context but are not hashed:
  // a tag keeps reporting after delivery, and that must not make a decision look altered.
  // For a parcel still in transit this hash changes as readings arrive. It is final once delivered.
  const evidenceHash = createHash("sha256").update(hashLines.join("\n")).digest("hex");

  return {
    deviceId: input.deviceId,
    window: { from, to },
    windowOpen,
    limits: input.limits,
    readingCount: inWindow.length,
    firstTs: inWindow[0]?.ts ?? null,
    lastTs: inWindow[inWindow.length - 1]?.ts ?? null,
    peakG: peakG === null ? null : r2(peakG),
    peakSound: inWindow.some((r) => r.snd !== undefined) ? Math.max(...inWindow.map((r) => r.snd ?? 0)) : null,
    peakTs,
    gaps: gaps.sort((a, b) => b.seconds - a.seconds).slice(0, MAX_GAPS).sort((a, b) => a.fromTs - b.fromTs),
    gapSeconds,
    coverage: r2(coverage),
    events: found.events,
    eventsTruncated: found.truncated,
    deviceFlaggedShocks: inWindow.filter((r) => r.shock === 1).length,
    afterDelivery: {
      readingCount: after.length,
      firstTs: after[0]?.ts ?? null,
      lastTs: after[after.length - 1]?.ts ?? null,
      events: afterFound.events.slice(0, 10),
    },
    buckets,
    evidenceHash,
  };
}

/** Readings that count as evidence, for drawing the recording. */
export function windowReadings(readings: Reading[], deviceId: string, from: number, to: number): Reading[] {
  return readings.filter((r) => r.deviceId === deviceId && r.ts >= from && r.ts <= to).sort((a, b) => a.ts - b.ts);
}
