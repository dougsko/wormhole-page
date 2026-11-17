use axum::{
    Router,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{StatusCode, header::{HeaderName, HeaderValue}},
    response::{Html, IntoResponse},
    body::Body,
};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio::net::TcpStream;
use tower_http::services::ServeDir;

/// wormhole.page — E2E encrypted file transfer in the browser.
#[derive(Parser)]
struct Args {
    /// Port to listen on
    #[arg(long, default_value = "8080", env = "PORT")]
    port: u16,

    /// Directory containing static files (index.html, wasm/, etc.)
    #[arg(long, default_value = "static", env = "STATIC_DIR")]
    static_dir: PathBuf,

    /// Upstream transit relay address (TCP). Dialed by the /transit bridge;
    /// used by the deployment (e.g. self-hosted) profile.
    #[arg(
        long,
        default_value = "transit.magic-wormhole.io:4001",
        env = "TRANSIT_RELAY"
    )]
    transit_relay: String,

    /// Upstream transit relay address (TCP). Dialed by the /transit/public
    /// bridge; used by the built-in "standard public servers" profile.
    #[arg(
        long,
        default_value = "transit.magic-wormhole.io:4001",
        env = "TRANSIT_RELAY_PUBLIC"
    )]
    transit_relay_public: String,

    /// Value for the CSP `connect-src` directive (single-quoted sources, space-separated).
    /// Default matches upstream wormhole.page; use "'self' ws: wss:" to allow any relay
    /// for the browser client's mailbox/transit settings.
    #[arg(
        long,
        default_value = "'self' wss://relay.magic-wormhole.io:443",
        env = "CSP_CONNECT_SRC"
    )]
    csp_connect_src: String,

    /// Mailbox (rendezvous) relay URL to advertise to the browser as the
    /// deployment default. Empty = built-in default (public Magic Wormhole
    /// relay). Served to the client at /config.js.
    #[arg(long, default_value = "", env = "WORMHOLE_MAILBOX_URL")]
    mailbox_url: String,

    /// Transit URL (WebSocket) to advertise as the deployment default.
    /// Empty = same-origin /transit bridge. Served to the client at /config.js.
    #[arg(long, default_value = "", env = "WORMHOLE_TRANSIT_URL")]
    transit_url: String,

    /// TCP relay hint advertised to the CLI peer by the WASM client.
    /// Empty = advertise the public upstream relay (upstream default).
    /// Served to the client at /config.js.
    #[arg(long, default_value = "", env = "WORMHOLE_TRANSIT_HINT")]
    transit_hint: String,

    /// Display name for the deployment profile shown in the Settings UI
    /// (e.g. "wormhole.dougsko.com"). Empty = "Deployment default".
    #[arg(long, default_value = "", env = "WORMHOLE_PROFILE_NAME")]
    profile_name: String,

    /// Which profile the browser preselects in the Settings UI: "public"
    /// (standard Magic Wormhole servers) or "deployment". Empty = "deployment"
    /// when the deployment profile is configured, else "public".
    /// Served to the client at /config.js as defaultProfile.
    #[arg(long, default_value = "", env = "WORMHOLE_DEFAULT_PROFILE")]
    default_profile: String,

    /// Build/version identifier shown in the UI footer and served at /version.
    /// Set by the image build to the git short SHA (ARG GIT_SHA → ENV WORMHOLE_VERSION).
    #[arg(long, default_value = "dev", env = "WORMHOLE_VERSION")]
    version: String,
}

/// Build the full Content-Security-Policy from a connect-src value.
fn build_csp(connect_src: &str) -> Option<HeaderValue> {
    let csp = format!(
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src {connect_src}; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );
    HeaderValue::from_str(&csp).ok()
}

#[derive(Clone)]
struct AppState {
    index_html: Arc<String>,
    service_worker: Arc<String>,
    transit_relay: Arc<String>,
    transit_relay_public: Arc<String>,
    csp: HeaderValue,
    http_client: reqwest::Client,
    config_js: Arc<String>,
    version: Arc<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args = Args::parse();
    let config_js = build_config_js(&args);

