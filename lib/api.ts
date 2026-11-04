import {
  LoginLimiter, clearedCookie, hashPassword, makeSessionToken, newId, parseCookies, readSessionToken,
  sessionCookie, verifyPassword, COOKIE_NAME, makePairToken, readPairToken,
} from "./auth.ts";
import { AFTER_DELIVERY_SECONDS, buildEvidence, type Evidence } from "./evidence.ts";
import { InvestigatorError, investigate, recordIsIntact, servConfigFromEnv, type ServConfig } from "./investigator.ts";
import { MAX_BATCH, ingestReadings } from "./ingest.ts";
import { PROFILES, isProfileName, limitsFor, parseOverrides } from "./profiles.ts";
import { getStore, type Store } from "./store.ts";
import type { Claim, Org, Parcel, Resolution, User } from "./types.ts";
import { publicKeyFromRaw, verifyText } from "./verify.ts";

/**
 * The whole HTTP API as one function from Request to Response. The Next.js route
 * files are thin wrappers around it, and the tests call it directly.
 */

export interface ApiContext {
  store: Store;
  secret: string;
  serv: ServConfig;
  /** Milliseconds. Injected so tests can control time. */
  now: () => number;
  appealHours: number;
  limiter: LoginLimiter;
}

let shared: ApiContext | undefined;
export async function defaultContext(): Promise<ApiContext> {
  if (!shared) {
    const store = await getStore();
    shared = {
      store,
      secret: process.env.SESSION_SECRET || (await store.getSecret()),
      serv: servConfigFromEnv(),
      now: () => Date.now(),
      appealHours: Number(process.env.APPEAL_WINDOW_HOURS) > 0 ? Number(process.env.APPEAL_WINDOW_HOURS) : 48,
      limiter: new LoginLimiter(),
    };
  }
  return shared;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,100}\.[^\s@]{2,100}$/;
const STUCK_INVESTIGATION_SECONDS = 300;

// ---------- small helpers ----------

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}
const fail = (status: number, error: string, message: string) => json(status, { error, message });

type Body = Record<string, unknown>;

async function readBody(req: Request, allowArray = false): Promise<{ body: unknown } | { res: Response }> {
  // Requiring JSON also blocks cross-site form posts, which cannot send this content type.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    return { res: fail(415, "json_required", "Send the request as application/json.") };
  }
  const text = await req.text();
  if (text.length > 200_000) return { res: fail(413, "too_large", "The request is too large.") };
  if (!text.trim()) return { body: {} };
  try {
    const body = JSON.parse(text) as unknown;
    if (!allowArray && (typeof body !== "object" || body === null || Array.isArray(body))) {
      return { res: fail(400, "bad_body", "The request body must be a JSON object.") };
    }
    return { body };
  } catch {
    return { res: fail(400, "bad_json", "The request body is not valid JSON.") };
  }
}

function str(v: unknown, min: number, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length >= min && t.length <= max ? t : undefined;
}

interface Auth {
  user: User;
  org: Org;
}

async function authenticate(req: Request, ctx: ApiContext): Promise<Auth | undefined> {
  const token = parseCookies(req.headers.get("cookie"))[COOKIE_NAME];
  const session = readSessionToken(token, Math.floor(ctx.now() / 1000), ctx.secret);
  if (!session) return undefined;
  const user = await ctx.store.getUser(session.uid);
  if (!user || user.orgId !== session.oid) return undefined;
  const org = await ctx.store.getOrg(user.orgId);
  return org ? { user, org } : undefined;
}

const needSignIn = () => fail(401, "sign_in_required", "Sign in to continue.");

let dummyHash: Promise<string> | undefined;

function parcelView(p: Parcel) {
  return { ...p, profileLabel: PROFILES[p.profile].label, limits: limitsFor(p.profile, p.overrides) };
}

async function evidenceFor(ctx: ApiContext, p: Parcel): Promise<Evidence | undefined> {
  if (p.dispatchedAt === undefined) return undefined;
  const now = Math.floor(ctx.now() / 1000);
  const to = (p.deliveredAt ?? now) + AFTER_DELIVERY_SECONDS;
  const readings = await ctx.store.listReadingsByDevice(p.deviceId, p.dispatchedAt, to);
  return buildEvidence({
    parcelId: p.id,
    deviceId: p.deviceId,
    profile: p.profile,
    limits: limitsFor(p.profile, p.overrides),
    dispatchedAt: p.dispatchedAt,
    deliveredAt: p.deliveredAt,
    readings,
    nowSeconds: now,
  });
}

