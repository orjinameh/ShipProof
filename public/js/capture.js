import {
  generateDeviceKey, publicKeyRaw, deviceIdFor, signReading, toMilliG, magnitudeG, isShock,
  pickRepresentative, b64, signText, SHOCK_HIGH_G, SHOCK_LOW_G,
} from "/js/proto.js";
import { loadDeviceKey, saveDeviceKey, saveReading, deleteReadings, loadOutbox } from "/js/idb.js";

const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FLUSH_MS = 3000;
const BATCH = 50;
const TRACE_SECONDS = 20;
const FRAME_MS = 16; // one sample is about 16 ms at 60 Hz

const el = {
  parcel: $("parcel"), arm: $("arm"), status: $("status"), scope: $("scope"), scopeOff: $("scopeOff"), force: $("force"),
  fMotion: $("fMotion"), fLoc: $("fLoc"), fUp: $("fUp"), fShock: $("fShock"), fWake: $("fWake"), fDev: $("fDev"), watch: $("watch"),
};

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const S = {
  armed: false, key: null, deviceId: null, pubB64: null, keyPersisted: true, registered: false,
  parcelId: null, samples: [], trace: [], lastTs: 0, fix: null, geoWatch: null,
  sent: 0, rejected: 0, waiting: 0, shocks: 0, lastError: "", wake: null,
  motionCount: 0, ffStart: 0, ffLast: 0, ffMax: 0, rate: 0, rateAt: 0, timers: [], flushing: false, raf: 0,
};

function say(msg, bad = false) {
  el.status.textContent = msg;
  el.status.classList.toggle("bad", bad);
}

// ---------- device key ----------

async function initKey() {
  try {
    const saved = await loadDeviceKey();
    if (saved && saved.privateKey && saved.publicRaw) {
      S.key = saved.privateKey;
      S.pubB64 = b64(saved.publicRaw);
      S.deviceId = await deviceIdFor(saved.publicRaw);
      el.fDev.textContent = S.deviceId;
      return;
    }
  } catch { /* storage unavailable, fall through to a fresh in-memory key */ }
  const pair = await generateDeviceKey();
  const raw = await publicKeyRaw(pair.publicKey);
  S.key = pair.privateKey;
  S.pubB64 = b64(raw);
  S.deviceId = await deviceIdFor(raw);
  try {
    await saveDeviceKey({ privateKey: pair.privateKey, publicRaw: raw });
  } catch {
    S.keyPersisted = false;
  }
  el.fDev.textContent = S.deviceId + (S.keyPersisted ? "" : " (key will be lost if this page reloads)");
}

async function register() {
  const res = await fetch("/api/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: S.deviceId, publicKey: S.pubB64 }),
  });
  if (res.ok || res.status === 409) {
    S.registered = true;
    return true;
  }
  throw new Error("Registration failed (" + res.status + ")");
}

// ---------- sensors ----------

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null || a.z == null) return;
  const ax = toMilliG(a.x, isIOS), ay = toMilliG(a.y, isIOS), az = toMilliG(a.z, isIOS);
  const now = Date.now();
  S.samples.push({ ax, ay, az });
  // free fall: an unbroken run of samples at or below 0.3 g; its length gives the drop height
  if (magnitudeG(ax, ay, az) <= SHOCK_LOW_G) {
    if (!S.ffStart) S.ffStart = now;
    S.ffLast = now;
  } else if (S.ffStart) {
    S.ffMax = Math.max(S.ffMax, S.ffLast - S.ffStart + FRAME_MS);
    S.ffStart = 0;
  }
  S.trace.push({ t: now, g: magnitudeG(ax, ay, az) });
  const cutoff = now - TRACE_SECONDS * 1000;
  while (S.trace.length && S.trace[0].t < cutoff) S.trace.shift();
  S.motionCount++;
}

