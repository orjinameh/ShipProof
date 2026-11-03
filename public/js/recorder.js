const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POLL_MS = 2000;
let SHOCK_HIGH_G = 2.5; // the parcel's own impact limit when opened from a claim or the console
const GAP_SECONDS = 5; // a longer silence breaks the line instead of drawing across it

const el = {
  form: $("open"), pid: $("pid"), stage: $("stage"), scene: $("scene"), jolt: $("jolt"), orbit: $("orbit"), tilt: $("tilt"),
  wbId: $("wbId"), wbSub: $("wbSub"), barcode: $("barcode"),
  force: $("rdForce"), tiltRd: $("rdTilt"), time: $("rdTime"), boxForce: $("boxForce"), summary: $("summary"),
  chart: $("chart"), scrub: $("scrub"), live: $("live"), onlyShocks: $("onlyShocks"), tStart: $("tStart"), tEnd: $("tEnd"), status: $("status"),
  route: $("route"), routeNote: $("routeNote"), ledger: $("ledger"), empty: $("emptyNote"),
};

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const S = {
  parcelId: null, readings: [], idx: -1, follow: true, seen: new Set(), loaded: false,
  error: null, lastOkAt: 0, ledgerKey: "", onlyShocks: false, yaw: -32, pitch: -22,
  curUp: [0, -1, 0], targetUp: [0, -1, 0], chartHits: [],
};

// ---------- helpers ----------

const gOf = (r) => Math.hypot(r.ax, r.ay, r.az) / 1000;
const keyOf = (r) => r.deviceId + "|" + r.ts;
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour12: false });
const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

function parcelFromUrl() {
  try {
    const m = location.pathname.match(/^\/parcel\/([^/]+)/);
    const id = decodeURIComponent(m ? m[1] : new URLSearchParams(location.search).get("parcel") || "");
    return ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

function ago(seconds) {
  if (seconds < 5) return "just now";
  if (seconds < 90) return Math.round(seconds) + " seconds ago";
  if (seconds < 5400) return Math.round(seconds / 60) + " minutes ago";
  return Math.round(seconds / 3600) + " hours ago";
}

// ---------- data ----------

async function poll() {
  if (!S.parcelId || document.hidden) return;
  try {
    const res = await fetch(S.src || "/api/readings?parcelId=" + encodeURIComponent(S.parcelId), { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) { location.href = "/login?next=" + encodeURIComponent(location.pathname + location.search); return; }
    if (!res.ok) throw new Error("The server answered " + res.status);
    const body = await res.json();
    take(body.readings);
    S.error = null;
    S.lastOkAt = Date.now();
  } catch (e) {
    S.error = e.message || "No connection";
  }
  render();
}

function take(readings) {
  let newShock = false;
  for (const r of readings) {
    const k = keyOf(r);
    if (!S.seen.has(k)) {
      S.seen.add(k);
      if (r.shock && S.loaded) newShock = true;
    }
  }
  S.readings = readings;
  if (!S.loaded && document.body.classList.contains("embed") && readings.length) {
    // Opened inside a claim: start on the hardest hit, because that is what the claim is about.
    let best = 0;
    readings.forEach((r, i) => { if (gOf(r) > gOf(readings[best])) best = i; });
    S.idx = best;
  } else if (S.follow) S.idx = readings.length - 1;
  else S.idx = Math.min(S.idx, readings.length - 1);
  S.loaded = true;
  if (newShock && S.follow) hit();
}

function hit() {
  if (reduceMotion) return;
  el.stage.classList.remove("hit");
  el.jolt.classList.remove("go");
  void el.stage.offsetWidth; // restart the animations
  el.stage.classList.add("hit");
  el.jolt.classList.add("go");
}

// ---------- the parcel ----------

function drawBarcode(id) {
  let seed = 2166136261;
  for (const ch of id) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  let x = 0, out = "";
  while (x < 118) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const w = 1 + (seed % 4);
    if ((seed >> 8) & 1) out += `<rect x="${x}" y="0" width="${w}" height="22" fill="#1c1a15"/>`;
    x += w + 1;
  }
  el.barcode.innerHTML = out;
}

function upVector(r) {
  const m = Math.hypot(r.ax, r.ay, r.az);
  if (m < 200) return null; // free fall: gravity direction is unknown
  // Phone frame to the cube's own frame: x stays, screen-out (z) is the cube's top (-y), phone top (y) points away (-z).
  return [r.ax / m, -r.az / m, -r.ay / m];
}

function rotationTo(u) {
  const t = [0, -1, 0];
  const dot = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
  const axis = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]];
  const len = Math.hypot(...axis);
  if (len < 1e-6) return dot > 0 ? "rotate3d(1,0,0,0deg)" : "rotate3d(1,0,0,180deg)";
  const deg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  return `rotate3d(${axis[0] / len},${axis[1] / len},${axis[2] / len},${deg}deg)`;
}

