/* Theme manager — resolves light/dark/system, persists the choice and
 * keeps <html> attributes in sync (data-theme, data-density, data-motion).
 * Loaded in <head> (deferred=false) so the first paint is already themed.
 */
(function () {
  "use strict";

  const STORE_KEY = "ui_theme";
  const MOTION_KEY = "ui_motion";

  function setCookie(name, value, days) {
    const d = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${value}; path=/; expires=${d}; SameSite=Lax`;
  }

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function resolvedTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    return systemPrefersDark() ? "dark" : "light";
  }

  function apply(pref) {
    const root = document.documentElement;
    root.setAttribute("data-theme", resolvedTheme(pref));
    root.setAttribute("data-theme-pref", pref || "system");
    setCookie(STORE_KEY, pref || "system", 365);
  }

  // initial preference: server-rendered attribute wins (account setting),
  // otherwise the cookie (guests), otherwise system.
  const initial =
    document.documentElement.getAttribute("data-theme-pref") ||
    readCookie(STORE_KEY) ||
    "system";
  apply(initial);

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      const pref = document.documentElement.getAttribute("data-theme-pref");
      if (!pref || pref === "system") apply("system");
    });
  }

  // motion preference
  const motion = readCookie(MOTION_KEY);
  if (motion) document.documentElement.setAttribute("data-motion", motion);

  // ---- header theme toggle -------------------------------------------------
  // One click cycles light → dark → system.  The icon is driven purely by
  // CSS off [data-theme], so it always matches what is actually rendered.
  const CYCLE = ["light", "dark", "system"];
  const THEME_LABEL = { light: "روشن", dark: "تیره", system: "خودکار (سیستم)" };

  function syncToggle() {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    const pref = document.documentElement.getAttribute("data-theme-pref") || "system";
    btn.setAttribute("data-theme-mode", pref);
    btn.setAttribute("title", `پوسته: ${THEME_LABEL[pref] || pref} — برای تغییر کلیک کنید`);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#theme-toggle");
    if (!btn) return;
    const current = document.documentElement.getAttribute("data-theme-pref") || "system";
    const next = CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length];
    apply(next);
    syncToggle();
    // Persist to the account when signed in, so the choice follows the user
    // to other devices (guests keep the cookie written by apply()).
    const form = document.querySelector('meta[name="csrftoken"]');
    fetch("/accounts/theme/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRFToken": (form?.content) || readCookie("csrftoken"),
      },
      body: JSON.stringify({ theme: next }),
      credentials: "same-origin",
    }).catch(() => { /* offline / endpoint absent — cookie still applies */ });
  });

  document.addEventListener("DOMContentLoaded", syncToggle);
  syncToggle();

  /** Public API used by the profile page and the in-room settings menu. */
  window.UITheme = {
    get preference() {
      return document.documentElement.getAttribute("data-theme-pref") || "system";
    },
    set(pref) {
      apply(pref);
    },
    setMotion(mode) {
      document.documentElement.setAttribute("data-motion", mode);
      setCookie(MOTION_KEY, mode, 365);
    },
  };
})();