async function ownParcel(ctx: ApiContext, auth: Auth, id: string): Promise<Parcel | undefined> {
  const p = await ctx.store.getParcel(id);
  return p && p.orgId === auth.org.id ? p : undefined;
}

async function ownClaim(ctx: ApiContext, auth: Auth, id: string): Promise<Claim | undefined> {
  const c = await ctx.store.getClaim(id);
  return c && c.orgId === auth.org.id ? c : undefined;
}

// ---------- the dispatcher ----------

export async function handleApi(req: Request, given?: ApiContext): Promise<Response> {
  const ctx = given ?? (await defaultContext());
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
  let segs: string[];
  try {
    segs = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return fail(400, "bad_path", "The address is not valid.");
  }

  try {
    const [a, b, c] = segs;

    // ----- public: accounts
    if (a === "auth") {
      if (b === "signup" && method === "POST") return await signup(req, ctx, secure);
      if (b === "login" && method === "POST") return await login(req, ctx, secure);
      if (b === "logout" && method === "POST") {
        const r = await readBody(req);
        if ("res" in r) return r.res;
        return json(200, { ok: true }, { "set-cookie": clearedCookie(secure) });
      }
      if (b === "me" && method === "GET") {
        const auth = await authenticate(req, ctx);
        return auth ? json(200, { user: { email: auth.user.email }, org: { id: auth.org.id, name: auth.org.name } }) : needSignIn();
      }
      return fail(404, "not_found", "No such endpoint.");
    }

    // ----- public: handling profiles
    if (a === "profiles" && method === "GET") {
      return json(200, { profiles: Object.entries(PROFILES).map(([name, p]) => ({ name, ...p })) });
    }

    // ----- public: a decision anyone with the link can check (no login, no personal details)
    if (a === "public" && b === "decisions" && c && method === "GET") return await publicDecision(ctx, c, Math.floor(ctx.now() / 1000));

    // ----- public: a phone or tag pairs itself to a company by proving it holds its key
    if (a === "pair" && method === "POST") return await pairTag(req, ctx);

    // ----- public: the buyer's tracking page (the parcel id in the link is the key)
    if (a === "track" && b) return await track(req, ctx, b, c, method, Math.floor(ctx.now() / 1000));

    // ----- public: tags and their readings (checked by signature, not by login)
    if (a === "devices" && method === "POST") return await registerDevice(req, ctx);
    if (a === "readings" && method === "POST") {
      const r = await readBody(req, true);
      if ("res" in r) return r.res;
      const body = r.body;
      const items = Array.isArray(body) ? body : Array.isArray((body as Body)?.readings) ? ((body as Body).readings as unknown[]) : [body];
      if (items.length === 0) return fail(400, "no_readings", "Send at least one reading.");
      if (items.length > MAX_BATCH) return fail(413, "too_many", `Send at most ${MAX_BATCH} readings per request.`);
      const results = await ingestReadings(ctx.store, items, Math.floor(ctx.now() / 1000));
      const count = (s: string) => results.filter((x) => x.status === s).length;
      return json(200, { accepted: count("accepted"), duplicate: count("duplicate"), rejected: count("rejected"), results });
    }

    // ----- everything below needs a signed-in company
    const auth = await authenticate(req, ctx);
    if (!auth) return needSignIn();
    const nowS = Math.floor(ctx.now() / 1000);

    if (a === "readings" && method === "GET") {
      const label = url.searchParams.get("parcelId");
      if (!label || !ID_RE.test(label)) return fail(400, "bad_parcel_id", "Use a parcelId of letters, numbers, dashes or underscores.");
      const mine = new Set((await ctx.store.listTags(auth.org.id)).map((t) => t.deviceId));
      const readings = (await ctx.store.listReadings(label)).filter((r) => mine.has(r.deviceId));
      return json(200, { parcelId: label, count: readings.length, readings });
    }

    if (a === "org" && b === "pairing" && method === "POST") {
      const r = await readBody(req);
      if ("res" in r) return r.res;
      return json(200, makePairToken(auth.org.id, nowS, ctx.secret));
    }

    if (a === "org" && b === "tags") {
      if (method === "GET") return await listTags(ctx, auth, nowS);
      if (method === "POST") return await addTag(req, ctx, auth, nowS);
    }

    if (a === "parcels") {
      if (!b) {
        if (method === "GET") return json(200, { parcels: (await ctx.store.listParcels(auth.org.id)).map(parcelView) });
        if (method === "POST") return await createParcel(req, ctx, auth, nowS);
      } else {
        const parcel = await ownParcel(ctx, auth, b);
        if (!parcel) return fail(404, "not_found", "No such parcel.");
        if (!c && method === "GET") return json(200, { parcel: parcelView(parcel) });
        if (c === "dispatch" && method === "POST") return await moveParcel(req, ctx, parcel, "dispatch", nowS);
        if (c === "delivered" && method === "POST") return await moveParcel(req, ctx, parcel, "delivered", nowS);
        if (c === "readings" && method === "GET") return await parcelReadings(ctx, parcel, nowS);
        if (c === "evidence" && method === "GET") {
          const ev = await evidenceFor(ctx, parcel);
          return ev ? json(200, { parcel: parcelView(parcel), evidence: ev }) : fail(409, "not_dispatched", "This parcel hasn't been dispatched, so there is no evidence yet.");
        }
        if (c === "claims" && method === "POST") return await fileClaim(req, ctx, auth, parcel, nowS);
      }
    }

    if (a === "claims") {
      if (!b && method === "GET") return await listClaims(ctx, auth);
      if (b) {
        const claim = await ownClaim(ctx, auth, b);
        if (!claim) return fail(404, "not_found", "No such claim.");
        if (!c && method === "GET") return await claimDetail(ctx, claim, nowS);
        if (c === "investigate" && method === "POST") return await runInvestigation(req, ctx, claim, nowS);
        if (c === "appeal" && method === "POST") return await appeal(req, ctx, auth, claim, nowS);
        if (c === "close" && method === "POST") return await closeClaim(req, ctx, auth, claim, nowS);
      }
    }

    return fail(404, "not_found", "No such endpoint.");
  } catch (e) {
    console.error("api error", e);
    return fail(500, "server_error", "Something went wrong on the server.");
  }
}