    // Read index.html at startup for SPA fallback
    let index_path = args.static_dir.join("index.html");
    let index_html = std::fs::read_to_string(&index_path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {e}", index_path.display()));

    // Read sw.js at startup for root-scoped service worker
    let sw_path = args.static_dir.join("sw.js");
    let service_worker = std::fs::read_to_string(&sw_path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {e}", sw_path.display()));

    let transit_relay = args.transit_relay;
    let transit_relay_public = args.transit_relay_public;
    let csp = build_csp(&args.csp_connect_src).unwrap_or_else(|| {
        panic!(
            "Invalid CSP_CONNECT_SRC {:?}: must be a valid header value \
             (no leading/trailing whitespace or control characters)",
            args.csp_connect_src
        )
    });
    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("failed to build HTTP client");

    let state = AppState {
        index_html: Arc::new(index_html),
        service_worker: Arc::new(service_worker),
        transit_relay: Arc::new(transit_relay.clone()),
        transit_relay_public: Arc::new(transit_relay_public.clone()),
        csp,
        http_client,
        config_js: Arc::new(config_js),
        version: Arc::new(args.version.clone()),
    };

    // Static file service
    let static_service = ServeDir::new(&args.static_dir);

    let app = Router::new()
        .route("/health", axum::routing::get(health))
        .route("/sw.js", axum::routing::get(serve_sw))
        .route("/config.js", axum::routing::get(serve_config_js))
        .route("/version", axum::routing::get(serve_version))
        .route("/transit", axum::routing::get(transit_ws))
        .route("/transit/public", axum::routing::get(transit_ws_public))
        .route("/a/script.js", axum::routing::get(analytics_script))
        .route("/a/api/send", axum::routing::post(analytics_event))
        // SPA fallback: /receive/<code> serves index.html
        .route("/receive/{code}", axum::routing::get(spa_fallback))
        // Static files under /static/
        .nest_service("/static", static_service)
        // Root serves index.html
        .fallback(axum::routing::get(root_or_404))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], args.port));
    tracing::info!("wormhole.page listening on {addr}");
    tracing::info!("transit bridge (deployment) → {transit_relay}");
    tracing::info!("transit bridge (public)      → {transit_relay_public}");

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

/// Escape a string for inclusion as a JSON string literal (and thus a JS
/// string literal). Only the characters JSON requires are escaped.
fn js_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\u{2028}' => out.push_str("\\u2028"),
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// Build the /config.js body from operator environment. Purely static —
/// computed once at startup. Fields are always present; empty string =
/// "not configured" (the client falls back to its built-in default).
fn build_config_js(args: &Args) -> String {
    format!(
        "window.WORMHOLE_CONFIG = {{\"mailboxUrl\":\"{}\",\"transitUrl\":\"{}\",\"transitTcpHint\":\"{}\",\"profileName\":\"{}\",\"defaultProfile\":\"{}\",\"version\":\"{}\"}};\n",
        js_string(&args.mailbox_url),
        js_string(&args.transit_url),
        js_string(&args.transit_hint),
        js_string(&args.profile_name),
        js_string(&args.default_profile),
        js_string(&args.version),
    )
}

/// Middleware that adds security headers to every response.
async fn security_headers(
    State(state): State<AppState>,
    req: axum::http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> impl IntoResponse {
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        state.csp.clone(),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("strict-transport-security"),
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    response
}

/// GET /health
async fn health() -> &'static str {
    "ok"
}

