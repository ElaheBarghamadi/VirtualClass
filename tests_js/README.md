# Whiteboard client tests (headless)

The browser half of the whiteboard is a handful of plain ES modules
(`static/js/whiteboard.js` + `static/js/wb/*.js`). These tests run that **real
code** in [jsdom](https://github.com/jsdom/jsdom) with a real 2D canvas
(`@napi-rs/canvas`) and a fake WebSocket, so the engine can be exercised
without a browser or a Django server.

```bash
cd tests_js
npm install
npm test              # 43 checks
npm test -- --dump    # ...and write .build/ops.json (every frame the client sent)
```

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

`--dump` exists because the server side needs proof that it accepts what the
client sends: `whiteboard/tests.py::ClientContractTests` replays a captured
session of exactly this shape through the real service layer.
