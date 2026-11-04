// The app frame shared by the company pages: sidebar, command palette, toasts, pairing dialog.
import { api, h } from "/js/api.js";

const ICONS = {
  overview: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  tags: "M4 4h8l8 8-8 8-8-8zM8.5 8.5h.01",
  parcels: "M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10",
  claims: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h5",
  replay: "M5 4l14 8-14 8z",
};
const icon = (name) => {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ico"); s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICONS[name]); s.append(p); return s;
};

export function toast(text, kind) {
  let box = document.getElementById("toasts");
  if (!box) { box = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.append(box); }
  const t = h("div", { class: "toast " + (kind || "") }, text);
  box.append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 300); }, 4200);
}

const themeLabel = (m) => ({ auto: "Auto", light: "Light", dark: "Dark" }[m]);
const NAV = [["overview", "Overview", "/console"], ["tags", "Tags", "/console#tags"], ["parcels", "Parcels", "/console#parcels"], ["claims", "Claims", "/console#claims"], ["replay", "Replay", "/replay"]];

/** Builds the frame and returns the element to put page content in. */
export function mountShell(root, { org, active, onAction }) {
  const side = h("aside", { class: "side" },
    h("a", { class: "brand", href: "/console" }, "Ship", h("span", null, "Proof")),
    h("nav", { "aria-label": "Main" }, NAV.map(([key, label, href]) =>
      h("a", { href, "data-key": key, ...(active === key ? { "aria-current": "page" } : {}) }, icon(key), label))),
    h("div", { class: "side-foot" },
      h("button", { class: "kbd-btn", type: "button", onclick: () => openPalette(onAction) }, "Search or jump", h("kbd", null, navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K")),
      h("div", { class: "who" }, h("span", { class: "pill" }, org),
        h("button", { class: "themebtn", type: "button", title: "Appearance", onclick: (e) => { e.currentTarget.textContent = themeLabel(window.spTheme.cycle()); } }, themeLabel(window.spTheme.get())),
        h("button", { class: "btn sm ghost", onclick: async () => { await api("POST", "/auth/logout", {}); location.href = "/login"; } }, "Sign out"))));
  const main = h("main", { class: "main", id: "main" });
  root.replaceChildren(h("div", { class: "frame" }, side, main));
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(onAction); }
  });
  return main;
}

// ---------- command palette ----------

let paletteData = null;
async function loadPaletteData() {
  const [parcels, claims] = await Promise.all([api("GET", "/parcels"), api("GET", "/claims")]);
  paletteData = { parcels: parcels.parcels, claims: claims.claims };
}

export async function openPalette(onAction) {
  if (document.getElementById("palette")) return;
  try { await loadPaletteData(); } catch { paletteData = { parcels: [], claims: [] }; }
  const items = [
    { label: "Go to Overview", hint: "page", run: () => (location.href = "/console") },
    { label: "Go to Tags", hint: "page", run: () => (location.href = "/console#tags") },
    { label: "Go to Parcels", hint: "page", run: () => (location.href = "/console#parcels") },
    { label: "Go to Claims", hint: "page", run: () => (location.href = "/console#claims") },
    { label: "Open parcel replay", hint: "page", run: () => (location.href = "/replay") },
    { label: "Pair a phone as a demo tag", hint: "action", run: () => openPairing() },
    { label: "Open the tag dock (USB hardware tag)", hint: "page", run: () => (location.href = "/dock") },
    ...paletteData.claims.map((c) => ({ label: "Claim: " + (c.orderRef || c.parcelId) + " - " + c.claimant, hint: c.status, run: () => (location.href = "/claims/" + c.id) })),
    ...paletteData.parcels.map((p) => ({ label: "Parcel: " + p.orderRef, hint: p.status.replace("_", " "), run: () => (location.href = "/console#parcels") })),
    { label: "Sign out", hint: "action", run: async () => { await api("POST", "/auth/logout", {}); location.href = "/login"; } },
  ];
  const input = h("input", { type: "text", placeholder: "Type to search parcels, claims, pages...", "aria-label": "Search", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { role: "listbox" });
  const dlg = h("dialog", { id: "palette", class: "palette" }, input, list);
  let shown = items, sel = 0;
  const close = () => { dlg.close(); dlg.remove(); };
  const draw = () => {
    list.replaceChildren(...(shown.length ? shown.slice(0, 9).map((it, i) =>
      h("li", { role: "option", "aria-selected": i === sel ? "true" : "false", onclick: () => { close(); it.run(); } }, h("span", null, it.label), h("small", null, it.hint)))
      : [h("li", { class: "none" }, "Nothing matches.")]));
  };
  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    shown = q ? items.filter((it) => q.split(/\s+/).every((w) => it.label.toLowerCase().includes(w))) : items;
    sel = 0; draw();
  });
  dlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, Math.min(shown.length, 9) - 1); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); draw(); }
    else if (e.key === "Enter" && shown[sel]) { e.preventDefault(); const it = shown[sel]; close(); it.run(); }
  });
  dlg.addEventListener("click", (e) => { if (e.target === dlg) close(); });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); draw(); dlg.showModal(); input.focus();
}

