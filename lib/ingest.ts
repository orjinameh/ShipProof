import { parseReading } from "./reading.ts";
import { verifyReading } from "./verify.ts";
import type { Store } from "./store.ts";

export type ItemResult =
  | { index: number; status: "accepted" | "duplicate" }
  | { index: number; status: "rejected"; error: string };

/** Readings stamped further than this into the future are rejected (clock errors). */
export const MAX_FUTURE_SECONDS = 300;
export const MAX_BATCH = 200;

export async function ingestReadings(
  store: Store,
  items: unknown[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (let index = 0; index < items.length; index++) {
    const parsed = parseReading(items[index]);
    if (!parsed.ok) {
      results.push({ index, status: "rejected", error: parsed.error });
      continue;
    }
    const reading = parsed.reading;
    if (reading.ts > nowSeconds + MAX_FUTURE_SECONDS) {
      results.push({ index, status: "rejected", error: "timestamp in the future" });
      continue;
    }
    const device = await store.getDevice(reading.deviceId);
    if (!device) {
      results.push({ index, status: "rejected", error: "unknown device" });
      continue;
    }
    if (!verifyReading(reading, device.publicKey)) {
      results.push({ index, status: "rejected", error: "bad signature" });
      continue;
    }
    const stored = await store.addReading(reading);
    results.push({ index, status: stored ? "accepted" : "duplicate" });
  }
  return results;
}