function startLocation() {
  if (!("geolocation" in navigator)) {
    el.fLoc.textContent = "This browser has no location. Recording without it.";
    return;
  }
  el.fLoc.textContent = "Waiting for a fix";
  S.geoWatch = navigator.geolocation.watchPosition(
    (p) => {
      S.fix = { latE6: Math.round(p.coords.latitude * 1e6), lonE6: Math.round(p.coords.longitude * 1e6), at: Date.now() };
      el.fLoc.textContent = "Fix within " + Math.round(p.coords.accuracy) + " m";
    },
    (err) => {
      S.fix = null;
      el.fLoc.textContent = err.code === 1 ? "Blocked. Recording without location." : "No fix yet. Recording without location.";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
  );
}

async function holdScreen() {
  try {
    if (!("wakeLock" in navigator)) throw new Error("unsupported");
    S.wake = await navigator.wakeLock.request("screen");
    el.fWake.textContent = "Kept on while recording";
  } catch {
    el.fWake.textContent = "Can't keep it on. Don't lock the phone.";
  }
}

// ---------- one signed reading per second ----------

async function tick() {
  if (!S.armed || !S.samples.length) return;
  const pick = pickRepresentative(S.samples);
  S.samples = [];
  let ts = Math.floor(Date.now() / 1000);
  if (ts <= S.lastTs) ts = S.lastTs + 1;
  S.lastTs = ts;

  const g = magnitudeG(pick.ax, pick.ay, pick.az);
  // longest fall since the last reading, counting one still in progress
  let ff = S.ffMax;
  if (S.ffStart) { ff = Math.max(ff, S.ffLast - S.ffStart + FRAME_MS); S.ffStart = S.ffLast; } // carry a running fall into the next second
  S.ffMax = 0;
  ff = ff >= 50 ? Math.min(60000, Math.round(ff)) : 0;
  const reading = { v: 2, ff, deviceId: S.deviceId, parcelId: S.parcelId, ts, ax: pick.ax, ay: pick.ay, az: pick.az, shock: isShock(g) ? 1 : 0 };
  if (S.fix && Date.now() - S.fix.at < 30000) {
    reading.latE6 = S.fix.latE6;
    reading.lonE6 = S.fix.lonE6;
  }
  const signed = await signReading(S.key, reading);
  if (signed.shock) S.shocks++;
  if (ff >= 100) say("Fall detected: about " + Math.round(0.5 * 9.81 * (ff / 1000) ** 2 * 100) + " cm (" + ff + " ms in the air).");
  try { await saveReading(signed); } catch { /* keep going from memory below */ }
  outboxMemory.push(signed);
  render();
}

const outboxMemory = []; // used only when IndexedDB is unavailable

async function pending() {
  try {
    const rows = await loadOutbox();
    return rows.map((r) => r.reading);
  } catch {
    return outboxMemory.slice();
  }
}

async function flush() {
  if (S.flushing) return;
  S.flushing = true;
  try {
    const queue = (await pending()).slice(0, BATCH);
    S.waiting = (await pending()).length;
    if (!queue.length) return;
    if (!S.registered) await register();

    const res = await fetch("/api/readings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ readings: queue }),
    });
    if (!res.ok) throw new Error("Server said " + res.status);
    const body = await res.json();
    const done = [];
    let needsRegister = false;
    body.results.forEach((r) => {
      const item = queue[r.index];
      if (r.status === "accepted" || r.status === "duplicate") {
        done.push(item);
        S.sent++;
      } else if (r.error === "unknown device") {
        needsRegister = true; // keep it, register again, retry next time
      } else {
        done.push(item);
        S.rejected++;
        S.lastError = r.error;
      }
    });
    if (needsRegister) S.registered = false;
    try { await deleteReadings(done.map((r) => `${r.parcelId}|${r.ts}`)); } catch { /* ignore */ }
    for (const r of done) {
      const i = outboxMemory.findIndex((m) => m.parcelId === r.parcelId && m.ts === r.ts);
      if (i >= 0) outboxMemory.splice(i, 1);
    }
    S.waiting = (await pending()).length;
    S.lastError = S.lastError || "";
    if (!S.rejected) say(S.armed ? "Recording. Readings are being signed and sent." : "Stopped.");
  } catch (e) {
    S.waiting = (await pending()).length;
    say("Can't reach the server. " + S.waiting + " readings are saved on this phone and will be sent when it's back.", true);
  } finally {
    S.flushing = false;
    render();
  }
}