function frame() {
  const k = reduceMotion ? 1 : 0.16;
  const c = S.curUp, t = S.targetUp;
  for (let i = 0; i < 3; i++) c[i] += (t[i] - c[i]) * k;
  const m = Math.hypot(...c) || 1;
  S.curUp = c.map((v) => v / m);
  el.tilt.style.transform = rotationTo(S.curUp);
  requestAnimationFrame(frame);
}

function setOrbit() {
  el.orbit.style.transform = `rotateX(${S.pitch}deg) rotateY(${S.yaw}deg)`;
}

// ---------- render ----------

function render() {
  const rs = S.readings, n = rs.length;
  const cur = n && S.idx >= 0 ? rs[S.idx] : null;

  el.wbId.textContent = S.parcelId || "No parcel";
  el.wbSub.textContent = S.parcelId ? (cur ? "Signed by " + cur.deviceId : "Waiting for readings") : "Open a parcel ID to begin";

  if (cur) {
    const g = gOf(cur);
    el.force.textContent = g.toFixed(2);
    el.boxForce.classList.toggle("hot", !!cur.shock);
    const up = upVector(cur);
    if (up) {
      S.targetUp = up;
      const off = (Math.acos(Math.max(-1, Math.min(1, -up[1]))) * 180) / Math.PI;
      el.tiltRd.textContent = Math.round(off) + "°";
    } else {
      el.tiltRd.textContent = "In free fall";
    }
    el.time.textContent = clock(cur.ts);
  } else {
    el.force.textContent = "-";
    el.tiltRd.textContent = "-";
    el.time.textContent = "-";
    el.boxForce.classList.remove("hot");
    S.targetUp = [0, -1, 0];
  }

  // summary in plain sentences
  if (!S.parcelId) {
    el.summary.textContent = "Nothing is open. Choose a parcel above.";
  } else if (!n) {
    el.summary.textContent = S.error ? "Can't reach the server yet." : "No readings for this parcel yet.";
  } else {
    const shocks = rs.filter((r) => r.shock).length;
    const devices = new Set(rs.map((r) => r.deviceId)).size;
    const peak = Math.max(...rs.map(gOf));
    const age = Math.max(0, Date.now() / 1000 - rs[n - 1].ts);
    el.summary.innerHTML =
      `<strong>${plural(n, "signed reading", "signed readings")}</strong> from ${plural(devices, "device", "devices")}. ` +
      `${shocks ? `<strong>${plural(shocks, "shock", "shocks")}</strong> flagged by the device.` : "No shocks flagged."} ` +
      `Strongest force ${peak.toFixed(2)} g. Last reading ${ago(age)}.`;
  }

  // status line
  el.status.classList.toggle("bad", !!S.error);
  if (S.error) el.status.textContent = "Can't reach the server (" + S.error + "). Showing the last data received and retrying.";
  else if (S.parcelId) el.status.textContent = "Every reading here was checked against its device's public key before it was stored.";
  else el.status.textContent = "";

  // scrubber and live button
  el.scrub.disabled = n < 2;
  el.scrub.max = String(Math.max(0, n - 1));
  el.scrub.value = String(Math.max(0, S.idx));
  el.live.disabled = n === 0;
  el.live.setAttribute("aria-pressed", String(S.follow));
  el.live.textContent = S.follow ? "Following live" : "Go to latest";
  el.tStart.textContent = n ? clock(rs[0].ts) : "";
  el.tEnd.textContent = n ? clock(rs[n - 1].ts) : "";

  drawChart();
  drawRoute();
  renderLedger();
}

