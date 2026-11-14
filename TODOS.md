# TODOS

## P2: SRI hashes for WASM module
Add SHA-384 integrity attributes to WASM `<script>` tag so browsers verify the
file hasn't been tampered with. Build step generates hash, injects into HTML.
Mitigates compromised-server attacks.
- Effort: S
- Depends on: WASM E2E encryption (must ship first)

## P2: Configurable relay URLs — DONE
Mailbox and transit relay URLs are configurable per-user from the web UI
(gear icon → Settings modal). The modal now offers a profile dropdown: the
deployment default (server-generated `/config.js`, env-configured) or a
"Custom (advanced)…" free-form override with format-checked URLs, a CLI-peer
TCP hint field, and a Test connection button. localStorage schema v2 with
transparent v1 migration. See README "Client-side overrides (the gear icon)".

## P3: Custom transit relay hint for CLI peers — DONE
`WormholeSender/Receiver::create` take an optional `transit_peer_hint`
(`Some(tcp://…)` overrides the advertised TCP hint, `Some("")` advertises the
bridge only, `undefined`/omitted = public upstream relay). Wired from the
Settings gear's TCP-hint field and the server's `WORMHOLE_TRANSIT_HINT` env
(served at `/config.js`). wasm rebuilt and committed under `static/wasm/`.

## P3: Native text-offer interop (`wormhole/text-or-file-xfer`)
The browser currently sends "text" as an in-memory `message.txt` file, which every
receiver understands, but it is NOT the `--text` message offer used by Python's
`wormhole send --text`. To interoperate natively, the forked crate
(lucamartinetti/magic-wormhole.rs, branch wasm-time-fix) needs a `send_message`
(PeerMessage::Offer(Message(..)) + MessageAck) path and request() must accept Message
offers; then the WASM crate and wasm-client.js expose/receive text. WASM rebuild
required — that is why this wasn't done in the browser.
- Effort: M
- Depends on: Rust toolchain with wasm-pack

## P3: beforeunload warning during active transfer
Show browser's "Leave site?" dialog when transfer is in progress and user
tries to close tab or navigate away. Prevents accidental transfer abort.
- Effort: S
- Depends on: WASM E2E encryption

## P2: Replace vendored wormhole-rs with git fork
`crates/magic-wormhole-patched/` is 18,000 lines of vendored upstream for a
3-line `#[cfg(not(target_family = "wasm"))]` patch on `std::time::Instant`.
Fork wormhole-rs on GitHub, push just the fix commit, switch Cargo.toml to
a git dependency. Or upstream the patch to magic-wormhole.rs.
- Effort: S
- Depends on: Rust rewrite (clean up during or after)
