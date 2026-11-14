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

## Self-hosting

wormhole.page is a single binary (~5 MB) with zero external dependencies.

### One-click deploy

[![Deploy on Railway](https://img.shields.io/badge/Deploy%20on-Railway-0B0D0E?logo=railway)](https://railway.app/new/template?repo=lucamartinetti/wormhole-page)

### Podman (prebuilt image from GHCR)

Every push to `main` and every `v*` tag builds a Podman/OCI image via GitHub Actions and
pushes it to the GitHub Container Registry (see [`.github/workflows/image.yml`](.github/workflows/image.yml)):

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

  --port PORT              Listen port (default: 8080, env: PORT)
  --static-dir DIR         Static files directory (default: static/, env: STATIC_DIR)
  --transit-relay ADDR     Upstream transit relay (default: transit.magic-wormhole.io:4001, env: TRANSIT_RELAY)
```

#### Client-side overrides

Visitors can point their own browser at different relays from the web UI — no rebuild or
redeploy needed. Click the **gear icon** (top-right, next to the theme toggle) and set:

- **Mailbox (rendezvous) server** — used for the SPAKE2 key exchange
- **Transit relay** — WebSocket URL of the transit relay bridge

Both accept `ws://` and `wss://` URLs and are validated on save (empty field = default).
The settings are stored in that browser's `localStorage` (`wormhole-settings`, nothing is
sent to the server), apply to the next transfer, and can be cleared with **Reset to
defaults**. A dot on the gear icon indicates custom relays are active.

| Variable | Default | Purpose |
|---|---|---|
| Mailbox server | `wss://relay.magic-wormhole.io:443/v1` | Mailbox (rendezvous) relay for SPAKE2 key exchange |
| Transit relay | `wss://<host>/transit` | WebSocket URL for the transit relay bridge |

Operators can also inject the classic `<script>`-tag override before the app loads; an
operator-injected value acts as the default, which each visitor can still override in the
modal. Priority: modal setting → `window.WORMHOLE_*` global → built-in default.

```html
<script>
  window.WORMHOLE_TRANSIT_RELAY = 'wss://my-relay.example.com/transit';
  window.WORMHOLE_MAILBOX_URL   = 'wss://my-mailbox.example.com/v1';
</script>
```

> **Note (custom transit relays):** the WASM client always advertises the public TCP
> relay (`tcp://transit.magic-wormhole.io:4001`) as an additional relay hint, so CLI
> peers may pick the public relay even if your browser is on a custom one and fail to
> meet. The defaults are unaffected (both hints reach the same upstream relay). See
> [TODOS.md](TODOS.md) for the follow-up. The server operator's upstream transit
> relay remains configurable via `--transit-relay` / `TRANSIT_RELAY` on the server.

## License

MIT
