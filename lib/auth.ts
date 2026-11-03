import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const SESSION_SECONDS = 7 * 24 * 3600;
export const COOKIE_NAME = "sp_session";

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Format: scrypt$<salt base64>$<hash base64>. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface Session {
  uid: string;
  oid: string;
  exp: number; // unix seconds
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function mac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function makeSessionToken(uid: string, oid: string, nowSeconds: number, secret: string): string {
  const payload = b64url(JSON.stringify({ uid, oid, exp: nowSeconds + SESSION_SECONDS } satisfies Session));
  return `${payload}.${mac(payload, secret)}`;
}

export function readSessionToken(token: string | undefined, nowSeconds: number, secret: string): Session | undefined {
  if (!token) return undefined;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return undefined;
  const expected = Buffer.from(mac(payload, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (typeof s.uid !== "string" || typeof s.oid !== "string" || typeof s.exp !== "number") return undefined;
    return s.exp > nowSeconds ? s : undefined;
  } catch {
    return undefined;
  }
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? "; Secure" : ""}`;
}

export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

/** Allows 5 failed sign-ins per email per 15 minutes. In memory, so it resets when the server restarts. */
export class LoginLimiter {
  private fails = new Map<string, { count: number; resetAt: number }>();

  blocked(key: string, nowMs: number): boolean {
    const f = this.fails.get(key);
    if (!f || f.resetAt <= nowMs) return false;
    return f.count >= 5;
  }

  fail(key: string, nowMs: number) {
    const f = this.fails.get(key);
    if (!f || f.resetAt <= nowMs) this.fails.set(key, { count: 1, resetAt: nowMs + 15 * 60_000 });
    else f.count++;
  }

  clear(key: string) {
    this.fails.delete(key);
  }
}
