// Loaded in <head> before first paint so there is no flash. "auto" follows the system.
(function () {
  const KEY = "shipproof.theme";
  const root = document.documentElement;
  const read = () => { try { return localStorage.getItem(KEY) || "auto"; } catch { return "auto"; } };
  const apply = (mode) => {
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode); else root.removeAttribute("data-theme");
    root.style.colorScheme = mode === "auto" ? "light dark" : mode;
    window.dispatchEvent(new Event("themechange"));
  };
  window.spTheme = {
    get: read,
    cycle() {
      const next = { auto: "light", light: "dark", dark: "auto" }[read()] || "auto";
      try { localStorage.setItem(KEY, next); } catch { /* private mode: applies for this page only */ }
      apply(next);
      return next;
    },
  };
  apply(read());
  // another tab or the page around an embedded replay changed it
  addEventListener("storage", (e) => { if (e.key === KEY) apply(read()); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => window.dispatchEvent(new Event("themechange")));
})();
