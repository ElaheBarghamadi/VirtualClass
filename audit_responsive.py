"""Responsive audit: visit key pages across viewports, detect horizontal
overflow, identify offending elements, and capture screenshots.

Usage:  python audit_responsive.py [--base http://127.0.0.1:8000]
"""
from __future__ import annotations

import argparse
import json
import sys

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8000"
ROOM = "GTnkq3Oi7pg"

VIEWPORTS = [
    ("320x568", 320, 568),    # iPhone SE 1st gen / very small
    ("375x667", 375, 667),    # iPhone SE/8
    ("414x896", 414, 896),    # iPhone XR/11
    ("768x1024", 768, 1024),  # tablet portrait
    ("1024x768", 1024, 768),  # tablet landscape / small laptop
    ("1440x900", 1440, 900),  # desktop
]

# (label, url, auth_required)
PAGES = [
    ("home", "/", False),
    ("login", "/accounts/login/", False),
    ("register", "/accounts/register/", False),
    ("pwdreset", "/accounts/password-reset/", False),
    ("lobby", f"/class/{ROOM}/lobby/", False),  # guest view (anonymous)
    ("dashboard", "/dashboard/", True),
    ("classlist", "/classrooms/", True),
    ("classcreate", "/classrooms/create/", True),
    ("classdetail", f"/classrooms/{ROOM}/", True),
    ("room", f"/class/{ROOM}/room/", True),
    ("assignments", f"/classrooms/{ROOM}/assignments/", True),
    ("quizzes", f"/classrooms/{ROOM}/quizzes/", True),
    ("attendance", "ATTENDANCE_URL", True),  # resolved after login (session id varies)
    ("profile", "/accounts/profile/", True),
]

OVERFLOW_JS = """
() => {
  const vw = document.documentElement.clientWidth;
  const doc = document.documentElement;
  const result = {
    scrollWidth: doc.scrollWidth,
    clientWidth: vw,
    overflowPx: doc.scrollWidth - vw,
    offenders: [],
  };
  if (doc.scrollWidth - vw <= 1) return result;
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // element extends beyond viewport on either side
    const right = r.right, left = r.left;
    if (right > vw + 1 || left < -1) {
      // only report the outermost meaningful elements
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      const key = el.tagName + '.' + (el.className && el.className.toString ? el.className.toString().slice(0,60) : '');
      if (seen.has(key)) continue;
      seen.add(key);
      result.offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 80),
        id: el.id || '',
        left: Math.round(left),
        right: Math.round(right),
        w: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
      if (result.offenders.length >= 8) break;
    }
  }
  return result;
}
"""


def login(page):
    page.goto(f"{BASE}/accounts/login/", wait_until="domcontentloaded")
    page.fill("#id_username", "owner1")
    page.fill("#id_password", "Pass-12345")
    page.click("button[type=submit]")
    page.wait_for_load_state("domcontentloaded")


def resolve_urls(page):
    """Find the attendance report URL (session ids change across reseeds)."""
    import re
    page.goto(f"{BASE}/classrooms/{ROOM}/", wait_until="domcontentloaded")
    m = re.search(rf"/class/{ROOM}/sessions/(\d+)/attendance/", page.content())
    return {f"/class/{ROOM}/sessions/{m.group(1)}/attendance/" if m else "#"}


INNER_OVERFLOW_JS = """
() => {
  const out = [];
  for (const el of document.querySelectorAll('.room *, dialog *')) {
    if (!el.clientWidth) continue;
    const dx = el.scrollWidth - el.clientWidth;
    if (dx > 2) {
      const cs = getComputedStyle(el);
      const ox = cs.overflowX;
      if (cs.textOverflow === 'ellipsis') continue;  // intentional truncation
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 70),
        id: el.id || '',
        extraPx: dx,
        overflowX: ox,
        clipped: ox === 'hidden' || ox === 'clip',
      });
    }
  }
  return out.slice(0, 20);
}
"""


