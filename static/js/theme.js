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
