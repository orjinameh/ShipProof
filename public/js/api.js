// Shared helpers for the company pages.
export async function api(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/signup")) {
    location.href = "/login?next=" + encodeURIComponent(location.pathname);
    throw new Error("Signed out");
  }
  if (!res.ok) { const e = new Error((data && data.message) || "Request failed (" + res.status + ")"); e.code = data && data.error; e.status = res.status; throw e; }
  return data;
}

// Builds DOM with textContent only, so nothing from the server is ever parsed as HTML.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

export const fmtTime = (s) => (s == null ? "-" : new Date(s * 1000).toLocaleString());
export function say(el, text, isErr) { el.textContent = text || ""; el.classList.toggle("err", !!isErr); }
export function header(active, org) {
  const link = (href, label) => h("a", { href, ...(active === label ? { "aria-current": "page" } : {}) }, label);
  return h("header", { class: "top" },
    h("a", { class: "brand", href: "/console" }, "Ship", h("span", null, "Proof")),
    h("nav", null, link("/console", "Console"), link("/", "Replay"), org ? h("span", { class: "pill" }, org) : null,
      h("button", { class: "btn sm ghost", onclick: async () => { await api("POST", "/auth/logout", {}); location.href = "/login"; } }, "Sign out")));
}
