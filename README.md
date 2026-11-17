# wormhole.page

End-to-end encrypted file transfer in the browser. Drop a file, share the code, done.

Built on [Magic Wormhole](https://magic-wormhole.readthedocs.io/) — fully interoperable with the standard `wormhole` and `wormhole-rs` CLIs. Your files never touch the server.

**Live at [wormhole.page](https://wormhole.page)**

## How it works

Your browser runs a full Magic Wormhole client via WebAssembly (compiled from [wormhole-rs](https://github.com/magic-wormhole/magic-wormhole.rs)). SPAKE2 key exchange and NaCl SecretBox encryption happen entirely client-side — the server only serves static files and bridges WebSocket transit to the public relay.

```
Browser ──WSS──▶ mailbox relay    (SPAKE2 key exchange)
Browser ──WS───▶ our server ──TCP──▶ transit relay  (encrypted data)
CLI ────────────────────TCP────────▶ transit relay  (encrypted data)
```

The server **cannot** decrypt your files. It sees only encrypted transit traffic.

## Usage

### Browser → CLI

1. Open [wormhole.page](https://wormhole.page)
2. Drop a file
3. Share the code with the receiver
4. Receiver runs: `wormhole-rs receive <code>`

### CLI → Browser

1. Run: `wormhole-rs send myfile.txt`
2. Open [wormhole.page](https://wormhole.page)
3. Enter the code and click Receive

### Browser → Browser

Open [wormhole.page](https://wormhole.page) in two tabs (or two devices). Send in one, receive in the other.

### Send text

Click **Send text** (next to *Send a folder*), type or paste a message, and hit **Send text**.
The receiver sees the message inline (with Copy / Download buttons) instead of a file
download. CLI peers receive it as a regular `message.txt` file:

```bash
wormhole-rs receive <code>   # writes message.txt
```

Any small text file received in the browser (`.txt`, `.md`, `.json`, `.csv`, etc., up to
512 KB and decodable as UTF-8) is displayed inline as well — not only messages from this
button. Larger or non-UTF-8 offers fall back to the normal file download path.

## Self-hosting

wormhole.page is a single binary (~5 MB) with zero external dependencies.

### One-click deploy

[![Deploy on Railway](https://img.shields.io/badge/Deploy%20on-Railway-0B0D0E?logo=railway)](https://railway.app/new/template?repo=lucamartinetti/wormhole-page)

### Podman (prebuilt image from GHCR)

Every push to `main` and every `v*` tag builds a **multi-arch** Podman/OCI image
(`linux/amd64` and `linux/arm64`, built natively on x86_64 and ARM runners) via GitHub
Actions and pushes it to the GitHub Container Registry (see
[`.github/workflows/image.yml`](.github/workflows/image.yml)):

```bash
podman pull ghcr.io/dougsko/wormhole-page:latest
podman run -p 8080:8080 ghcr.io/dougsko/wormhole-page:latest
```

Tags: `latest` and `main` track the `main` branch, `sha-<shortsha>` is published for every
build, and `v1.2.3` tags (cut from a `v*` git tag) publish `1.2.3` + `latest`.

> GHCR packages are private by default even for public repos. To pull anonymously, make
> the package public once: GitHub → your profile → **Packages** → `wormhole-page` →
> **Package settings** → **Change visibility** → Public. Otherwise authenticate first with
> `echo $GITHUB_TOKEN | podman login ghcr.io -u <user> --password-stdin`.

### Quadlet (systemd + Podman)

A ready-made [quadlet](https://docs.quadlet.dev/en/latest/) unit is in
[`quadlet/wormhole-page.container`](quadlet/wormhole-page.container). It runs the GHCR
image as a systemd service with `Restart=always`, a read-only root filesystem,
`no-new-privileges`, all capabilities dropped, and `AutoUpdate=registry` so the
`podman-auto-update.timer` can roll out new images automatically.

System-wide install:

```bash
sudo cp quadlet/wormhole-page.container /etc/containers/systemd/
sudo systemctl daemon-reload
sudo systemctl enable --now wormhole-page.service
sudo systemctl enable --now podman-auto-update.timer   # optional, for auto image updates
```

Rootless (per-user) install:

```bash
mkdir -p ~/.config/containers/systemd
cp quadlet/wormhole-page.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now wormhole-page.service
loginctl enable-linger $USER   # keep it running after logout
```

Logs: `journalctl -u wormhole-page.service -f` (or `journalctl --user -u ...`).
Narrow the published port to `127.0.0.1:8080:8080` in the unit if you run behind a
reverse proxy, and set `TRANSIT_RELAY` there to point the WebSocket bridge at your own
upstream transit relay.

### Docker Compose

```bash
docker compose up
```

This builds the image locally from the `Containerfile` and starts the server on port 8080. See [`docker-compose.yml`](docker-compose.yml) for configuration options.

### Container

```bash
podman build -t wormhole-page .
podman run -p 8080:8080 wormhole-page
```

### From source

Requires Rust 1.94+ and wasm-pack.

```bash
git clone https://github.com/lucamartinetti/wormhole-page.git
cd wormhole-web
make build
make run
```

### Configuration

```
wormhole-page-server [OPTIONS]

  --port PORT                 Listen port (default: 8080, env: PORT)
  --static-dir DIR            Static files directory (default: static/, env: STATIC_DIR)
  --transit-relay ADDR        Upstream transit relay for the deployment profile (default: transit.magic-wormhole.io:4001, env: TRANSIT_RELAY)
  --transit-relay-public ADDR Upstream transit relay for the public profile (default: transit.magic-wormhole.io:4001, env: TRANSIT_RELAY_PUBLIC)
  --csp-connect-src SRC       CSP connect-src value (default: 'self' wss://relay.magic-wormhole.io:443, env: CSP_CONNECT_SRC)
  --mailbox-url URL           Deployment default mailbox relay (env: WORMHOLE_MAILBOX_URL)
  --transit-url URL           Deployment default browser transit WS URL (env: WORMHOLE_TRANSIT_URL)
  --transit-hint HINT         TCP hint advertised to CLI peers (env: WORMHOLE_TRANSIT_HINT)
  --profile-name NAME         Display name of the deployment profile in the Settings UI (env: WORMHOLE_PROFILE_NAME)
  --default-profile PROFILE   Which profile the browser preselects: "public" (standard public servers)
                              or "deployment" (env: WORMHOLE_DEFAULT_PROFILE)
```

The `WORMHOLE_*` settings are served to the browser at **`/config.js`**, which the
server generates at startup from its environment — no image rebuild, no mounts. The
same container image works for every deployment; self-hosters just set env vars:

```sh
podman run -p 8080:8080 \
  -e TRANSIT_RELAY=transit.example.com:4001 \
  -e WORMHOLE_MAILBOX_URL=wss://mailbox.example.com/v1 \
  -e WORMHOLE_TRANSIT_HINT=tcp://transit.example.com:4001 \
  -e WORMHOLE_PROFILE_NAME=transit.example.com \
  -e CSP_CONNECT_SRC="'self' wss://mailbox.example.com" \
  ghcr.io/dougsko/wormhole-page:latest
```

By default the Content-Security-Policy is byte-identical to the upstream app,
`connect-src 'self' wss://relay.magic-wormhole.io:443`. To let visitors point the
settings UI at arbitrary relays, loosen it:

```
CSP_CONNECT_SRC="'self' ws: wss:" wormhole-page-server
```

Any invalid `CSP_CONNECT_SRC` (leading/trailing whitespace, control characters) aborts
startup with a clear error instead of silently serving a broken policy. Note that on
HTTPS pages browsers block `ws://` entirely (mixed content) — only `wss://` relays work
for HTTPS visitors regardless of CSP.

#### Client-side overrides (the gear icon)

Click the **gear icon** (top-right, next to the theme toggle). Visitors choose:

- **Standard public servers** (`public`) — the standard Magic Wormhole
  infrastructure: mailbox `wss://relay.magic-wormhole.io:443/v1`, transit via the
  same-origin `/transit/public` bridge (upstream `TRANSIT_RELAY_PUBLIC`, default
  `transit.magic-wormhole.io:4001`). This is the default when
  `WORMHOLE_DEFAULT_PROFILE=public`.
- **<profile name>** (`deployment`; only shown when a deployment profile is
  configured) — the deployment's configured infrastructure (or, when the deployment
  sets nothing, the public Magic Wormhole relay).
- **Custom (advanced)…** — free-form **Mailbox (rendezvous) server**,
  **Transit relay (WebSocket)** and an optional **Transit TCP hint** (the TCP relay
  address advertised to CLI peers, e.g. `tcp://transit.example.com:4001`; defaults to
  the public upstream relay). A **Test connection** button opens a WebSocket to the
  effective mailbox URL and reports whether the handshake succeeds.

Which option is preselected is controlled by `WORMHOLE_DEFAULT_PROFILE` (`public` or
`deployment`; empty = `deployment` when the deployment profile is configured, else
`public`); the other of the two is offered as the alternative. The browser transits
through a same-origin bridge either way — `/transit` for the deployment profile
(upstream `TRANSIT_RELAY`), `/transit/public` for the public one.

Both relay URLs accept `ws://` and `wss://` URLs and are validated on save (empty field
= deployment default). Settings are stored in that browser's `localStorage`
(`wormhole-settings`, never sent to the server), apply to the next transfer, and can be
cleared with **Reset to defaults** (or by switching the profile back). A dot on the gear
icon indicates custom relays are active.

| Setting | Default | Purpose |
|---|---|---|
| Mailbox server | `wss://relay.magic-wormhole.io:443/v1` (public profile) / `WORMHOLE_MAILBOX_URL` (deployment profile) | Mailbox (rendezvous) relay for SPAKE2 key exchange |
| Transit relay | `wss://<host>/transit/public` (public) / `wss://<host>/transit` (deployment) | WebSocket URL for the transit relay bridge |
| Transit TCP hint | `tcp://transit.magic-wormhole.io:4001` (upstream) | TCP relay hint advertised to CLI peers |

Resolution order (lowest → highest priority): built-in default → `/config.js` (operator
env, incl. `defaultProfile`) → `window.WORMHOLE_*` legacy `<script>` injection (still
honored) → the profile chosen in `localStorage` (`public` / `deployment` / `custom`).

> **Note (custom transit relays):** the TCP hint advertised to CLI peers is fully
> configurable (`WORMHOLE_TRANSIT_HINT` / the custom profile's TCP hint field). With
> defaults, both the browser bridge and the hint reach the public upstream relay. On a
> private deployment, set the hint to *your* TCP relay (e.g. `tcp://wormhole.dougsko.com:4001`)
> so CLI peers meet your browser instead of the public one.

## License

MIT
