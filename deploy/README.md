# Runbook: wormhole.dougsko.com behind Caddy (HTTPS)

Goal: app served as `https://wormhole.dougsko.com`, browser reachable
self-hosted mailbox as `wss://mailbox.wormhole.dougsko.com`, transit relay
left on plain TCP at `wormhole.dougsko.com:4001` (only the app server
connects to it — no TLS needed).

Current state: app is HTTP on :8080, mailbox is plain WS on :4000 and open
to the world (leave it — plain-WS CLI clients use it as today).

                ┌─────────────┐   http :8080   ┌───────────────────────────┐
 browsers ─────▶│    caddy    │───────────────▶│ wormhole-page (this repo) │──┐
                │ 80/443 tcp  │                └───────────────────────────┘  │ TCP :4001
                │             │   :443 wss     ┌───────────────────────────┐  ▼
 browsers ─────▶│            │───────────────▶│ mailbox container (:4000)  │  transit relay
                └─────────────┘                └───────────────────────────┘

## 0. Prerequisites

- DNS **A records** (both → this host), or caddy can't get certs:
  `wormhole.dougsko.com`, `mailbox.wormhole.dougsko.com`
- Inbound **80 and 443** open (Let's Encrypt HTTP-01). Keep 8080 shut to the world.
- The mailbox container reachable on `127.0.0.1:4000`. If it publishes
  `0.0.0.0:4000`, fine; with `Network=host` caddy reaches it at 127.0.0.1.

## 1. Install caddy

    # edit the email in caddy/Caddyfile first
    sudo mkdir -p /etc/caddy
    sudo cp caddy/Caddyfile /etc/caddy/Caddyfile
    sudo cp quadlet/caddy.container /etc/containers/systemd/
    sudo systemctl daemon-reload
    sudo systemctl enable --now caddy.service
    journalctl -u caddy.service -f   # watch for cert issuance on first start

Caddy auto-fetches certs for both site blocks and serves 80 → 443 redirects
plus WebSocket upgrades with no extra config.

## 2. Install / reinstall the app quadlet

The app unit in this repo is generic; create a deployment override instead of
editing the tracked file, e.g. `/etc/containers/systemd/wormhole-page.container`
containing the app quadlet plus:

    Environment=TRANSIT_RELAY=wormhole.dougsko.com:4001
    Environment=WORMHOLE_MAILBOX_URL=wss://mailbox.wormhole.dougsko.com/v1
    Environment=WORMHOLE_TRANSIT_HINT=tcp://wormhole.dougsko.com:4001
    Environment=WORMHOLE_PROFILE_NAME=wormhole.dougsko.com
    Environment=CSP_CONNECT_SRC="'self' wss://mailbox.wormhole.dougsko.com"

(Optionally `WORMHOLE_TRANSIT_URL=` if browsers should use a non-bridge
WebSocket transit; usually unnecessary — same-origin /transit + TRANSIT_RELAY
is the right shape.)

    sudo cp quadlet/wormhole-page.container /etc/containers/systemd/   # then edit in place
    sudo systemctl daemon-reload
    sudo systemctl restart wormhole-page.service   # restart, not just reload

## 3. How visitors pick infrastructure (nothing to deploy)

The server generates `/config.js` from the environment at startup (never
cached, no image rebuild). The Settings gear (top-right) then offers:

- **"wormhole.dougsko.com (default)"** — your infrastructure (what you just deployed)
- **"Custom (advanced)…"** — free-form mailbox / transit / TCP-hint fields for
  someone who wants yet another relay; per-browser, stored in localStorage

Visitors never see a raw env var; they just pick from a dropdown. Switching
back to your infrastructure = selecting the default profile.

## 4. Verify

    curl -fsSI https://wormhole.dougsko.com/                 # 200, CSP has wss://mailbox...
    curl -fsSI https://wormhole.dougsko.com/sw.js             # no-cache header
    curl -sS https://wormhole.dougsko.com/config.js            # window.WORMHOLE_CONFIG = {...}
    curl -sS -i --max-time 5 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: x' \
      https://mailbox.wormhole.dougsko.com/v1 | head -3       # expect HTTP/1.1 101 + welcome frame
    # plain-WS CLI still works (unchanged):
    wormhole send --relay-url=ws://wormhole.dougsko.com:4000 somefile

Then a real transfer: send a file in one browser, receive in another,
and confirm https://wormhole.dougsko.com shows the 🔒 badge.

## Gotchas

- **Transit relay address inside the app container**: `TRANSIT_RELAY` is dialed
  by the *server process inside the container*. `127.0.0.1:4001` means the
  container's loopback, **not the host's** — the bridge will fail with
  `Connection refused` while the browser side appears to work. If the
  mailbox/relay run on the same host, either run the app container with
  `Network=host` (then 127.0.0.1 works) or set `TRANSIT_RELAY` to the
  podman bridge gateway (e.g. `10.88.0.1:4001`, see
  `podman network inspect podman`) or another host-reachable IP. DNS names
  work fine as long as they resolve from inside the container.
- **HSTS**: the app sends `includeSubDomains`, so after one visit all
  subdomains of wormhole.dougsko.com are HTTPS-only. wss mailbox complies.
- **Leave :4000 alone**: plain WS on :4000 stays available for CLI clients;
  only browsers (mixed-content blocked) must use the wss subdomain.
- **CLI ↔ browser via custom transit**: the browser still advertises the
  public `tcp://transit.magic-wormhole.io:4001` as an extra relay hint, so a
  CLI peer may pick the public relay and fail to meet your browser on your
  transit. Browser↔browser via the bridge is fine; CLI↔browser needs the
  WASM peer-relay-hint fix (TODOS.md, P3).
- **Analytics**: uncomment the two-line `@umami` block in the Caddyfile to
  404 the built-in Umami proxy (/a/*).
- Certs live in the `caddy-data` volume; deleting it forces re-issuance and
  can hit Let's Encrypt rate limits.