// ---------- accounts ----------

async function signup(req: Request, ctx: ApiContext, secure: boolean): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  const company = str(b.company, 2, 80);
  const email = str(b.email, 3, 200)?.toLowerCase();
  const password = typeof b.password === "string" && b.password.length >= 8 && b.password.length <= 200 ? b.password : undefined;
  if (!company) return fail(400, "bad_company", "Enter your company name, 2 to 80 characters.");
  if (!email || !EMAIL_RE.test(email)) return fail(400, "bad_email", "Enter a valid email address.");
  if (!password) return fail(400, "bad_password", "Use a password of at least 8 characters.");

  const now = Math.floor(ctx.now() / 1000);
  const org: Org = { id: newId("org"), name: company, createdAt: now };
  const user: User = { id: newId("usr"), orgId: org.id, email, passwordHash: await hashPassword(password), createdAt: now };
  if (!(await ctx.store.createAccount(org, user))) return fail(409, "email_taken", "An account with this email already exists. Sign in instead.");
  const token = makeSessionToken(user.id, org.id, now, ctx.secret);
  return json(201, { user: { email }, org: { id: org.id, name: org.name } }, { "set-cookie": sessionCookie(token, secure) });
}

async function login(req: Request, ctx: ApiContext, secure: boolean): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  const email = str(b.email, 3, 200)?.toLowerCase();
  const password = typeof b.password === "string" && b.password.length <= 200 ? b.password : undefined;
  const generic = fail(401, "invalid_credentials", "That email and password don't match.");
  if (!email || !password) return generic;
  if (ctx.limiter.blocked(email, ctx.now())) {
    return fail(429, "too_many_attempts", "Too many failed sign-ins. Wait 15 minutes and try again.");
  }
  const user = await ctx.store.getUserByEmail(email);
  dummyHash ??= hashPassword("not a real password");
  const ok = await verifyPassword(password, user ? user.passwordHash : await dummyHash);
  if (!user || !ok) {
    ctx.limiter.fail(email, ctx.now());
    return generic;
  }
  ctx.limiter.clear(email);
  const org = await ctx.store.getOrg(user.orgId);
  if (!org) return generic;
  const token = makeSessionToken(user.id, org.id, Math.floor(ctx.now() / 1000), ctx.secret);
  return json(200, { user: { email }, org: { id: org.id, name: org.name } }, { "set-cookie": sessionCookie(token, secure) });
}

