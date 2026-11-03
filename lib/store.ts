import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Reading } from "./reading.ts";
import type { Claim, Org, Parcel, Tag, User } from "./types.ts";

export interface Device {
  deviceId: string;
  publicKey: string; // base64 raw uncompressed P-256 point
  registeredAt: number; // unix seconds
}

export interface Store {
  // devices and readings (written by tags, checked by signature)
  getDevice(deviceId: string): Promise<Device | undefined>;
  putDevice(device: Device): Promise<void>;
  /** Returns true if stored, false if an identical reading was already there. */
  addReading(reading: Reading): Promise<boolean>;
  listReadings(parcelId: string): Promise<Reading[]>;
  listReadingsByDevice(deviceId: string, fromTs: number, toTs: number): Promise<Reading[]>;

  // companies
  /** Creates the company and its first user together. False if the email is already used. */
  createAccount(org: Org, user: User): Promise<boolean>;
  getUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  getOrg(id: string): Promise<Org | undefined>;

  // tags a company has claimed
  getTag(deviceId: string): Promise<Tag | undefined>;
  /** "owned" if another company already holds this device. */
  claimTag(tag: Tag): Promise<"ok" | "owned">;
  listTags(orgId: string): Promise<Tag[]>;

  // parcels
  /** False if the device already has a parcel that is not delivered yet. */
  createParcel(parcel: Parcel): Promise<boolean>;
  getParcel(id: string): Promise<Parcel | undefined>;
  listParcels(orgId: string): Promise<Parcel[]>;
  /** Atomic read-modify-write. Return undefined from `fn` to leave the parcel unchanged. */
  mutateParcel(id: string, fn: (p: Parcel) => Parcel | undefined): Promise<Parcel | undefined>;

  // claims
  putClaim(claim: Claim): Promise<void>;
  getClaim(id: string): Promise<Claim | undefined>;
  listClaims(orgId: string): Promise<Claim[]>;
  mutateClaim(id: string, fn: (c: Claim) => Claim | undefined): Promise<Claim | undefined>;

  /** Server secret for signing session cookies, created on first use. */
  getSecret(): Promise<string>;
}

interface Data {
  devices: Record<string, Device>;
  readings: Record<string, Reading>; // key: deviceId|parcelId|ts
  orgs: Record<string, Org>;
  users: Record<string, User>;
  tags: Record<string, Tag>;
  parcels: Record<string, Parcel>;
  claims: Record<string, Claim>;
  secret?: string;
}

const emptyData = (): Data => ({ devices: {}, readings: {}, orgs: {}, users: {}, tags: {}, parcels: {}, claims: {} });

/**
 * Local development store: one JSON file on disk. Real data only, starts empty.
 * Fine for one server with a persistent disk. NOT suitable for serverless hosting
 * (the filesystem there is not persistent): implement the Store interface against a
 * real database before deploying there.
 */
