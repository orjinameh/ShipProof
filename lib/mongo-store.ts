import { randomBytes } from "node:crypto";
import { MongoClient, type Collection, type Db } from "mongodb";
import type { Reading } from "./reading.ts";
import type { Device, Store } from "./store.ts";
import type { Claim, Org, Parcel, Tag, User } from "./types.ts";

/**
 * MongoDB Atlas store. Set MONGODB_URI (and optionally MONGODB_DB, default "shipproof").
 * Documents use our own id as _id. Read-modify-write uses a version field with retry,
 * so two requests changing the same parcel or claim cannot overwrite each other.
 */

type Doc<T> = T & { _id: string; _v?: number };
const strip = <T extends object>(d: Doc<T> | null): T | undefined => {
  if (!d) return undefined;
  const { _id, _v, ...rest } = d as Doc<T>;
  void _id; void _v;
  return rest as unknown as T;
};
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export class MongoStore implements Store {
  private db: Promise<Db>;
  private ready: Promise<void> | undefined;

  constructor(uri: string, dbName = "shipproof") {
    this.db = new MongoClient(uri).connect().then((c) => c.db(dbName));
  }

  private async col<T extends object>(name: string): Promise<Collection<Doc<T>>> {
    const db = await this.db;
    this.ready ??= this.indexes(db);
    await this.ready;
    return db.collection<Doc<T>>(name);
  }

  private async indexes(db: Db) {
    await db.collection("readings").createIndex({ deviceId: 1, ts: 1 });
    await db.collection("readings").createIndex({ parcelId: 1 });
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("tags").createIndex({ orgId: 1 });
    await db.collection("parcels").createIndex({ orgId: 1, createdAt: -1 });
    await db.collection("parcels").createIndex({ deviceId: 1, status: 1 });
    await db.collection("claims").createIndex({ orgId: 1, filedAt: -1 });
  }

  async getDevice(deviceId: string) {
    return strip<Device>(await (await this.col<Device>("devices")).findOne({ _id: deviceId } as never));
  }
  async putDevice(device: Device) {
    await (await this.col<Device>("devices")).replaceOne({ _id: device.deviceId } as never, { _id: device.deviceId, ...device } as never, { upsert: true });
  }

  async addReading(r: Reading) {
    const key = `${r.deviceId}|${r.parcelId}|${r.ts}`;
    try {
      await (await this.col<Reading>("readings")).insertOne({ _id: key, ...r } as never);
      return true;
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
  }
  async listReadings(parcelId: string) {
    const rows = await (await this.col<Reading>("readings")).find({ parcelId } as never).sort({ ts: 1 }).toArray();
    return rows.map((d) => strip<Reading>(d)!);
  }
  async listReadingsByDevice(deviceId: string, fromTs: number, toTs: number) {
    const rows = await (await this.col<Reading>("readings")).find({ deviceId, ts: { $gte: fromTs, $lte: toTs } } as never).sort({ ts: 1 }).toArray();
    return rows.map((d) => strip<Reading>(d)!);
  }

  async createAccount(org: Org, user: User) {
    try {
      await (await this.col<User>("users")).insertOne({ _id: user.id, ...user } as never);
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
    await (await this.col<Org>("orgs")).insertOne({ _id: org.id, ...org } as never);
    return true;
  }
  async getUserByEmail(email: string) {
    return strip<User>(await (await this.col<User>("users")).findOne({ email } as never));
  }
  async getUser(id: string) {
    return strip<User>(await (await this.col<User>("users")).findOne({ _id: id } as never));
  }
  async getOrg(id: string) {
    return strip<Org>(await (await this.col<Org>("orgs")).findOne({ _id: id } as never));
  }

  async getTag(deviceId: string) {
    return strip<Tag>(await (await this.col<Tag>("tags")).findOne({ _id: deviceId } as never));
  }
  async claimTag(tag: Tag) {
    const col = await this.col<Tag>("tags");
    try {
      await col.insertOne({ _id: tag.deviceId, ...tag } as never);
      return "ok" as const;
    } catch (e) {
      if (!isDup(e)) throw e;
      const cur = await col.findOne({ _id: tag.deviceId } as never);
      return cur && cur.orgId === tag.orgId ? ("ok" as const) : ("owned" as const);
    }
  }
  async listTags(orgId: string) {
    const rows = await (await this.col<Tag>("tags")).find({ orgId } as never).sort({ addedAt: 1 }).toArray();
    return rows.map((d) => strip<Tag>(d)!);
  }

  async createParcel(parcel: Parcel) {
    const col = await this.col<Parcel>("parcels");
    if (await col.findOne({ deviceId: parcel.deviceId, status: { $ne: "delivered" } } as never)) return false;
    await col.insertOne({ _id: parcel.id, ...parcel } as never);
    return true;
  }
  async getParcel(id: string) {
    return strip<Parcel>(await (await this.col<Parcel>("parcels")).findOne({ _id: id } as never));
  }
  async listParcels(orgId: string) {
    const rows = await (await this.col<Parcel>("parcels")).find({ orgId } as never).sort({ createdAt: -1 }).toArray();
    return rows.map((d) => strip<Parcel>(d)!);
  }
  mutateParcel(id: string, fn: (p: Parcel) => Parcel | undefined) {
    return this.mutate<Parcel>("parcels", id, fn);
  }

  async putClaim(claim: Claim) {
    await (await this.col<Claim>("claims")).replaceOne({ _id: claim.id } as never, { _id: claim.id, _v: 0, ...claim } as never, { upsert: true });
  }
  async getClaim(id: string) {
    return strip<Claim>(await (await this.col<Claim>("claims")).findOne({ _id: id } as never));
  }
  async listClaims(orgId: string) {
    const rows = await (await this.col<Claim>("claims")).find({ orgId } as never).sort({ filedAt: -1 }).toArray();
    return rows.map((d) => strip<Claim>(d)!);
  }
  mutateClaim(id: string, fn: (c: Claim) => Claim | undefined) {
    return this.mutate<Claim>("claims", id, fn);
  }

  private async mutate<T extends { [k: string]: unknown }>(name: string, id: string, fn: (v: T) => T | undefined): Promise<T | undefined> {
    const col = await this.col<T>(name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const cur = await col.findOne({ _id: id } as never);
      if (!cur) return undefined;
      const before = strip<T>(cur as never)!;
      const next = fn(before);
      if (next === undefined) return before;
      const v = (cur as { _v?: number })._v ?? 0;
      const res = await col.replaceOne(
        { _id: id, $or: [{ _v: v }, ...(v === 0 ? [{ _v: { $exists: false } }] : [])] } as never,
        { ...next, _id: id, _v: v + 1 } as never,
      );
      if (res.modifiedCount === 1) return next;
    }
    throw new Error("Too much contention updating this record. Try again.");
  }

  async getSecret() {
    const col = await this.col<{ value: string }>("meta");
    const found = await col.findOne({ _id: "secret" } as never);
    if (found) return found.value;
    const value = randomBytes(32).toString("base64url");
    try {
      await col.insertOne({ _id: "secret", value } as never);
      return value;
    } catch (e) {
      if (!isDup(e)) throw e;
      return (await col.findOne({ _id: "secret" } as never))!.value;
    }
  }
}