// ---------- tags ----------

async function registerDevice(req: Request, ctx: ApiContext): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const { deviceId, publicKey } = r.body as Body;
  if (typeof deviceId !== "string" || !ID_RE.test(deviceId)) return fail(400, "bad_device_id", "Invalid deviceId.");
  if (typeof publicKey !== "string") return fail(400, "bad_public_key", "Send the device's public key.");
  try {
    publicKeyFromRaw(publicKey);
  } catch (e) {
    return fail(400, "bad_public_key", (e as Error).message);
  }
  const existing = await ctx.store.getDevice(deviceId);
  if (existing) {
    return existing.publicKey === publicKey
      ? json(200, { deviceId, status: "already-registered" })
      : fail(409, "key_mismatch", "This device ID is already registered with a different key.");
  }
  await ctx.store.putDevice({ deviceId, publicKey, registeredAt: Math.floor(ctx.now() / 1000) });
  return json(201, { deviceId, status: "registered" });
}

async function pairTag(req: Request, ctx: ApiContext): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  const nowS = Math.floor(ctx.now() / 1000);
  const t = readPairToken(b.token, nowS, ctx.secret);
  if (!t) return fail(400, "bad_pair_code", "This pairing code has expired. Show a new one in the console and scan it again.");
  const org = await ctx.store.getOrg(t.oid);
  if (!org) return fail(400, "bad_pair_code", "This pairing code is no longer valid.");
  const deviceId = typeof b.deviceId === "string" && ID_RE.test(b.deviceId) ? b.deviceId : undefined;
  if (!deviceId) return fail(400, "bad_device_id", "Invalid deviceId.");
  if (typeof b.publicKey !== "string" || typeof b.signature !== "string") return fail(400, "bad_pair_proof", "Send the public key and its signature.");
  try {
    publicKeyFromRaw(b.publicKey);
  } catch (e) {
    return fail(400, "bad_public_key", (e as Error).message);
  }
  // The device signs the code with its own key, proving it holds that key.
  if (!verifyText(`pair|${b.token as string}|${deviceId}`, b.signature, b.publicKey)) return fail(400, "bad_pair_proof", "The signature doesn't match this device's key.");
  const label = b.label === undefined || b.label === "" ? deviceId : str(b.label, 1, 60);
  if (!label) return fail(400, "bad_label", "Use a label of up to 60 characters.");
  const existing = await ctx.store.getDevice(deviceId);
  if (existing && existing.publicKey !== b.publicKey) return fail(409, "key_mismatch", "This device ID is registered with a different key.");
  if (!existing) await ctx.store.putDevice({ deviceId, publicKey: b.publicKey, registeredAt: nowS });
  const result = await ctx.store.claimTag({ deviceId, orgId: org.id, label, addedAt: nowS });
  if (result === "owned") return fail(409, "tag_taken", "Another company already holds this tag.");
  return json(200, { org: { name: org.name }, tag: { deviceId, label } });
}

async function listTags(ctx: ApiContext, auth: Auth, nowS: number): Promise<Response> {
  const tags = await ctx.store.listTags(auth.org.id);
  const week = 7 * 24 * 3600;
  const out = [];
  for (const t of tags) {
    const recent = await ctx.store.listReadingsByDevice(t.deviceId, nowS - week, nowS + 300);
    out.push({ ...t, readingsLast7Days: recent.length, lastReadingTs: recent[recent.length - 1]?.ts ?? null });
  }
  return json(200, { tags: out });
}