function renderLedger() {
  const rs = S.readings, n = rs.length;
  const key = n + "|" + S.onlyShocks;
  if (key !== S.ledgerKey) {
    S.ledgerKey = key;
    const prev = el.ledger.scrollTop;
    el.ledger.replaceChildren();
    const rows = [];
    for (let i = n - 1; i >= 0 && rows.length < (S.onlyShocks ? 500 : 200); i--) {
      if (!S.onlyShocks || rs[i].shock) rows.push(i);
    }
    for (const i of rows) {
      const r = rs[i];
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.i = String(i);
      if (r.shock) b.classList.add("shock");
      const time = document.createElement("span");
      time.textContent = clock(r.ts);
      const g = document.createElement("span");
      g.className = "g";
      g.textContent = gOf(r).toFixed(2) + " g";
      const where = document.createElement("span");
      where.className = "where";
      if (r.shock) {
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = "Shock";
        where.append(tag);
      }
      where.append(r.latE6 != null ? (r.latE6 / 1e6).toFixed(4) + ", " + (r.lonE6 / 1e6).toFixed(4) : "No location");
      b.append(time, g, where);
      li.append(b);
      el.ledger.append(li);
    }
    el.ledger.scrollTop = S.follow ? 0 : prev;
    S.ledgerRows = rows.length;
  }
  for (const b of el.ledger.querySelectorAll("button")) {
    b.setAttribute("aria-current", String(Number(b.dataset.i) === S.idx));
  }
  if (S.follow && !S.onlyShocks) el.ledger.scrollTop = 0;

  const showList = n > 0 && S.ledgerRows > 0;
  el.ledger.hidden = !showList;
  el.empty.hidden = showList;
  if (showList) return;
  if (!S.parcelId) {
    el.empty.textContent = "Choose a parcel to see its readings.";
  } else if (n > 0) {
    el.empty.textContent = "The device flagged no shocks for this parcel.";
  } else if (S.src) {
    el.empty.textContent = "The tag sent no readings during this parcel's delivery.";
  } else {
    const url = location.origin + "/capture?parcel=" + encodeURIComponent(S.parcelId);
    el.empty.innerHTML = "No readings yet. On a phone, open <a></a> and arm the recorder.";
    const a = el.empty.querySelector("a");
    a.href = url;
    a.textContent = url;
  }
}

// ---------- chart ----------

function drawChart() {
  const c = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  const line = col("--line"), text = col("--text"), muted = col("--muted"), shock = col("--shock"), seal = col("--seal"), kraft = col("--kraft");

  const rs = S.readings;
  const peak = rs.length ? Math.max(...rs.map(gOf)) : 0;
  const yMax = Math.max(3.2, Math.ceil(peak * 2) / 2 + 0.3);
  const pad = { l: 38, r: 10, t: 10, b: 8 };
  const top = pad.t, bottom = h - pad.b;
  const y = (v) => bottom - (v / yMax) * (bottom - top);
  g.font = "12px Barlow, system-ui, sans-serif";
  g.textBaseline = "middle";

  for (let v = 0; v <= yMax; v++) {
    g.strokeStyle = v === 1 ? "#3a5069" : line;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, y(v)); g.lineTo(w - pad.r, y(v)); g.stroke();
    g.fillStyle = muted; g.textAlign = "right";
    g.fillText(v + " g", pad.l - 8, y(v));
  }
  g.setLineDash([5, 5]); g.strokeStyle = shock; g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad.l, y(SHOCK_HIGH_G)); g.lineTo(w - pad.r, y(SHOCK_HIGH_G)); g.stroke();
  g.setLineDash([]);
  g.fillStyle = shock; g.textAlign = "left";
  g.fillText("shock flag", pad.l + 6, y(SHOCK_HIGH_G) - 9);

  if (!rs.length) {
    g.fillStyle = muted; g.textAlign = "center";
    g.fillText(S.parcelId ? "No readings yet" : "Open a parcel to see its force trace", (w + pad.l) / 2, (top + bottom) / 2);
    S.chartHits = [];
    return;
  }

  const t0 = rs[0].ts;
  const span = Math.max(1, rs[rs.length - 1].ts - t0);
  const x = (ts) => pad.l + ((ts - t0) / span) * (w - pad.l - pad.r);
  S.chartHits = rs.map((r) => x(r.ts));

  // area under the trace, per unbroken stretch
  const stretches = [];
  let cur = [];
  rs.forEach((r, i) => {
    if (i && r.ts - rs[i - 1].ts > GAP_SECONDS) { stretches.push(cur); cur = []; }
    cur.push(r);
  });
  stretches.push(cur);

  const grad = g.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, "rgba(201,160,107,0.28)");
  grad.addColorStop(1, "rgba(201,160,107,0)");
  for (const st of stretches) {
    g.beginPath();
    st.forEach((r, i) => (i ? g.lineTo(x(r.ts), y(gOf(r))) : g.moveTo(x(r.ts), y(gOf(r)))));
    g.strokeStyle = kraft; g.lineWidth = 1.8; g.lineJoin = "round"; g.stroke();
    g.lineTo(x(st[st.length - 1].ts), bottom); g.lineTo(x(st[0].ts), bottom); g.closePath();
    g.fillStyle = grad; g.fill();
  }

  // flagged shocks: a stem to the baseline and a dot
  for (const r of rs) {
    if (!r.shock) continue;
    g.strokeStyle = shock; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x(r.ts), bottom); g.lineTo(x(r.ts), y(gOf(r))); g.stroke();
    g.fillStyle = shock;
    g.beginPath(); g.arc(x(r.ts), y(gOf(r)), 4, 0, 7); g.fill();
  }

  // playhead
  if (S.idx >= 0) {
    const r = rs[S.idx];
    g.strokeStyle = seal; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x(r.ts), top); g.lineTo(x(r.ts), bottom); g.stroke();
    g.fillStyle = ink(css); g.strokeStyle = seal; g.lineWidth = 2;
    g.beginPath(); g.arc(x(r.ts), y(gOf(r)), 5, 0, 7); g.fill(); g.stroke();
  }
}

