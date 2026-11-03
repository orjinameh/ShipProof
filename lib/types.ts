import type { Overrides, ProfileName } from "./profiles.ts";

export interface Org {
  id: string;
  name: string;
  createdAt: number; // unix seconds
}

export interface User {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  createdAt: number;
}

/** A device (tag) that a company has claimed as its own. */
export interface Tag {
  deviceId: string;
  orgId: string;
  label: string;
  addedAt: number;
}

export type ParcelStatus = "created" | "in_transit" | "delivered";

export interface Parcel {
  id: string;
  orgId: string;
  orderRef: string;
  deviceId: string;
  profile: ProfileName;
  overrides?: Overrides;
  status: ParcelStatus;
  createdAt: number;
  /** Start of the custody window. Readings before this are not evidence. */
  dispatchedAt?: number;
  /** End of the custody window. Readings after this are kept apart as "after delivery". */
  deliveredAt?: number;
}

export type ClaimStatus = "open" | "investigating" | "decided" | "appealed" | "closed";

export type Outcome = "supports_claim" | "does_not_support_claim" | "inconclusive";
export type Confidence = "low" | "medium" | "high";
export type RecommendedAction = "approve_refund" | "deny_refund" | "request_more_info" | "manual_review";

export interface Finding {
  text: string;
  /** Unix seconds of a reading or event this finding refers to, or null. Checked against the evidence. */
  ts: number | null;
}

export interface Verdict {
  outcome: Outcome;
  confidence: Confidence;
  summary: string;
  findings: Finding[];
  /** What the evidence cannot show. */
  limits: string[];
  recommendedAction: RecommendedAction;
}

export interface Decision {
  verdict: Verdict;
  /** "serv-reasoning" when the model decided, "automatic" when the rules decided without calling it. */
  via: "serv-reasoning" | "automatic";
  model: string | null;
  servResponseId: string | null;
  usage?: { promptTokens: number; completionTokens: number };
  /** SHA-256 over the exact readings and parcel facts the verdict was based on. */
  evidenceHash: string;
  decidedAt: number;
  appealUntil: number;
  /** SHA-256 over this record, so later edits are detectable. */
  recordHash: string;
}

export type Resolution = "refund_approved" | "refund_denied" | "other";

export interface Claim {
  id: string;
  orgId: string;
  parcelId: string;
  claimant: string;
  statement: string;
  filedAt: number;
  status: ClaimStatus;
  decision?: Decision;
  /** Set while an investigation is running, so a crashed run can be retried after a while. */
  investigatingSince?: number;
  lastError?: { message: string; at: number };
  appeal?: { note: string; at: number; by: string };
  resolution?: { outcome: Resolution; note: string; at: number; by: string };
}