// ---------- arm and stop ----------

async function arm() {
  // The tag doesn't need to know the parcel: the company assigns it. The reference is only a label.
  const id = el.parcel.value.trim() || "tag";
  if (!ID_RE.test(id)) {
    say("The reference can use letters, numbers, dashes or underscores.", true);
    el.parcel.focus();
    return;
  }
  if (typeof DeviceMotionEvent === "undefined") {
    say("This browser can't read motion sensors. Open this page on a phone.", true);
    return;
  }
  // iOS asks for permission and needs it inside the tap that started this.
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    let result;
    try { result = await DeviceMotionEvent.requestPermission(); } catch { result = "denied"; }
    if (result !== "granted") {
      say("Motion access was blocked. On iPhone, allow Motion & Orientation for Safari in Settings, then reload.", true);
      return;
    }
  }
  S.parcelId = id;
  try { localStorage.setItem("shipproof.parcel", id); } catch { /* ignore */ }
  S.armed = true;
  S.samples = [];
  S.trace = [];
  S.shocks = 0;
  S.motionCount = 0;
  S.rateAt = Date.now();
  el.parcel.disabled = true;
  el.arm.textContent = "Stop recording";
  el.arm.classList.add("live");
  el.scopeOff.hidden = true;
  say("Recording. Readings are being signed and sent.");
  el.watch.innerHTML = "";
  const link = document.createElement("a");
  link.href = "/parcel/" + encodeURIComponent(id);
  link.textContent = "Watch this parcel on the dashboard";
  el.watch.append(link);

  window.addEventListener("devicemotion", onMotion);
  startLocation();
  holdScreen();
  S.timers.push(setInterval(tick, 1000), setInterval(flush, FLUSH_MS), setInterval(updateRate, 1000));
  setTimeout(() => {
    if (S.armed && S.motionCount === 0) {
      say("No motion data is arriving. This device may not have motion sensors, or the browser is blocking them.", true);
    }
  }, 2500);
  S.raf = requestAnimationFrame(drawScope);
  flush();
}

async function stop() {
  S.armed = false;
  window.removeEventListener("devicemotion", onMotion);
  S.timers.forEach(clearInterval);
  S.timers = [];
  if (S.geoWatch != null) navigator.geolocation.clearWatch(S.geoWatch);
  S.geoWatch = null;
  try { await S.wake?.release(); } catch { /* ignore */ }
  S.wake = null;
  cancelAnimationFrame(S.raf);
  el.parcel.disabled = false;
  el.arm.textContent = "Arm recorder";
  el.arm.classList.remove("live");
  el.scopeOff.hidden = false;
  el.scopeOff.textContent = "Stopped. Arm the recorder to start again.";
  el.force.textContent = "-";
  el.fMotion.textContent = "Stopped";
  el.fWake.textContent = "Not locked on";
  await flush();
  say(S.waiting ? S.waiting + " readings are still saved on this phone and will send when you open this page with a connection." : "Stopped. Everything was sent.");
  drawScope();
}

function updateRate() {
  const now = Date.now();
  const dt = (now - S.rateAt) / 1000;
  S.rate = dt > 0 ? Math.round(S.motionCount / dt) : 0;
  S.motionCount = 0;
  S.rateAt = now;
  el.fMotion.textContent = S.rate ? S.rate + " samples per second" : "No motion data yet";
}

document.addEventListener("visibilitychange", () => {
  if (S.armed && document.visibilityState === "visible" && !S.wake) holdScreen();
});
window.addEventListener("online", () => flush());

// ---------- display ----------