async function addTag(req: Request, ctx: ApiContext, auth: Auth, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  const deviceId = typeof b.deviceId === "string" && ID_RE.test(b.deviceId) ? b.deviceId : undefined;
  if (!deviceId) return fail(400, "bad_device_id", "Enter the tag's device ID: letters, numbers, dashes or underscores.");
  const label = b.label === undefined || b.label === "" ? deviceId : str(b.label, 1, 60);
  if (!label) return fail(400, "bad_label", "Use a label of up to 60 characters.");

  let device = await ctx.store.getDevice(deviceId);
  if (typeof b.publicKey === "string" && b.publicKey) {
    try {
      publicKeyFromRaw(b.publicKey);
    } catch (e) {
      return fail(400, "bad_public_key", (e as Error).message);
    }
    if (device && device.publicKey !== b.publicKey) return fail(409, "key_mismatch", "That public key doesn't match the one this tag registered with.");
    if (!device) {
      device = { deviceId, publicKey: b.publicKey, registeredAt: nowS };
      await ctx.store.putDevice(device);
    }
  }
  if (!device) {
    return fail(404, "unknown_device", "This tag hasn't registered yet. Power it on with a connection once, or paste its public key.");
  }
  const result = await ctx.store.claimTag({ deviceId, orgId: auth.org.id, label, addedAt: nowS });
  if (result === "owned") return fail(409, "tag_taken", "Another company already holds this tag.");
  return json(201, { tag: { deviceId, label } });
}

// ---------- parcels ----------

async function createParcel(req: Request, ctx: ApiContext, auth: Auth, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  const orderRef = str(b.orderRef, 1, 80);
  if (!orderRef) return fail(400, "bad_order_ref", "Enter the order reference, up to 80 characters.");
  if (typeof b.deviceId !== "string") return fail(400, "bad_device_id", "Choose a tag.");
  if (!isProfileName(b.profile)) return fail(400, "bad_profile", "Choose a handling profile: fragile, standard or rugged.");
  const overrides = parseOverrides(b.overrides);
  if (typeof overrides === "string") return fail(400, "bad_overrides", overrides);
  const tag = await ctx.store.getTag(b.deviceId);
  if (!tag || tag.orgId !== auth.org.id) return fail(404, "unknown_tag", "That tag isn't one of yours. Add it under Tags first.");

  const parcel: Parcel = {
    id: newId("par"),
    orgId: auth.org.id,
    orderRef,
    deviceId: tag.deviceId,
    profile: b.profile,
    ...(Object.keys(overrides).length ? { overrides } : {}),
    status: "created",
    createdAt: nowS,
  };
  if (!(await ctx.store.createParcel(parcel))) {
    return fail(409, "tag_busy", "This tag is still assigned to a parcel that hasn't been delivered.");
  }
  return json(201, { parcel: parcelView(parcel) });
}

async function moveParcel(req: Request, ctx: ApiContext, parcel: Parcel, step: "dispatch" | "delivered", nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  let applied = false;
  const updated = await ctx.store.mutateParcel(parcel.id, (p) => {
    if (step === "dispatch" && p.status === "created") {
      applied = true;
      return { ...p, status: "in_transit", dispatchedAt: nowS };
    }
    if (step === "delivered" && p.status === "in_transit") {
      applied = true;
      return { ...p, status: "delivered", deliveredAt: Math.max(nowS, p.dispatchedAt ?? nowS) };
    }
    return undefined;
  });
  if (!applied || !updated) {
    return fail(409, "bad_state", step === "dispatch" ? "Only a parcel that hasn't been dispatched can be dispatched." : "Only a parcel in transit can be marked delivered.");
  }
  return json(200, { parcel: parcelView(updated) });
}

async function parcelReadings(ctx: ApiContext, p: Parcel, nowS: number): Promise<Response> {
  if (p.dispatchedAt === undefined) {
    return json(200, { parcelId: p.id, orderRef: p.orderRef, deviceId: p.deviceId, status: p.status, window: null, count: 0, readings: [] });
  }
  const to = p.deliveredAt ?? nowS;
  const readings = await ctx.store.listReadingsByDevice(p.deviceId, p.dispatchedAt, to);
  return json(200, {
    parcelId: p.id,
    orderRef: p.orderRef,
    deviceId: p.deviceId,
    status: p.status,
    window: { from: p.dispatchedAt, to, open: p.deliveredAt === undefined },
    count: readings.length,
    readings,
  });
}

