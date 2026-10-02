# TURN relay (fixes "we can't see each other" in mesh mode)

## When you need this

VirtualClass uses **LiveKit** when it is configured. Without it, the room
falls back to a **peer-to-peer mesh**: browsers connect straight to each other.
Direct connections break when

* a corporate firewall or a mobile carrier blocks UDP,
* either side sits behind a strict (symmetric) NAT,
* the two peers are on networks that cannot route to each other.

A TURN server is the fallback relay for exactly those cases. The application
code does not change: the browser picks the relay automatically once it is
listed in `WEBRTC_ICE_SERVERS`.

## Run it

```bash
cd deploy/coturn
cp .env.example .env
python3 -c "import secrets; print(secrets.token_hex(16))"   # paste into TURN_SECRET
+ Behind NAT? also uncomment `external-ip` in `turnserver.conf` and set the
  public IP (a cloud VM has a private interface, so the relay must advertise
  the address clients can reach).
$EDITOR .env                      # set TURN_SECRET and TURN_REALM
docker compose up -d
docker compose logs -f
```

Open these ports on the host firewall / cloud security group:

| Port | Protocol | Why |
|---|---|---|
| 3478 | UDP **and** TCP | TURN signalling and TCP relay |
| 49152–65535 | UDP | relayed media |

## Point the app at it

```bash
# .env of the Django project
WEBRTC_ICE_SERVERS=[{"urls":["stun:turn.example.com:3478"]},{"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],"username":"classroom","credential":"PASTE_TURN_SECRET_HERE"}]
```

Restart the app (the list is read at page load). Background: `config/settings.py`
passes it to the room template as `data-ice-servers`, and `static/js/mesh.js`
uses it for every peer connection.

## Verify before a live class

1. <https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>
2. Remove both default servers, add only your `turn:...` URI with the username
   and credential, press **Gather candidates**.
3. A candidate with type **relay** must appear. If it does not, the relay is
   unreachable — check the ports and `TURN_EXTERNAL_IP`.

## Notes

* Keep the credential out of git: `.env` is the only place it should live.
* One small coturn instance is plenty for a classroom (relaying is only needed
  for the peers that cannot connect directly).
* For large classes, configure LiveKit instead — mesh is O(N²) connections.
* When a link still cannot be established, the room now says so on the tile
  ("ارتباط برقرار نشد") with a retry button instead of showing an empty box.
