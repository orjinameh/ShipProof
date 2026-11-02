import { promises as fs } from "node:fs";
import path from "node:path";
import type { Reading } from "./reading.ts";

export interface Device {
  deviceId: string;
  publicKey: string; // base64 raw uncompressed P-256 point
  registeredAt: number; // unix seconds
}

export interface Store {
  getDevice(deviceId: string): Promise<Device | undefined>;
  putDevice(device: Device): Promise<void>;
  /** Returns true if stored, false if an identical reading was already there. */
  addReading(reading: Reading): Promise<boolean>;
  listReadings(parcelId: string): Promise<Reading[]>;
}

interface Data {
  devices: Record<string, Device>;
  readings: Record<string, Reading>; // key: deviceId|parcelId|ts
}

/**
 * Local development store: one JSON file on disk. Real data only, starts empty.
 * NOT suitable for serverless hosting (the filesystem there is not persistent):
 * implement the Store interface against a real database before deploying.
 */
export class FileStore implements Store {
  private file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file = path.join(process.cwd(), "data", "store.json")) {
    this.file = file;
  }

  private async load(): Promise<Data> {
    try {
      return JSON.parse(await fs.readFile(this.file, "utf8")) as Data;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { devices: {}, readings: {} };
      }
      throw e;
    }
  }

  private async save(data: Data): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data));
    await fs.rename(tmp, this.file);
  }

  /** Serialize all operations so concurrent requests cannot clobber each other. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  getDevice(deviceId: string) {
    return this.run(async () => (await this.load()).devices[deviceId]);
  }

  putDevice(device: Device) {
    return this.run(async () => {
      const data = await this.load();
      data.devices[device.deviceId] = device;
      await this.save(data);
    });
  }

  addReading(reading: Reading) {
    return this.run(async () => {
      const data = await this.load();
      const key = `${reading.deviceId}|${reading.parcelId}|${reading.ts}`;
      if (data.readings[key]) return false;
      data.readings[key] = reading;
      await this.save(data);
      return true;
    });
  }

  listReadings(parcelId: string) {
    return this.run(async () => {
      const data = await this.load();
      return Object.values(data.readings)
        .filter((r) => r.parcelId === parcelId)
        .sort((a, b) => a.ts - b.ts);
    });
  }
}

let singleton: Store | undefined;
export function getStore(): Store {
  singleton ??= new FileStore();
  return singleton;
}