// ---------- claims ----------

async function fileClaim(req: Request, ctx: ApiContext, auth: Auth, parcel: Parcel, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  if (parcel.status !== "delivered") return fail(409, "not_delivered", "A claim can be filed once the parcel is marked delivered.");
  const claimant = str(b.claimant, 1, 100);
  const statement = str(b.statement, 1, 2000);
  if (!claimant) return fail(400, "bad_claimant", "Enter who is making the claim, up to 100 characters.");
  if (!statement) return fail(400, "bad_statement", "Describe the claim in up to 2000 characters.");
  const claim: Claim = { id: newId("clm"), orgId: auth.org.id, parcelId: parcel.id, claimant, statement, filedAt: nowS, status: "open" };
  await ctx.store.putClaim(claim);
  return json(201, { claim });
}

async function listClaims(ctx: ApiContext, auth: Auth): Promise<Response> {
  const [claims, parcels] = await Promise.all([ctx.store.listClaims(auth.org.id), ctx.store.listParcels(auth.org.id)]);
  const byId = new Map(parcels.map((p) => [p.id, p]));
  return json(200, {
    claims: claims.map((c) => ({
      id: c.id,
      parcelId: c.parcelId,
      orderRef: byId.get(c.parcelId)?.orderRef ?? "",
      claimant: c.claimant,
      filedAt: c.filedAt,
      source: c.source ?? "company",
      status: c.status,
      outcome: c.decision?.verdict.outcome ?? null,
    })),
  });
}

async function track(req: Request, ctx: ApiContext, id: string, action: string | undefined, method: string, nowS: number): Promise<Response> {
  const parcel = ID_RE.test(id) ? await ctx.store.getParcel(id) : undefined;
  const org = parcel ? await ctx.store.getOrg(parcel.orgId) : undefined;
  if (!parcel || !org) return fail(404, "not_found", "We can't find this parcel. Check the link in your message.");
  const findClaim = async () => (await ctx.store.listClaims(parcel.orgId)).find((c) => c.parcelId === parcel.id);

  if (action === "claim" && method === "POST") {
    const r = await readBody(req);
    if ("res" in r) return r.res;
    const b = r.body as Body;
    if (parcel.status !== "delivered") return fail(409, "not_delivered", "You can report a problem once the parcel is marked delivered.");
    if (await findClaim()) return fail(409, "already_filed", "A report was already filed for this parcel.");
    const name = str(b.name, 1, 100);
    const statement = str(b.statement, 1, 2000);
    const contact = b.contact === undefined || b.contact === "" ? "" : str(b.contact, 1, 120);
    if (!name) return fail(400, "bad_name", "Enter your name, up to 100 characters.");
    if (!statement) return fail(400, "bad_statement", "Describe what is wrong, up to 2000 characters.");
    if (contact === undefined) return fail(400, "bad_contact", "Keep the contact detail to 120 characters.");
    const claim: Claim = { id: newId("clm"), orgId: parcel.orgId, parcelId: parcel.id, claimant: name, statement, source: "buyer", ...(contact ? { contact } : {}), filedAt: nowS, status: "open" };
    await ctx.store.putClaim(claim);
    return json(201, { ok: true });
  }

  if (action === "appeal" && method === "POST") {
    const r = await readBody(req);
    if ("res" in r) return r.res;
    const note = str((r.body as Body).note, 1, 1000);
    if (!note) return fail(400, "bad_note", "Say why you disagree, up to 1000 characters.");
    const claim = await findClaim();
    if (!claim) return fail(404, "no_claim", "No report was filed for this parcel.");
    return applyAppeal(ctx, claim, note, "buyer", nowS);
  }

  if (action || method !== "GET") return fail(404, "not_found", "No such page.");
  const claim = await findClaim();
  const evidence = parcel.dispatchedAt ? await evidenceFor(ctx, parcel) : undefined;
  const finished = claim && (claim.status === "closed" || claim.status === "appealed");
  return json(200, {
    company: org.name,
    orderRef: parcel.orderRef,
    status: parcel.status,
    dispatchedAt: parcel.dispatchedAt ?? null,
    deliveredAt: parcel.deliveredAt ?? null,
    // Only counts and the peak: what the sensor saw, with nothing about other parcels or the company.
    protection: evidence ? { readingCount: evidence.readingCount, coverage: evidence.coverage, peakG: evidence.peakG, events: evidence.events.length, limitG: limitsFor(parcel.profile, parcel.overrides).shockG } : null,
    canReport: parcel.status === "delivered" && !claim,
    claim: claim
      ? {
          status: claim.status,
          filedAt: claim.filedAt,
          // The company's notes stay private. The buyer sees the outcome only once the company has decided.
          outcome: claim.status === "closed" && claim.resolution ? claim.resolution.outcome : null,
          decidedAt: claim.status === "closed" && claim.resolution ? claim.resolution.at : null,
          verifyUrl: finished && claim.decision ? `/verify/${claim.id}` : null,
          canAppeal: canAppealNow(claim, nowS, ctx.appealHours),
          appealUntil: appealDeadline(claim, ctx.appealHours) ?? null,
          appealedAt: claim.appeal?.at ?? null,
        }
      : null,
  });
}