export class FileStore implements Store {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file = path.join(process.cwd(), "data", "store.json")) {
    this.file = file;
  }

  private async load(): Promise<Data> {
    try {
      return { ...emptyData(), ...(JSON.parse(await fs.readFile(this.file, "utf8")) as Partial<Data>) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyData();
      throw e;
    }
  }

  private async save(data: Data): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  /** Serialize all operations so concurrent requests cannot clobber each other. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async update<T>(fn: (data: Data) => { result: T; changed: boolean }): Promise<T> {
    return this.run(async () => {
      const data = await this.load();
      const { result, changed } = fn(data);
      if (changed) await this.save(data);
      return result;
    });
  }

  private read<T>(fn: (data: Data) => T): Promise<T> {
    return this.run(async () => fn(await this.load()));
  }

  // ----- devices and readings

  getDevice(deviceId: string) {
    return this.read((d) => d.devices[deviceId]);
  }

  putDevice(device: Device) {
    return this.update((d) => {
      d.devices[device.deviceId] = device;
      return { result: undefined, changed: true };
    });
  }

  addReading(reading: Reading) {
    return this.update((d) => {
      const key = `${reading.deviceId}|${reading.parcelId}|${reading.ts}`;
      if (d.readings[key]) return { result: false, changed: false };
      d.readings[key] = reading;
      return { result: true, changed: true };
    });
  }

  listReadings(parcelId: string) {
    return this.read((d) =>
      Object.values(d.readings)
        .filter((r) => r.parcelId === parcelId)
        .sort((a, b) => a.ts - b.ts),
    );
  }

  listReadingsByDevice(deviceId: string, fromTs: number, toTs: number) {
    return this.read((d) =>
      Object.values(d.readings)
        .filter((r) => r.deviceId === deviceId && r.ts >= fromTs && r.ts <= toTs)
        .sort((a, b) => a.ts - b.ts),
    );
  }

  // ----- companies

  createAccount(org: Org, user: User) {
    return this.update((d) => {
      if (Object.values(d.users).some((u) => u.email === user.email)) return { result: false, changed: false };
      d.orgs[org.id] = org;
      d.users[user.id] = user;
      return { result: true, changed: true };
    });
  }

  getUserByEmail(email: string) {
    return this.read((d) => Object.values(d.users).find((u) => u.email === email));
  }

  getUser(id: string) {
    return this.read((d) => d.users[id]);
  }

  getOrg(id: string) {
    return this.read((d) => d.orgs[id]);
  }

  // ----- tags

  getTag(deviceId: string) {
    return this.read((d) => d.tags[deviceId]);
  }

  claimTag(tag: Tag) {
    return this.update<"ok" | "owned">((d) => {
      const existing = d.tags[tag.deviceId];
      if (existing && existing.orgId !== tag.orgId) return { result: "owned", changed: false };
      d.tags[tag.deviceId] = existing ? { ...existing, label: tag.label } : tag;
      return { result: "ok", changed: true };
    });
  }

  listTags(orgId: string) {
    return this.read((d) =>
      Object.values(d.tags)
        .filter((t) => t.orgId === orgId)
        .sort((a, b) => a.addedAt - b.addedAt),
    );
  }

  // ----- parcels

  createParcel(parcel: Parcel) {
    return this.update((d) => {
      const busy = Object.values(d.parcels).some((p) => p.deviceId === parcel.deviceId && p.status !== "delivered");
      if (busy) return { result: false, changed: false };
      d.parcels[parcel.id] = parcel;
      return { result: true, changed: true };
    });
  }

  getParcel(id: string) {
    return this.read((d) => d.parcels[id]);
  }

  listParcels(orgId: string) {
    return this.read((d) =>
      Object.values(d.parcels)
        .filter((p) => p.orgId === orgId)
        .sort((a, b) => b.createdAt - a.createdAt),
    );
  }

  mutateParcel(id: string, fn: (p: Parcel) => Parcel | undefined) {
    return this.update((d) => {
      const current = d.parcels[id];
      if (!current) return { result: undefined, changed: false };
      const next = fn(current);
      if (!next) return { result: current, changed: false };
      d.parcels[id] = next;
      return { result: next, changed: true };
    });
  }

  // ----- claims

  putClaim(claim: Claim) {
    return this.update((d) => {
      d.claims[claim.id] = claim;
      return { result: undefined, changed: true };
    });
  }

  getClaim(id: string) {
    return this.read((d) => d.claims[id]);
  }

  listClaims(orgId: string) {
    return this.read((d) =>
      Object.values(d.claims)
        .filter((c) => c.orgId === orgId)
        .sort((a, b) => b.filedAt - a.filedAt),
    );
  }

  mutateClaim(id: string, fn: (c: Claim) => Claim | undefined) {
    return this.update((d) => {
      const current = d.claims[id];
      if (!current) return { result: undefined, changed: false };
      const next = fn(current);
      if (!next) return { result: current, changed: false };
      d.claims[id] = next;
      return { result: next, changed: true };
    });
  }

  // ----- secret

  getSecret() {
    return this.update((d) => {
      if (d.secret) return { result: d.secret, changed: false };
      d.secret = randomBytes(32).toString("base64url");
      return { result: d.secret, changed: true };
    });
  }
}

let singleton: Store | undefined;
export async function getStore(): Promise<Store> {
  if (!singleton) {
    if (process.env.MONGODB_URI) {
      // Imported on demand so local development without MongoDB never loads the driver.
      const { MongoStore } = await import("./mongo-store.ts");
      singleton = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || "shipproof");
    } else {
      singleton = new FileStore();
    }
  }
  return singleton;
}