/// GET /version — build identifier (git short SHA, or "dev" for local builds).
/// Handy for verifying which image is actually serving traffic.
async fn serve_version(State(state): State<AppState>) -> impl IntoResponse {
    (
        [
            (
                HeaderName::from_static("content-type"),
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (
                HeaderName::from_static("cache-control"),
                HeaderValue::from_static("no-store"),
            ),
        ],
        format!("wormhole-page {}\n", state.version),
    )
}

/// GET /config.js — deployment configuration for the browser client.
/// Generated once at startup from the operator's environment; never
/// cacheable so changing the env takes effect on restart without a rebuild.
async fn serve_config_js(State(state): State<AppState>) -> impl IntoResponse {
    (
        [
            (
                HeaderName::from_static("content-type"),
                HeaderValue::from_static("application/javascript; charset=utf-8"),
            ),
            (
                HeaderName::from_static("cache-control"),
                HeaderValue::from_static("no-store"),
            ),
        ],
        state.config_js.as_str().to_string(),
    )
}

/// GET /sw.js — serve the service worker from root scope with no-cache
async fn serve_sw(State(state): State<AppState>) -> impl IntoResponse {
    (
        [
            (
                HeaderName::from_static("content-type"),
                HeaderValue::from_static("application/javascript"),
            ),
            (
                HeaderName::from_static("cache-control"),
                HeaderValue::from_static("no-cache"),
            ),
        ],
        state.service_worker.as_str().to_string(),
    )
}

/// GET /a/script.js — proxy Umami analytics script
async fn analytics_script(State(state): State<AppState>) -> impl IntoResponse {
    match state
        .http_client
        .get("https://cloud.umami.is/script.js")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let body = resp.bytes().await.unwrap_or_default();
            (
                StatusCode::OK,
                [
                    (
                        HeaderName::from_static("content-type"),
                        HeaderValue::from_static("application/javascript"),
                    ),
                    (
                        HeaderName::from_static("cache-control"),
                        HeaderValue::from_static("public, max-age=86400"),
                    ),
                ],
                body,
            )
                .into_response()
        }
        _ => StatusCode::BAD_GATEWAY.into_response(),
    }
}

/// POST /a/api/send — proxy Umami analytics event
async fn analytics_event(
    State(state): State<AppState>,
    req: axum::http::Request<Body>,
) -> impl IntoResponse {
    let body = match axum::body::to_bytes(req.into_body(), 8192).await {
        Ok(b) => b,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match state
        .http_client
        .post("https://api-gateway.umami.dev/api/send")
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let body = resp.bytes().await.unwrap_or_default();
            (status, body).into_response()
        }
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

/// GET / (and fallback for unknown routes)
async fn root_or_404(
    State(state): State<AppState>,
    req: axum::http::Request<axum::body::Body>,
) -> impl IntoResponse {
    if req.uri().path() == "/" {
        Html(state.index_html.as_str().to_string()).into_response()
    } else {
        StatusCode::NOT_FOUND.into_response()
    }
}

/// GET /receive/<code> — serve index.html (SPA, JS handles the code)
async fn spa_fallback(State(state): State<AppState>) -> Html<String> {
    Html(state.index_html.as_str().to_string())
}

/// GET /transit — WebSocket-to-TCP bridge
///
/// Bridges a browser WebSocket connection to the upstream transit relay
/// via TCP. Both the browser and CLI peer meet at the same public relay.
///
///   Browser ──WS──▶ this server ──TCP──▶ transit.magic-wormhole.io:4001
///   CLI ──────────────────TCP──────────▶ transit.magic-wormhole.io:4001
async fn transit_ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_transit(socket, state.transit_relay))
}

async fn transit_ws_public(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_transit(socket, state.transit_relay_public))
}