function ink(css) {
  return css.getPropertyValue("--ink").trim();
}

function indexAt(clientX) {
  const rect = el.chart.getBoundingClientRect();
  const px = clientX - rect.left;
  let best = 0, bd = Infinity;
  S.chartHits.forEach((x, i) => {
    const d = Math.abs(x - px);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

function scrubTo(i, scroll) {
  S.follow = false;
  S.idx = i;
  render();
  if (scroll) el.ledger.querySelector(`button[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
}

// ---------- route ----------

function drawRoute() {
  const pts = S.readings.map((r, i) => ({ r, i })).filter((p) => p.r.latE6 != null);
  const svg = el.route;
  svg.replaceChildren();
  svg.toggleAttribute("hidden", pts.length < 2);
  if (pts.length < 2) {
    el.routeNote.textContent = S.readings.length
      ? "These readings carry no location, so there is no route to draw. Allow location on the recording phone."
      : "The route appears here once a phone records with location on.";
    return;
  }
  el.routeNote.textContent = "Drawn from " + plural(pts.length, "located reading", "located readings") + ". No map tiles, only where the phone said it was.";
  const lat0 = pts.reduce((a, p) => a + p.r.latE6, 0) / pts.length / 1e6;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => (p.r.lonE6 / 1e6) * kx), ys = pts.map((p) => -p.r.latE6 / 1e6);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-5), spanY = Math.max(maxY - minY, 1e-5);
  const W = 240, H = 180, m = 18;
  const s = Math.min((W - 2 * m) / spanX, (H - 2 * m) / spanY);
  const ox = (W - spanX * s) / 2, oy = (H - spanY * s) / 2;
  const px = (k) => ox + (xs[k] - minX) * s, py = (k) => oy + (ys[k] - minY) * s;
  const ns = "http://www.w3.org/2000/svg";
  const make = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  svg.append(make("polyline", { points: pts.map((_, k) => px(k).toFixed(1) + "," + py(k).toFixed(1)).join(" "), fill: "none", stroke: "#c9a06b", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  pts.forEach((p, k) => {
    if (p.r.shock) svg.append(make("circle", { cx: px(k), cy: py(k), r: 3.5, fill: "#ff5a4f" }));
  });
  svg.append(make("circle", { cx: px(0), cy: py(0), r: 4.5, fill: "#15212d", stroke: "#e9eef4", "stroke-width": 2 }));
  svg.append(make("circle", { cx: px(pts.length - 1), cy: py(pts.length - 1), r: 4.5, fill: "#e9eef4" }));
  // playhead: the located reading closest at or before the selected one
  let at = 0;
  pts.forEach((p, k) => { if (p.i <= S.idx) at = k; });
  svg.append(make("circle", { cx: px(at), cy: py(at), r: 7, fill: "none", stroke: "#5aa9ff", "stroke-width": 2.5 }));
}

// ---------- wiring ----------

el.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const id = el.pid.value.trim();
  if (!ID_RE.test(id)) {
    el.pid.setCustomValidity("Use letters, numbers, dashes or underscores, up to 64 characters.");
    el.pid.reportValidity();
    el.pid.setCustomValidity("");
    return;
  }
  location.href = "/parcel/" + encodeURIComponent(id);
});

el.scrub.addEventListener("input", () => scrubTo(Number(el.scrub.value), true));
el.live.addEventListener("click", () => {
  S.follow = true;
  S.idx = S.readings.length - 1;
  render();
});
el.onlyShocks.addEventListener("click", () => {
  S.onlyShocks = !S.onlyShocks;
  el.onlyShocks.setAttribute("aria-pressed", String(S.onlyShocks));
  render();
});
el.ledger.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-i]");
  if (b) scrubTo(Number(b.dataset.i), false);
});

let scrubbing = false;
el.chart.addEventListener("pointerdown", (e) => {
  if (!S.readings.length) return;
  scrubbing = true;
  el.chart.setPointerCapture(e.pointerId);
  scrubTo(indexAt(e.clientX), true);
});
el.chart.addEventListener("pointermove", (e) => { if (scrubbing) scrubTo(indexAt(e.clientX), true); });
el.chart.addEventListener("pointerup", () => { scrubbing = false; });

let drag = null;
el.scene.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; el.scene.setPointerCapture(e.pointerId); });
el.scene.addEventListener("pointermove", (e) => {
  if (!drag) return;
  S.yaw += (e.clientX - drag.x) * 0.5;
  S.pitch = Math.max(-70, Math.min(-4, S.pitch - (e.clientY - drag.y) * 0.3));
  drag = { x: e.clientX, y: e.clientY };
  setOrbit();
});
el.scene.addEventListener("pointerup", () => { drag = null; });

window.addEventListener("resize", drawChart);

// Opened from the console or a claim: read one parcel's delivery from a same-origin API path.
const qs = new URLSearchParams(location.search);
const srcParam = qs.get("src");
if (srcParam && /^\/api\/[A-Za-z0-9_\-\/]+$/.test(srcParam)) {
  S.src = srcParam;
  S.parcelId = (qs.get("title") || "Parcel").slice(0, 64);
  const lim = Number(qs.get("limit"));
  if (lim > 0 && lim < 20) SHOCK_HIGH_G = lim;
  S.follow = qs.get("embed") ? false : S.follow;
} else {
  S.parcelId = parcelFromUrl();
}
if (qs.get("embed")) document.body.classList.add("embed");
el.pid.value = S.parcelId || "";

// No typing a parcel ID: pick from your parcels.
(async function parcelPicker() {
  if (S.src || qs.get("embed")) { el.form.hidden = true; return; }
  try {
    const res = await fetch("/api/parcels", { cache: "no-store", credentials: "same-origin" });
    if (res.status === 401) { location.href = "/login?next=/replay"; return; }
    const { parcels } = await res.json();
    const list = parcels.filter((p) => p.dispatchedAt);
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "Parcel");
    const first = document.createElement("option");
    first.textContent = list.length ? "Choose a parcel..." : "No dispatched parcels yet";
    first.value = ""; sel.append(first);
    for (const p of list) { const o = document.createElement("option"); o.value = p.id; o.textContent = p.orderRef + " (" + p.status.replace("_", " ") + ")"; sel.append(o); }
    sel.addEventListener("change", () => {
      const p = list.find((x) => x.id === sel.value);
      if (p) location.href = "/replay?src=" + encodeURIComponent("/api/parcels/" + p.id + "/readings") + "&title=" + encodeURIComponent(p.orderRef) + "&limit=" + p.limits.shockG;
    });
    el.form.replaceChildren(sel);
    el.form.hidden = false;
  } catch { el.form.hidden = true; }
})();
drawBarcode(S.parcelId || "shipproof");
setOrbit();
render();
requestAnimationFrame(frame);
poll();
setInterval(poll, POLL_MS);
setInterval(() => { if (S.readings.length) render(); }, 10000); // keeps "last reading ... ago" honest

// Inside a claim page: tell the parent how tall this page is, so the frame fits with no inner scrollbar.
if (document.body.classList.contains("embed") && parent !== window) {
  const send = () => parent.postMessage({ shipproofHeight: document.documentElement.scrollHeight }, location.origin);
  new ResizeObserver(send).observe(document.body);
  send();
}
