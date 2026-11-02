import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { canonicalString, parseReading, type Reading } from "../lib/reading.ts";
import { verifyReading } from "../lib/verify.ts";
import { FileStore } from "../lib/store.ts";
import { ingestReadings } from "../lib/ingest.ts";

const subtle = webcrypto.subtle;

/** Real P-256 keypair, the same primitive the phone page (WebCrypto) will use. */
async function makeDevice() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = Buffer.from(await subtle.exportKey("raw", pair.publicKey)).toString("base64");
  return { privateKey: pair.privateKey, publicKey: raw };
}

async function sign(
  privateKey: webcrypto.CryptoKey,
  r: Omit<Reading, "sig">,
): Promise<Reading> {
  const data = new TextEncoder().encode(canonicalString(r));
  // WebCrypto returns r||s (64 bytes), the same layout firmware will send.
  const sig = Buffer.from(
    await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data),
  ).toString("base64");
  return { ...r, sig };
}

const base = {
  v: 1 as const,
  deviceId: "tag-001",
  parcelId: "PKG-123",
  ts: 1_762_123_456,
  ax: 20,
  ay: -10,
  az: 981,
  shock: 0 as const,
};

test("canonical string is stable and handles missing GPS", () => {
  assert.equal(canonicalString(base), "v1|tag-001|PKG-123|1762123456|20|-10|981|0||");
  assert.equal(
    canonicalString({ ...base, latE6: 9_057_600, lonE6: 7_491_000 }),
    "v1|tag-001|PKG-123|1762123456|20|-10|981|0|9057600|7491000",
  );
});

test("valid signature verifies; any tampered field fails", async () => {
  const dev = await makeDevice();
  const good = await sign(dev.privateKey, base);
  assert.equal(verifyReading(good, dev.publicKey), true);

  for (const tampered of [
    { ...good, az: 5000 },
    { ...good, shock: 1 as const },
    { ...good, ts: good.ts + 1 },
    { ...good, parcelId: "PKG-999" },
    { ...good, latE6: 1, lonE6: 1 },
  ]) {
    assert.equal(verifyReading(tampered, dev.publicKey), false);
  }
});

test("signature from a different key is rejected", async () => {
  const a = await makeDevice();
  const b = await makeDevice();
  const signedByA = await sign(a.privateKey, base);
  assert.equal(verifyReading(signedByA, b.publicKey), false);
});

test("parseReading rejects malformed input", () => {
  assert.equal(parseReading(null).ok, false);
  assert.equal(parseReading({ ...base, sig: "x", ax: 1.5 }).ok, false);
  assert.equal(parseReading({ ...base, sig: "x", deviceId: "bad id!" }).ok, false);
  assert.equal(parseReading({ ...base, sig: "x", latE6: 1 }).ok, false);
  assert.equal(parseReading({ ...base, sig: "x", shock: 2 }).ok, false);
  assert.equal(parseReading({ ...base, sig: "x" }).ok, true);
});

test("ingest: accepts valid, dedupes, rejects bad signature, unknown device, future ts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "shipproof-"));
  try {
    const store = new FileStore(path.join(dir, "store.json"));
    const dev = await makeDevice();
    await store.putDevice({ deviceId: "tag-001", publicKey: dev.publicKey, registeredAt: 1 });

    // Empty store reports no readings (real empty state, nothing invented).
    assert.deepEqual(await store.listReadings("PKG-123"), []);

    const now = base.ts + 10;
    const r1 = await sign(dev.privateKey, base);
    const r2 = await sign(dev.privateKey, { ...base, ts: base.ts + 1, shock: 1, az: 4200 });
    const forged = { ...r2, ts: base.ts + 2 }; // signature no longer matches
    const stranger = await sign(dev.privateKey, { ...base, deviceId: "tag-999" });
    const future = await sign(dev.privateKey, { ...base, ts: now + 100_000 });

    const results = await ingestReadings(
      store,
      [r1, r2, r1, forged, stranger, future, { nonsense: true }],
      now,
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ["accepted", "accepted", "duplicate", "rejected", "rejected", "rejected", "rejected"],
    );
    assert.deepEqual(
      results.filter((r) => r.status === "rejected").map((r) => (r as { error: string }).error),
      ["bad signature", "unknown device", "timestamp in the future", "unsupported version"],
    );

    const stored = await store.listReadings("PKG-123");
    assert.deepEqual(stored.map((r) => r.ts), [base.ts, base.ts + 1]);
    assert.equal(stored[1].shock, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