async function publicDecision(ctx: ApiContext, id: string, nowS: number): Promise<Response> {
  void nowS;
  const claim = ID_RE.test(id) ? await ctx.store.getClaim(id) : undefined;
  const parcel = claim ? await ctx.store.getParcel(claim.parcelId) : undefined;
  if (!claim || !parcel || !claim.decision) return fail(404, "not_found", "No decision at this address.");
  const d = claim.decision;
  const evidence = await evidenceFor(ctx, parcel);
  // No claimant, statement, order reference or company: only what is needed to check the decision.
  return json(200, {
    claimId: claim.id,
    status: claim.status,
    handlingProfile: PROFILES[parcel.profile].label,
    limits: limitsFor(parcel.profile, parcel.overrides),
    verdict: d.verdict,
    via: d.via,
    model: d.model,
    decidedAt: d.decidedAt,
    appealUntil: d.appealUntil,
    evidenceHash: d.evidenceHash,
    recordHash: d.recordHash,
    integrity: {
      recordIntact: recordIsIntact(claim.id, claim.parcelId, d),
      evidenceUnchanged: evidence ? evidence.evidenceHash === d.evidenceHash : false,
    },
    evidenceSummary: evidence
      ? { readingCount: evidence.readingCount, coverage: evidence.coverage, peakG: evidence.peakG, events: evidence.events.length }
      : null,
  });
}

async function claimDetail(ctx: ApiContext, claim: Claim, nowS: number): Promise<Response> {
  const parcel = await ctx.store.getParcel(claim.parcelId);
  if (!parcel) return fail(404, "not_found", "The parcel for this claim is gone.");
  const evidence = await evidenceFor(ctx, parcel);
  const d = claim.decision;
  return json(200, {
    claim,
    parcel: parcelView(parcel),
    evidence,
    integrity: d
      ? {
          recordIntact: recordIsIntact(claim.id, claim.parcelId, d),
          // False when readings arrived after the decision, for example a tag uploading late.
          evidenceUnchanged: evidence ? evidence.evidenceHash === d.evidenceHash : false,
        }
      : null,
    investigator: { configured: !!ctx.serv.apiKey, model: ctx.serv.model },
    canAppeal: canAppealNow(claim, nowS, ctx.appealHours),
  });
}

