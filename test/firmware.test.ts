import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { handleApi, type ApiContext } from "../lib/api.ts";
import { FileStore } from "../lib/store.ts";
import { LoginLimiter } from "../lib/auth.ts";
import { deviceIdFor } from "../public/js/proto.js";

// These tests run the real tag firmware core (the same C++ the board runs) on this computer.
// Build it first:  UECC_DIR=/path/to/micro-ecc firmware/host/build.sh
const BIN = path.resolve("firmware/host/tagsim");
const have = existsSync(BIN);

function tag() {
  const p = spawn(BIN);
  let buf = ""; const waiting: ((l: string) => void)[] = [];
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); waiting.shift()?.(l); } });
  const send = (line: string) => new Promise<string>((res) => { waiting.push(res); p.stdin.write(line + "\n"); });
  return { send, close: () => p.kill() };
}

const T0 = 1_800_000_000;
function ctxFor() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-"));
  const ctx: ApiContext = { store: new FileStore(path.join(dir, "s.json")), secret: "s", serv: { baseUrl: "http://127.0.0.1:1/v1", model: "m", shadowAgent: false, timeoutMs: 1000 }, now: () => (T0 + 100) * 1000, appealHours: 48, limiter: new LoginLimiter() };
  return ctx;
}
const post = (ctx: ApiContext, url: string, body: unknown) =>
  handleApi(new Request("http://x" + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx).then(async (r) => ({ status: r.status, json: await r.json() }));

async function provisioned() {
  const t = tag();
  const kp = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = kp.privateKey.export({ format: "jwk" });
  const dHex = Buffer.from(jwk.d!, "base64url").toString("hex");
  const rawPub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
  assert.equal(await t.send(`T ${T0}`), "OK");
  const pub = await t.send(`KEY ${dHex}`);
  return { t, rawPub, pub, dHex };
}

test("tag reports the public key we generated, and the device id derives from it", { skip: !have && "build firmware/host/tagsim first" }, async () => {
  const { t, rawPub, pub } = await provisioned();
  assert.equal(pub, "PUB " + rawPub.toString("base64"));
  const info = await t.send("INFO");
  assert.equal(info.split(" ")[1], await deviceIdFor(new Uint8Array(rawPub)));
  t.close();
});

test("a reading signed by the firmware is accepted by the server; tampering is not", { skip: !have && "build firmware/host/tagsim first" }, async () => {
  const { t, rawPub } = await provisioned();
  const deviceId = await deviceIdFor(new Uint8Array(rawPub));
  const ctx = ctxFor();
  assert.equal((await post(ctx, "/api/devices", { deviceId, publicKey: rawPub.toString("base64") })).status, 201);
  // calm samples, one hard hit, then a window close at 5 s
  for (let i = 0; i < 20; i++) await t.send(`S 0 0 1000 ${i * 20}`);
  await t.send("S 300 -100 3200 420");
  await t.send("S 0 0 1000 440");
  const line = await t.send("E 5000");
  const r = JSON.parse(line);
  assert.equal(r.deviceId, deviceId);
  assert.equal(r.ts, T0 + 5);
  assert.equal(r.v, 2);
  assert.equal(r.snd, undefined); // no sound sensor fitted
  assert.equal(r.ff, 0);
  assert.deepEqual([r.ax, r.ay, r.az, r.shock], [300, -100, 3200, 1]); // the hit is the sample reported, and flagged
  const ok = await post(ctx, "/api/readings", r);
  assert.equal(ok.json.accepted, 1, JSON.stringify(ok.json));
  assert.equal((await post(ctx, "/api/readings", { ...r, az: 1000 })).json.rejected, 1);
  t.close();
});

test("the reading reports the sample furthest from 1 g, so a tilt is not lost", { skip: !have && "build firmware/host/tagsim first" }, async () => {
  const { t } = await provisioned();
  await t.send("S 0 0 1000 0"); await t.send("S 600 0 600 20"); await t.send("S 0 0 1050 40"); // 848 mg and 1050 mg: the tilted one is 152 away from 1 g
  const r = JSON.parse(await t.send("E 5000"));
  assert.deepEqual([r.ax, r.az, r.shock], [600, 600, 0]);
  t.close();
});

test("bad commands, a second key, a wrong clock and an empty window are all refused", { skip: !have && "build firmware/host/tagsim first" }, async () => {
  const { t, dHex } = await provisioned();
  assert.match(await t.send(`KEY ${dHex}`), /^ERR key already set/);
  assert.match(await t.send("T 12"), /^ERR time/);
  assert.match(await t.send("PARCEL bad label!"), /^ERR label/);
  assert.equal(await t.send("PARCEL shelf-7"), "OK");
  assert.equal(await t.send("E 5000"), "NOEMIT"); // no samples yet
  assert.equal(await t.send("WIPE"), "OK");
  assert.equal(await t.send("INFO"), "INFO nokey");
  t.close();
});

test("firmware free-fall time and sound level are signed and reach the evidence", { skip: !have && "build firmware/host/tagsim first" }, async () => {
  const { t, rawPub } = await provisioned();
  const deviceId = await deviceIdFor(new Uint8Array(rawPub));
  const ctx = ctxFor();
  await post(ctx, "/api/devices", { deviceId, publicKey: rawPub.toString("base64") });
  // 25 samples at 20 ms in free fall = 500 ms, about 1.2 m, then a hard landing
  for (let i = 0; i < 10; i++) await t.send(`S 0 0 1000 ${i * 20}`);
  for (let i = 0; i < 25; i++) await t.send(`S 20 10 40 ${200 + i * 20}`);
  await t.send("S 100 0 3400 700");
  await t.send("N 30"); await t.send("N 85"); await t.send("N 10");
  const r = JSON.parse(await t.send("E 5000"));
  assert.deepEqual([r.v, r.ff, r.snd], [2, 500, 85]);
  assert.equal((await post(ctx, "/api/readings", r)).json.accepted, 1);
  assert.equal((await post(ctx, "/api/readings", { ...r, ff: 50 })).json.rejected, 1); // tampered fall time
  assert.equal((await post(ctx, "/api/readings", { ...r, snd: 5, ts: r.ts + 1 })).json.rejected, 1); // sound changed after signing
  // the next window starts clean: no sound sensor value carried over
  await t.send("S 0 0 1000 5100"); await t.send("N 0");
  const r2 = JSON.parse(await t.send("E 10000"));
  assert.deepEqual([r2.ff, r2.snd], [0, 0]);
  t.close();
});