function render() {
  const parts = ["Sent " + S.sent];
  if (S.waiting) parts.push("waiting " + S.waiting);
  if (S.rejected) parts.push("rejected " + S.rejected + (S.lastError ? " (" + S.lastError + ")" : ""));
  el.fUp.textContent = S.sent || S.waiting || S.rejected ? parts.join(", ") : "Nothing recorded yet";
  el.fUp.classList.toggle("bad", S.rejected > 0);
  el.fShock.textContent = String(S.shocks);
}

function drawScope() {
  const c = el.scope;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue("--line").trim(), text = css.getPropertyValue("--text").trim();
  const shock = css.getPropertyValue("--shock").trim(), muted = css.getPropertyValue("--muted").trim();
  const yMax = 4, top = 16, bottom = h - 14;
  const y = (v) => bottom - (Math.min(v, yMax) / yMax) * (bottom - top);

  g.font = "12px -apple-system, Inter, system-ui, sans-serif";
  g.textBaseline = "middle";
  for (let v = 1; v <= 3; v++) {
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke();
    g.fillStyle = muted;
    g.textAlign = "right";
    g.fillText(v + " g", w - 8, y(v) - 8);
  }
  g.globalAlpha = 0.09; g.fillStyle = shock; g.fillRect(0, top, w, y(SHOCK_HIGH_G) - top);
  g.globalAlpha = 0.7; g.strokeStyle = shock; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y(SHOCK_HIGH_G)); g.lineTo(w, y(SHOCK_HIGH_G)); g.stroke();
  g.globalAlpha = 1;

  if (S.armed && S.trace.length > 1) {
    const now = Date.now(), span = TRACE_SECONDS * 1000;
    const x = (t) => w - ((now - t) / span) * w;
    g.strokeStyle = text; g.lineWidth = 1.6; g.lineJoin = "round";
    g.beginPath();
    S.trace.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.g)) : g.moveTo(x(p.t), y(p.g))));
    g.stroke();
    g.fillStyle = shock;
    for (const p of S.trace) if (p.g >= SHOCK_HIGH_G) { g.beginPath(); g.arc(x(p.t), y(p.g), 3, 0, 7); g.fill(); }
    const last = S.trace[S.trace.length - 1];
    el.force.textContent = last.g.toFixed(2);
  }
  if (S.armed) S.raf = requestAnimationFrame(drawScope);
}

// ---------- pairing ----------

async function pairWithCompany(token) {
  const box = $("pairBox");
  box.hidden = false;
  box.textContent = "Linking this phone to your company...";
  try {
    await register();
    const signature = await signText(S.key, `pair|${token}|${S.deviceId}`);
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, deviceId: S.deviceId, publicKey: S.pubB64, signature }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || "Pairing failed (" + res.status + ")");
    box.classList.add("ok");
    box.textContent = "Linked to " + body.org.name + ". You can arm the recorder now, or close this page and come back to it later.";
    history.replaceState(null, "", "/capture"); // the one-time code shouldn't stay in the address bar
  } catch (e) {
    box.classList.add("bad");
    box.textContent = e.message;
  }
}

// ---------- start ----------

addEventListener("themechange", () => drawScope());
(async function init() {
  const q = new URLSearchParams(location.search).get("parcel");
  let remembered = "";
  try { remembered = localStorage.getItem("shipproof.parcel") || ""; } catch { /* ignore */ }
  el.parcel.value = ID_RE.test(q || "") ? q : remembered;
  const pairToken = new URLSearchParams(location.search).get("pair");
  el.arm.addEventListener("click", () => (S.armed ? stop() : arm()));
  drawScope();
  try {
    await initKey();
  } catch {
    el.fDev.textContent = "This browser can't create the signing key it needs.";
    el.arm.disabled = true;
    say("Signing isn't available in this browser, so recording is turned off. Use a current version of Safari or Chrome over HTTPS.", true);
    return;
  }
  if (pairToken) await pairWithCompany(pairToken);
  // Readings left over from an earlier session go out first.
  flush();
})();