async function runInvestigation(req: Request, ctx: ApiContext, claim: Claim, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const parcel = await ctx.store.getParcel(claim.parcelId);
  if (!parcel) return fail(404, "not_found", "The parcel for this claim is gone.");

  // Take the job atomically, so two clicks can't start two investigations.
  let taken = false;
  await ctx.store.mutateClaim(claim.id, (c) => {
    const stuck = c.status === "investigating" && nowS - (c.investigatingSince ?? 0) > STUCK_INVESTIGATION_SECONDS;
    if (c.status !== "open" && !stuck) return undefined;
    taken = true;
    return { ...c, status: "investigating", investigatingSince: nowS };
  });
  if (!taken) return fail(409, "bad_state", "This claim already has a decision or is being investigated.");

  const release = (message: string) =>
    ctx.store.mutateClaim(claim.id, (c) => {
      const { investigatingSince: _s, ...rest } = c;
      return { ...rest, status: "open", lastError: { message, at: Math.floor(ctx.now() / 1000) } };
    });

  try {
    const evidence = await evidenceFor(ctx, parcel);
    if (!evidence || parcel.status !== "delivered") {
      await release("The parcel must be delivered before the claim can be investigated.");
      return fail(409, "not_delivered", "The parcel must be delivered before the claim can be investigated.");
    }
    const decision = await investigate({
      claimId: claim.id,
      parcelId: parcel.id,
      claimant: claim.claimant,
      statement: claim.statement,
      orderRef: parcel.orderRef,
      profileLabel: PROFILES[parcel.profile].label,
      limits: limitsFor(parcel.profile, parcel.overrides),
      evidence,
      nowSeconds: Math.floor(ctx.now() / 1000),
      appealHours: ctx.appealHours,
      config: ctx.serv,
    });
    await ctx.store.mutateClaim(claim.id, (c) => {
      const { investigatingSince: _s, lastError: _e, ...rest } = c;
      return { ...rest, status: "decided", decision };
    });
    return claimDetail(ctx, (await ctx.store.getClaim(claim.id)) as Claim, Math.floor(ctx.now() / 1000));
  } catch (e) {
    if (e instanceof InvestigatorError) {
      await release(e.message);
      return fail(e.code === "not_configured" ? 503 : 502, e.code, e.message);
    }
    await release("The investigation failed unexpectedly. Try again.");
    throw e;
  }
}

/** An appeal is possible from the verdict until the window ends, including after the company denied the refund. */
function appealDeadline(c: Claim, hours: number): number | undefined {
  // The window runs from the verdict. A claim the company closed without a verdict gets one from the day it was closed.
  return c.decision ? c.decision.appealUntil : c.resolution ? c.resolution.at + hours * 3600 : undefined;
}
function canAppealNow(c: Claim, nowS: number, hours: number): boolean {
  const until = appealDeadline(c, hours);
  if (until === undefined || nowS > until) return false;
  return c.status === "decided" || (c.status === "closed" && c.resolution?.outcome !== "refund_approved");
}

async function applyAppeal(ctx: ApiContext, claim: Claim, note: string, by: string, nowS: number): Promise<Response> {
  let applied = false;
  const updated = await ctx.store.mutateClaim(claim.id, (c) => {
    if (!canAppealNow(c, nowS, ctx.appealHours)) return undefined;
    applied = true;
    const { resolution, ...rest } = c;
    return { ...rest, status: "appealed", appeal: { note, at: nowS, by, ...(resolution ? { previous: resolution } : {}) } };
  });
  if (!applied || !updated) {
    return fail(409, "bad_state", (appealDeadline(claim, ctx.appealHours) ?? Infinity) < nowS ? "The appeal window has closed." : "This claim can't be appealed right now.");
  }
  return json(200, { claim: updated });
}

async function appeal(req: Request, ctx: ApiContext, auth: Auth, claim: Claim, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const note = str((r.body as Body).note, 1, 1000);
  if (!note) return fail(400, "bad_note", "Say why you are appealing, up to 1000 characters.");
  return applyAppeal(ctx, claim, note, auth.user.email, nowS);
}

const RESOLUTIONS: Resolution[] = ["refund_approved", "refund_denied", "other"];

async function closeClaim(req: Request, ctx: ApiContext, auth: Auth, claim: Claim, nowS: number): Promise<Response> {
  const r = await readBody(req);
  if ("res" in r) return r.res;
  const b = r.body as Body;
  if (!RESOLUTIONS.includes(b.resolution as Resolution)) return fail(400, "bad_resolution", "Choose refund approved, refund denied or other.");
  const note = b.note === undefined || b.note === "" ? "" : str(b.note, 1, 1000);
  if (note === undefined) return fail(400, "bad_note", "Keep the note to 1000 characters.");
  let applied = false;
  const updated = await ctx.store.mutateClaim(claim.id, (c) => {
    if (c.status === "closed" || c.status === "investigating") return undefined;
    applied = true;
    return { ...c, status: "closed", resolution: { outcome: b.resolution as Resolution, note, at: nowS, by: auth.user.email } };
  });
  if (!applied || !updated) return fail(409, "bad_state", "This claim is already closed or being investigated.");
  return json(200, { claim: updated });
}
