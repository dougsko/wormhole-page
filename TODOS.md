# TODOS

## P2: SRI hashes for WASM module
Add SHA-384 integrity attributes to WASM `<script>` tag so browsers verify the
file hasn't been tampered with. Build step generates hash, injects into HTML.
Mitigates compromised-server attacks.
- Effort: S
- Depends on: WASM E2E encryption (must ship first)

## P2: Configurable relay URLs — DONE (UI variant)
Mailbox and transit relay URLs are configurable per-user from the web UI
(gear icon → Settings modal, stored in localStorage, ws:/wss:, format-checked).
Defaults remain the public relays. See README "Client-side overrides".
- Effort: S
- Remaining gap: the WASM client unconditionally advertises the public TCP
  relay (tcp://transit.magic-wormhole.io:4001) as an extra relay hint. With a
  *custom* transit bridge, a CLI peer that picks that hint fails to meet the
  browser. Fix: pass a peer-relay-hint override into the WASM `create()` and
  rebuild `static/wasm/` (needs Rust toolchain). Track separately.

## P3: Custom transit relay hint for CLI peers (WASM rebuild)
Add an optional peer-relay-hint argument to `WormholeSender/Receiver::create`
(or a new exported setter), rebuild the committed WASM, and have wasm-client.js
advertise only the configured transit URL when it differs from the default.
- Effort: S-M
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