async fn handle_transit(ws: WebSocket, relay_addr: Arc<String>) {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    tracing::info!("transit bridge: browser connected");
    let start = std::time::Instant::now();

    // Connect to upstream TCP relay with a timeout
    let tcp = match tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(relay_addr.as_str()),
    )
    .await
    {
        Ok(Ok(stream)) => {
            // Set TCP keepalive to detect dead connections
            let sock_ref = socket2::SockRef::from(&stream);
            let keepalive = socket2::TcpKeepalive::new()
                .with_time(Duration::from_secs(30))
                .with_interval(Duration::from_secs(10));
            let _ = sock_ref.set_tcp_keepalive(&keepalive);
            stream
        }
        Ok(Err(e)) => {
            tracing::warn!("transit bridge: upstream connect failed: {e}");
            let (mut sink, _) = ws.split();
            let _ = sink
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1011,
                    reason: "upstream relay unreachable".into(),
                })))
                .await;
            return;
        }
        Err(_) => {
            tracing::warn!("transit bridge: upstream connect timed out (10s)");
            let (mut sink, _) = ws.split();
            let _ = sink
                .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1011,
                    reason: "upstream relay connect timeout".into(),
                })))
                .await;
            return;
        }
    };

    tracing::info!("transit bridge: connected to upstream relay");

    let (tcp_read, tcp_write) = tcp.into_split();
    let (mut ws_sink, mut ws_stream) = ws.split();

    let ws_to_tcp_bytes = Arc::new(AtomicU64::new(0));
    let tcp_to_ws_bytes = Arc::new(AtomicU64::new(0));

    // WS → TCP: forward browser messages to upstream relay
    let ws_to_tcp_count = ws_to_tcp_bytes.clone();
    let ws_to_tcp = async move {
        let mut tcp_write = tokio::io::BufWriter::new(tcp_write);
        while let Some(msg) = ws_stream.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    let len = data.len() as u64;
                    // Use a timeout on TCP write to avoid hanging on stalled relay
                    match tokio::time::timeout(
                        Duration::from_secs(30),
                        async {
                            tcp_write.write_all(&data).await?;
                            tcp_write.flush().await
                        },
                    )
                    .await
                    {
                        Ok(Ok(())) => {
                            ws_to_tcp_count.fetch_add(len, Ordering::Relaxed);
                        }
                        Ok(Err(e)) => {
                            tracing::warn!("transit bridge: TCP write error: {e}");
                            break;
                        }
                        Err(_) => {
                            tracing::warn!("transit bridge: TCP write timeout (30s)");
                            break;
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    tracing::debug!("transit bridge: WS close frame received");
                    break;
                }
                Err(e) => {
                    tracing::warn!("transit bridge: WS read error: {e}");
                    break;
                }
                _ => {} // ignore text, ping, pong
            }
        }
        // Flush any remaining data before dropping
        let _ = tcp_write.flush().await;
        let _ = tcp_write.shutdown().await;
    };

    // TCP → WS: forward upstream relay data to browser
    let tcp_to_ws_count = tcp_to_ws_bytes.clone();
    let tcp_to_ws = async move {
        let mut tcp_read = tokio::io::BufReader::new(tcp_read);
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            // Timeout on TCP read — if the relay goes silent for 2 minutes,
            // the connection is likely dead
            match tokio::time::timeout(Duration::from_secs(120), tcp_read.read(&mut buf)).await {
                Ok(Ok(0)) => {
                    tracing::debug!("transit bridge: TCP EOF");
                    break;
                }
                Ok(Ok(n)) => {
                    tcp_to_ws_count.fetch_add(n as u64, Ordering::Relaxed);
                    if ws_sink
                        .send(Message::Binary(buf[..n].to_vec().into()))
                        .await
                        .is_err()
                    {
                        tracing::warn!("transit bridge: WS send failed");
                        break;
                    }
                }
                Ok(Err(e)) => {
                    tracing::warn!("transit bridge: TCP read error: {e}");
                    break;
                }
                Err(_) => {
                    tracing::warn!("transit bridge: TCP read timeout (120s), closing");
                    break;
                }
            }
        }
        // Send close frame to browser
        let _ = ws_sink
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1000,
                reason: "relay closed".into(),
            })))
            .await;
    };

    // Run both directions concurrently; when either finishes, the other is dropped.
    // This is correct for a bidirectional proxy — once one side closes, the bridge
    // is no longer functional. The flush/shutdown above ensures pending data is sent.
    tokio::select! {
        _ = ws_to_tcp => tracing::debug!("transit bridge: WS→TCP finished"),
        _ = tcp_to_ws => tracing::debug!("transit bridge: TCP→WS finished"),
    }

    let elapsed = start.elapsed();
    let ws_bytes = ws_to_tcp_bytes.load(Ordering::Relaxed);
    let tcp_bytes = tcp_to_ws_bytes.load(Ordering::Relaxed);
    tracing::info!(
        "transit bridge: closed after {:.1}s (WS→TCP: {} bytes, TCP→WS: {} bytes)",
        elapsed.as_secs_f64(),
        ws_bytes,
        tcp_bytes,
    );
}
