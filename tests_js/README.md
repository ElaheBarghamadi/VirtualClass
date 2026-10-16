# Client tests (headless)

The browser half of the classroom — the whiteboard (`static/js/whiteboard.js` +
`static/js/wb/*.js`), the media transports (`static/js/media.js`,
`static/js/mesh.js`) and the connection policy (`static/js/net/policy.js`) — is
plain ES modules. These tests run that **real code** in
[jsdom](https://github.com/jsdom/jsdom) with a real 2D canvas
(`@napi-rs/canvas`), a fake WebSocket and a WebRTC simulation, so the engines can
be exercised without a browser or a Django server.

```bash
cd tests_js
npm install
npm test                                   # all seven suites
node whiteboard.test.mjs                   # 47 checks — stubbed canvas, deep DOM coverage
node board.test.mjs                        # 49 checks — real rasterizer, pixel assertions
node offline.test.mjs                      # 18 checks — works with no socket at all
node dom_contract.test.mjs                 #  7 checks — markup ↔ client contract
node policy.test.mjs                       # 17 checks — quality/bitrate/ICE/backoff policy
node mesh.test.mjs                         # 10 checks — P2P engine on a scripted RTCPeerConnection
node mesh_media.test.mjs                   # 15 checks — TWO peers, media really arrives
node board.test.mjs --dump .build/ops.json # dump every op the client sent
```

Every suite copies `static/js` into `.build/` and imports it as ES modules, and
each `boot()` gets its **own module instance**, so two environments in one
process never read each other's state.

What is covered:

* **wiring** — the `#view-whiteboard` markup is lifted out of
  `classrooms/templates/classrooms/room.html`, so a renamed id, a removed
  button or a `data-action` without a handler fails the run;
* **drawing** — pen/highlighter/shapes produce one normalised (`norm: 1`) op
  per gesture, with page fractions inside `0…1`;
* **editing** — eraser, move/resize, marquee select, duplicate, delete,
  z-order, undo/redo (including replaying the inverse to the server);
* **pages** — add/duplicate/remove/renumber, per-page backgrounds and grids,
  and the Persian page label the automated browser suite asserts on;
* **sync** — remote ops, rejected ops (rollback), full resync, presence
  roster, remote cursors, permission grant/revoke;
* **robustness** — a malformed operation from the network cannot break the
  render loop;
* **legacy boards** — operations stored by the previous client (pixel-ish
  rect/ellipse geometry, `color: null` eraser strokes) still paint;
* **the compatibility surface** `room.js` and `tests_e2e/run_e2e.py` rely on
  (`Whiteboard.init/resize/setPermission/page/canDraw/_pageOps/PAGE`).

## `board.test.mjs` — the browser-faithful suite

`whiteboard.test.mjs` replaces the 2D context with recording stubs, so it can
assert *what the client asked the canvas to draw*. That cannot catch a bug in
the drawing itself. `board.test.mjs` instead gives every `<canvas>` a real
backing store (`@napi-rs/canvas`), dispatches real `PointerEvent`s through
jsdom's event pipeline and then reads the pixels back, which covers exactly the
class of bug that only shows up in a browser:

* ink lands where the pointer was, also when the canvas sits at an offset and
  when the page is zoomed/scrolled;
* `devicePixelRatio` handling (2× backing store, dpr changes without a size
  change);
* the page sheet, grids and backgrounds really paint;
* PNG/print exports contain real image bytes;
* a stroke made while the socket is down is queued and flushed on reconnect;
* malformed server frames cannot break the render loop;
* the whole toolbar, button by button: every tool, every popover, the pages
  drawer, zoom, layers, duplicate/delete, export and the help sheet;
* the keyboard: every tool letter the tooltips advertise, `Ctrl+A/D/Z/Y`,
  `Delete`, `Escape`, arrow nudging and `Alt+←/→` page navigation;
* `__wb.diag()` reports the state support needs (`fresh`, canvas size, dpr,
  socket state, pending ops, latency, broadcast layer);
* an outdated server database (`error: migrate-required`) stops the board with
  a visible explanation instead of reconnecting forever.

## `offline.test.mjs` — the class without a socket

A teacher who runs `runserver` without Redis (or with a channel layer that is
down) still has to be able to open the board and draw — the strokes simply wait
in the outbox. That path is its own suite: boot with a socket that never opens,
draw, watch the op queue, then open the socket and check it is flushed, that the
server echo clears the pending flag *without* applying the op twice, and that a
viewer without the permission stays locked the whole time.

## `dom_contract.test.mjs` — markup ↔ client

A typo in an id or a selector is invisible to the other suites (the client uses
`?.` everywhere, so a missing hook is a silent no-op) and shows up in the
browser as a button that does nothing. This suite regex-scans the client for
every `getElementById` / `$()` / `querySelector` it uses and checks it against
the real room template. Anything created at runtime is listed explicitly with a
reason, and the list is checked for stale entries so it cannot rot. It also
guards the anti-stale-cache contract: both entry points must be requested
through a `?v=<build>` URL.

## `policy.test.mjs` — the connection policy

Everything the media layer decides from measured WebRTC stats is a pure function
in `static/js/net/policy.js`, so it can be pinned down without a browser: the
quality ladder thresholds (and that a handful of packets at startup decides
nothing), that worse quality means lower bitrate / lower frame rate / smaller
picture, that a crowd shrinks every stream (one upload per peer in a mesh), that
a screen share protects resolution and a camera protects motion, that reconnect
delays grow, stay capped and are always jittered, and when a link should be
throttled, ICE-restarted or rebuilt.

## `mesh.test.mjs` — the peer-to-peer media engine

`mesh.js` is what a classroom uses when no LiveKit server is configured, so "the
camera/voice connection is bad" usually means this file. It is driven here with a
scripted `RTCPeerConnection`: the suites assert the *actions*, not the internals —
a starved link gets exactly one `setParameters` (bitrate, frame rate, downscale,
degradation preference), a healthy link is left alone with the browser defaults,
bandwidth is restored when the link recovers, a failed link gets one ICE restart
and is then rebuilt **only by the initiating side** (so the two ends cannot keep
tearing the link down), and the rebuild is rate-limited.

## `mesh_media.test.mjs` — two classmates, one classroom

`mesh.test.mjs` drives one side against a scripted connection, which can never
answer the question the class actually asks: *does the picture arrive?*  This
suite runs **two real `MeshMedia` instances** inside one jsdom document,
connected by `webrtc_sim.mjs` — a small WebRTC simulation with the rules a
browser enforces:

* `addIceCandidate` **throws** while there is no remote description (so a
  candidate that arrives early has to be queued, not dropped);
* a received track starts `muted` and only unmutes when media really flows, then
  mutes again when the sender stops (exactly what `mesh.js` reads to decide
  whether a tile shows a picture);
* `addTrack` reuses a free transceiver of the same kind, offers can collide and
  the polite side rolls back — the perfect-negotiation dance, for real;
* remote streams are keyed by msid, so a second track in the same stream lands
  in the same remote `MediaStream`.

Signalling goes through a relay that behaves like the Django consumer: JSON
round-trip, size cap, per-target delivery, asynchronous hops (and an optional
hostile mode that lets candidates overtake the offer). The checks are the
user-visible facts — the peer's tile shows a video track, the placeholder is
gone, the `<audio>` element still carries the voice, no envelope was dropped:

* two peers negotiate and hear each other (and no ICE candidate is thrown away);
* **turning a camera on after the link is live shows the picture on the other
  side** — the reported bug — without stealing the voice;
* camera off → on again still works (a stale transceiver is the classic failure);
* a peer that starts its camera *before* its mic, and a peer that starts its
  camera *before* anyone joins, are both visible;
* a picture that stalls and recovers comes back on its own (no reconnect);
* a host-disabled camera stays hidden, and a stale camera flag on an **owner**
  cannot hide the owner (the server never applies it — see
  `classrooms/permissions.py`);
* simultaneous camera switches survive an offer collision; a late joiner sees a
  camera that was already on;
* the client and server signal caps are the same number, and an oversized
  envelope is refused on the client *loudly* instead of vanishing.

One running process per suite; `webrtc_sim.mjs` is a test double, not shipped
code — nothing under `static/js/` imports it.

`--dump` exists because the server side needs proof that it accepts what the
client sends: `whiteboard/tests.py::ClientContractTests` replays a captured
session of exactly this shape through the real service layer, and any dumped
file can be re-validated with `whiteboard.protocol.validate_op`.