// ---------- pairing a phone by QR ----------

function loadQr() {
  return new Promise((resolve) => {
    if (window.QRCode) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js";
    s.onload = () => resolve(!!window.QRCode); s.onerror = () => resolve(false);
    document.head.append(s);
  });
}

export async function openPairing() {
  if (document.getElementById("pairing")) return;
  let before = [];
  try { before = (await api("GET", "/org/tags")).tags.map((t) => t.deviceId); } catch { /* ignore */ }
  const qrBox = h("div", { class: "qr", "aria-label": "QR code for pairing" });
  const linkOut = h("input", { readonly: true, "aria-label": "Pairing link", class: "mono" });
  const status = h("p", { class: "msg", role: "status" }, "Waiting for a phone to scan...");
  const left = h("p", { class: "note" });
  const dlg = h("dialog", { id: "pairing", class: "pairing" },
    h("h2", null, "Pair a phone as a tag"),
    h("p", null, "Scan this with the phone's camera. It opens the recorder and links the phone to your company. No ID to type."),
    qrBox, status, linkOut, left,
    h("div", { class: "row" }, h("button", { class: "btn sm ghost", id: "pairNew" }, "New code"), h("button", { class: "btn sm", id: "pairClose" }, "Close")));
  let timer, tick, expires = 0;
  const stop = () => { clearInterval(timer); clearInterval(tick); };
  const close = () => { stop(); dlg.close(); dlg.remove(); };
  dlg.addEventListener("close", () => { stop(); dlg.remove(); });
  async function fresh() {
    try {
      const r = await api("POST", "/org/pairing", {});
      expires = r.expiresAt;
      const url = location.origin + "/capture?pair=" + encodeURIComponent(r.token);
      linkOut.value = url;
      qrBox.replaceChildren();
      if (await loadQr()) new window.QRCode(qrBox, { text: url, width: 200, height: 200, colorDark: "#121b26", colorLight: "#f2efe6", correctLevel: window.QRCode.CorrectLevel.M });
      else qrBox.append(h("p", { class: "note" }, "The QR code library couldn't load. Open the link below on the phone."));
    } catch (e) { status.textContent = e.message; status.classList.add("err"); }
  }
  dlg.querySelector("#pairNew").onclick = fresh;
  dlg.querySelector("#pairClose").onclick = close;
  document.body.append(dlg); dlg.showModal(); await fresh();
  tick = setInterval(() => { const s = expires - Math.floor(Date.now() / 1000); left.textContent = s > 0 ? "Code works for " + Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") + " more." : "This code has expired. Press New code."; }, 1000);
  timer = setInterval(async () => {
    try {
      const tags = (await api("GET", "/org/tags")).tags;
      const added = tags.find((t) => !before.includes(t.deviceId));
      if (added) { close(); toast("Phone paired as " + added.label, "ok"); document.dispatchEvent(new CustomEvent("shipproof:refresh")); }
    } catch { /* keep waiting */ }
  }, 2000);
}