def room_interactive(page, vp_name, shots):
    """Open drawer/menus/dialogs on the room page and check overflow."""
    findings = []
    states = []

    # 1) side drawer (mobile only, <=900px)
    if page.viewport_size["width"] <= 900:
        try:
            page.click("#btn-people", timeout=3000)
            page.wait_for_timeout(450)
            res = page.evaluate(OVERFLOW_JS)
            res.update({"vp": vp_name, "page": "room-drawer-people"})
            if res["overflowPx"] > 1:
                findings.append(res)
            page.screenshot(path=f"{shots}/room_drawer_people_{vp_name}.png")
            # switch to files tab inside drawer
            page.click('.side-tab[data-tab="files"]', timeout=2000)
            page.wait_for_timeout(300)
            res = page.evaluate(OVERFLOW_JS)
            if res["overflowPx"] > 1:
                res.update({"vp": vp_name, "page": "room-drawer-files"})
                findings.append(res)
            page.screenshot(path=f"{shots}/room_drawer_files_{vp_name}.png")
            page.click('.side-tab[data-tab="chat"]', timeout=2000)
            page.wait_for_timeout(300)
            res = page.evaluate(OVERFLOW_JS)
            if res["overflowPx"] > 1:
                res.update({"vp": vp_name, "page": "room-drawer-chat"})
                findings.append(res)
            page.screenshot(path=f"{shots}/room_drawer_chat_{vp_name}.png")
            states.append("drawer")
            # REAL user flows for the drawer (smart toggle + outside/Escape close)
            def drawer_open():
                return page.evaluate(
                    "document.getElementById('room-side').classList.contains('drawer-open')")

            def tab_active(name):
                return page.evaluate(
                    f"document.querySelector('.side-tab[data-tab=\\\"{name}\\\"]')?.classList.contains('active')")

            def check(desc, expect_open):
                if drawer_open() != expect_open:
                    findings.append({"vp": vp_name, "page": "room-drawer-close",
                                     "error": f"{desc}: expected open={expect_open}, got {drawer_open()}"})

            # a) chat tab is active & drawer open → chat toggle closes it
            try:
                page.click("#btn-chat", timeout=2500); page.wait_for_timeout(350)
                check("chat toggle on active chat tab closes", False)
                # b) people toggle opens … and closes on second press
                page.click("#btn-people", timeout=2500); page.wait_for_timeout(350)
                check("people toggle opens", True)
                page.click("#btn-people", timeout=2500); page.wait_for_timeout(350)
                check("people toggle (active tab) closes", False)
                # c) open people, press chat → SWITCHES tab, stays open
                page.click("#btn-people", timeout=2500); page.wait_for_timeout(300)
                page.click("#btn-chat", timeout=2500); page.wait_for_timeout(350)
                check("cross-tab press keeps drawer open", True)
                if not tab_active("chat"):
                    findings.append({"vp": vp_name, "page": "room-drawer-close",
                                     "error": "cross-tab press did not activate chat tab"})
                # d) Escape closes the drawer
                page.keyboard.press("Escape"); page.wait_for_timeout(350)
                check("Escape closes drawer", False)
                # e) outside click (visible stage area, right of the drawer) closes it
                page.click("#btn-people", timeout=2500); page.wait_for_timeout(300)
                box = page.locator(".stage").bounding_box()
                page.click(".stage", position={"x": box["width"] - 12, "y": 220}, timeout=2500)
                page.wait_for_timeout(350)
                check("outside click closes drawer", False)
            except Exception as e:
                findings.append({"vp": vp_name, "page": "room-drawer-close",
                                 "error": str(e).splitlines()[0][:200]})
            # ensure closed for the following states
            page.evaluate("document.getElementById('room-side').classList.remove('drawer-open')")
            page.wait_for_timeout(300)
        except Exception as e:
            findings.append({"vp": vp_name, "page": "room-drawer", "error": str(e)})

    # 2) more menu
    try:
        page.click("#btn-more", timeout=3000)
        page.wait_for_timeout(300)
        res = page.evaluate(OVERFLOW_JS)
        if res["overflowPx"] > 1:
            res.update({"vp": vp_name, "page": "room-more-menu"})
            findings.append(res)
        page.screenshot(path=f"{shots}/room_moremenu_{vp_name}.png")
        states.append("more-menu")
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    except Exception as e:
        findings.append({"vp": vp_name, "page": "room-more-menu", "error": str(e)})

    # 3) devices dialog
    try:
        page.click("#btn-more", timeout=2000)
        page.click("#menu-devices", timeout=2000)
        page.wait_for_timeout(400)
        res = page.evaluate(OVERFLOW_JS)
        if res["overflowPx"] > 1:
            res.update({"vp": vp_name, "page": "room-devices-dialog"})
            findings.append(res)
        page.screenshot(path=f"{shots}/room_devices_{vp_name}.png")
        states.append("devices")
        page.click("#devices-close", timeout=2000)
        page.wait_for_timeout(200)
    except Exception as e:
        findings.append({"vp": vp_name, "page": "room-devices-dialog", "error": str(e)})

    # 4) whiteboard view
    try:
        page.click("#btn-whiteboard", timeout=3000)
        page.wait_for_timeout(700)
        res = page.evaluate(OVERFLOW_JS)
        if res["overflowPx"] > 1:
            res.update({"vp": vp_name, "page": "room-whiteboard"})
            findings.append(res)
        page.screenshot(path=f"{shots}/room_whiteboard_{vp_name}.png")
        states.append("whiteboard")
    except Exception as e:
        findings.append({"vp": vp_name, "page": "room-whiteboard", "error": str(e)})

    return findings, states


