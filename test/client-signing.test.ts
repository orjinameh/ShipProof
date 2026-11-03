import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalString as clientCanonical, generateDeviceKey, publicKeyRaw, deviceIdFor, signReading,
  toMilliG, isShock, pickRepresentative, b64,
} from "../public/js/proto.js";
import { canonicalString as serverCanonical, parseReading } from "../lib/reading.ts";
import { verifyReading } from "../lib/verify.ts";

test("browser and server build the same canonical string", () => {
  const withGps = { v: 1, deviceId: "ph-aa", parcelId: "P1", ts: 1700000000, ax: -12, ay: 5, az: 998, shock: 1, latE6: 9057600, lonE6: 7491000 };
  const noGps = { v: 1, deviceId: "ph-aa", parcelId: "P1", ts: 1700000000, ax: 0, ay: 0, az: 1000, shock: 0 };
  assert.equal(clientCanonical(withGps), serverCanonical(withGps as never));
  assert.equal(clientCanonical(noGps), serverCanonical(noGps as never));
});

test("a reading signed by the browser module passes the server's verification", async () => {
  const pair = await generateDeviceKey();
  const raw = await publicKeyRaw(pair.publicKey);
  const deviceId = await deviceIdFor(raw);
  assert.match(deviceId, /^ph-[0-9a-f]{12}$/);

  const signed = await signReading(pair.privateKey, {
    v: 1, deviceId, parcelId: "PKG-123", ts: 1762123456, ax: 31, ay: -8, az: 987, shock: 0, latE6: 9076500, lonE6: 7398600,
  });
  const parsed = parseReading(signed);
  assert.equal(parsed.ok, true);
  assert.equal(verifyReading(signed as never, b64(raw)), true);
  assert.equal(verifyReading({ ...(signed as object), ax: 32 } as never, b64(raw)), false);
});

test("the private key cannot be exported", async () => {
  const pair = await generateDeviceKey();
  await assert.rejects(() => crypto.subtle.exportKey("pkcs8", pair.privateKey));
});

test("unit conversion, shock rule and representative sample", () => {
  assert.equal(toMilliG(9.80665, false), 1000);
  assert.equal(toMilliG(9.80665, true), -1000);
  assert.equal(Object.is(toMilliG(0, true), 0), true); // never -0
  assert.equal(isShock(2.5), true);
  assert.equal(isShock(0.2), true);
  assert.equal(isShock(1.2), false);
  const rep = pickRepresentative([
    { ax: 0, ay: 0, az: 1000 },
    { ax: 0, ay: 0, az: 3100 },
    { ax: 0, ay: 0, az: 1100 },
  ]);
  assert.equal(rep.az, 3100);
});
