"""
Mesh reachability failure must be VISIBLE, not a silent empty tile.

Run against a LIVE dev server (same contract as run_e2e.py):

    python tests_e2e/run_mesh_fail.py --room <CODE> [--base http://127.0.0.1:8000]

Both browsers start with UDP blocked (--force-webrtc-ip-handling-policy=
disable_non_proxied_udp), which is what a corporate firewall or a
UDP-blocking mobile carrier looks like to WebRTC: signalling succeeds, media
never arrives, and without a TURN relay there is nothing the app can do about
it.  What the app CAN do — and what this suite checks — is notice within a
bounded time, explain why, and offer a retry instead of showing a blank tile.
"""
from __future__ import annotations

import argparse
import sys

from playwright.sync_api import sync_playwright

PASSWORD = "Pass-12345"
ARGS = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
]
# watchdog (10s) -> automatic ICE restart -> watchdog (10s) -> verdict
VERDICT_WITHIN_S = 45

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


TILES_JS = """
() => [...document.querySelectorAll('.tile')].map(t => ({
    ident: t.dataset.identity,
    self: t.dataset.self === '1',
    failed: t.classList.contains('conn-failed'),
    conn: t.querySelector('.tile-conn') ? {
        title: t.querySelector('.tile-conn p')?.textContent || '',
        hint: t.querySelector('.tile-conn small')?.textContent || '',
        btn: (t.querySelector('.tile-conn button')?.textContent || '').trim(),
    } : null,
}))
"""


def join(pw, base, room, user):
    b = pw.chromium.launch(args=ARGS)
    ctx = b.new_context(viewport={"width": 1280, "height": 800})
    ctx.grant_permissions(["camera", "microphone"], origin=base)
    ctx.add_init_script("window.__errs=[];addEventListener('error',e=>window.__errs.push(e.message));")
    pg = ctx.new_page()
    pg.goto(f"{base}/accounts/login/", wait_until="networkidle")
    pg.fill('input[name="username"]', user)
    pg.fill('input[name="password"]', PASSWORD)
    pg.click('button[type="submit"]')
    pg.wait_for_load_state("networkidle")
    pg.goto(f"{base}/class/{room}/room/", wait_until="networkidle")
    pg.wait_for_timeout(1500)
    return b, pg


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    args = ap.parse_args()

    with sync_playwright() as pw:
        b1, owner = join(pw, args.base, args.room, "owner1")
        b2, stu = join(pw, args.base, args.room, "stu1")
        owner.click("#btn-camera"); owner.wait_for_timeout(700)
        stu.click("#btn-camera"); stu.wait_for_timeout(700)
        # Chrome throttles timers in background tabs: keep the page we assert on
        # in front, or the watchdog fires much later than it really would.
        owner.bring_to_front()

        tiles = []
        waited = 0
        while waited < VERDICT_WITHIN_S:
            owner.wait_for_timeout(3000)
            waited += 3
            tiles = owner.evaluate(TILES_JS)
            if any(t["conn"] for t in tiles):
                break

        remote = [t for t in tiles if not t["self"]]
        check("remote peer has a tile", len(remote) == 1, str(tiles))
        if remote:
            r = remote[0]
            check("unreachable peer is reported, not left blank",
                  r["failed"] and r["conn"] is not None, str(r))
            if r["conn"]:
                check("notice says what happened",
                      "برقرار نشد" in r["conn"]["title"], r["conn"]["title"])
                check("notice names the real cause (no TURN relay configured)",
                      "TURN" in r["conn"]["hint"], r["conn"]["hint"])
                check("retry is offered", r["conn"]["btn"] == "تلاشِ دوباره", r["conn"]["btn"])
        warns = owner.evaluate(
            "() => [...document.querySelectorAll('.toast,[role=alert]')].map(t => t.textContent)")
        check("user gets one warning", any("هم‌کلاسی" in t for t in warns), str(warns[-1:]) )
        errs = owner.evaluate("() => window.__errs")
        check("no JS errors", not errs, str(errs))

        owner.evaluate("() => document.querySelector('.tile-conn button')?.click()")
        owner.wait_for_timeout(1200)
        after = [t for t in owner.evaluate(TILES_JS) if not t["self"]]
        check("retry clears the badge and re-attempts",
              all(not t["failed"] and t["conn"] is None for t in after), str(after))
        b1.close(); b2.close()

    failed = [n for n, ok, _ in RESULTS if not ok]
    print()
    print(f"===== {len(RESULTS) - len(failed)}/{len(RESULTS)} PASS =====")
    for n in failed:
        print(" -", n)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