def main() -> int:
    global BASE
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--shots", default="shots")
    args = ap.parse_args()
    BASE = args.base
    import os
    os.makedirs(args.shots, exist_ok=True)

    findings = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for vp_name, w, h in VIEWPORTS:
            ctx = browser.new_context(viewport={"width": w, "height": h},
                                      locale="fa-IR")
            page = ctx.new_page()
            login(page)
            if any(u == "ATTENDANCE_URL" for _, u, _ in PAGES):
                att = resolve_urls(page)
                PAGES[:] = [(l, att.pop() if u == "ATTENDANCE_URL" else u, a)
                            for (l, u, a) in PAGES]
            for label, url, needs_auth in PAGES:
                if not needs_auth:
                    # anonymous view in a fresh page
                    anon = ctx.browser.new_context(viewport={"width": w, "height": h},
                                                   locale="fa-IR")
                    apage = anon.new_page()
                    try:
                        apage.goto(BASE + url, wait_until="domcontentloaded", timeout=15000)
                        apage.wait_for_timeout(400)
                        res = apage.evaluate(OVERFLOW_JS)
                        if res["overflowPx"] > 1:
                            findings.append({"vp": vp_name, "page": label, **res})
                        apage.screenshot(path=f"{args.shots}/{label}_{vp_name}.png",
                                         full_page=True)
                    except Exception as e:
                        findings.append({"vp": vp_name, "page": label, "error": str(e)})
                    anon.close()
                    continue
                try:
                    page.goto(BASE + url, wait_until="domcontentloaded", timeout=15000)
                    page.wait_for_timeout(500)
                    res = page.evaluate(OVERFLOW_JS)
                    if res["overflowPx"] > 1:
                        findings.append({"vp": vp_name, "page": label, **res})
                    page.screenshot(path=f"{args.shots}/{label}_{vp_name}.png",
                                    full_page=True)
                    if label == "room":
                        inner = page.evaluate(INNER_OVERFLOW_JS)
                        clipped = [i for i in inner if i["clipped"]]
                        if clipped:
                            findings.append({"vp": vp_name,
                                             "page": "room-inner-clip",
                                             "clipped": clipped})
                        extra, _states = room_interactive(page, vp_name, args.shots)
                        findings.extend(extra)
                except Exception as e:
                    findings.append({"vp": vp_name, "page": label, "error": str(e)})
            ctx.close()
        browser.close()

    print(json.dumps(findings, indent=2, ensure_ascii=False))
    n = len(findings)
    print(f"\n{n} overflow finding(s)" if n else "\nNo horizontal overflow detected")
    return 1 if n else 0


if __name__ == "__main__":
    sys.exit(main())
