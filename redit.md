# Reddit post — Postie

Below are a few drop-in versions of the post depending on the subreddit. Pick whichever fits, swap the repo URL in, and you're good to go. Each one is written to read as a personal project share, not a sales pitch — that tends to land better and avoid auto-removal on r/programming.

---

## Version A — r/SideProject (casual, hobbyist)

**Title:** I built a local-first Postman alternative in Electron + Rust — no login, no cloud, no telemetry

**Body:**

Hey folks. I got tired of Postman nagging me to log in, sync my collections to the cloud, and gating features behind a team plan, so I spent a few weekends building **Postie** — a local-first API client that does the things I actually use Postman for.

Stack:
- **Electron** for the UI (vanilla JS, CodeMirror for editors)
- **Rust** sidecar for the actual HTTP work (`reqwest` + `axum` + `tokio`) — talks to the renderer over a tiny REST API on a random localhost port
- **Local-first storage** — everything lives in a single `workspace.json` on disk, no accounts, no sync, no telemetry

What it can do today (v1.1.0):
- All the usual HTTP methods, headers, query params, body types (JSON, XML, form-data, urlencoded, raw, binary file)
- Environments with `{{var}}` substitution + a Tests tab with a `pm.*` shim (`pm.test`, `pm.expect`, `pm.environment.set/get`) so post-response scripts and request chaining work
- **Import Postman collections** (v2.1) and environments — and **export** back out, so it round-trips
- Paste a `curl` command into the URL bar and it parses method, URL, headers, query, body, and auth
- Copy any request as `curl`
- Proxy support (HTTP/HTTPS/SOCKS5) with bypass rules
- Open tabs and last response survive a reload
- Method-color tinted pills, syntax-highlighted bodies, dark UI

Cross-platform builds:
- macOS (Apple Silicon) `.dmg`
- Linux (Debian/Ubuntu) `.deb`
- Windows `.exe` (NSIS installer + portable)

There's a one-line install script per platform that handles the Gatekeeper / SmartScreen warnings (since the binaries aren't notarized — code-signing certs aren't free).

It's not feature-complete vs Postman — no GraphQL UI, no WebSocket support, no team sync (intentionally), no monitors, no mock servers. But for "I just want to fire off some HTTP requests and not be logged out every two weeks," it's been solid for me.

Repo: <https://github.com/YOUR_USERNAME/Postie>

Happy to take feedback, especially on what feels missing or rough. Genuinely my first time building an Electron + Rust hybrid so the IPC plumbing was the most interesting part.

---

## Version B — r/rust (lead with the Rust angle)

**Title:** Postie — a Postman alternative with a Rust HTTP sidecar (Electron renderer + axum/reqwest backend)

**Body:**

Sharing a side project I just shipped v1.1.0 of: **Postie**, a local-first API client. The interesting bit (for this sub) is the architecture — the Electron renderer doesn't make HTTP requests directly; it talks to a Rust binary that runs as a sidecar.

**Why split it:**
- `reqwest` already does everything I'd need to bolt onto `node:fetch` — gzip/brotli/deflate decompression, multipart form-data with file streaming, SOCKS5 proxy, configurable redirect policy, cert validation toggle.
- Keeps the UI process thin — the renderer is just sending JSON to a localhost port.
- Means the same backend binary can be reused later (CLI? VSCode extension? CI runner?) without dragging Electron with it.

**Stack on the Rust side:**
- `axum` for the local REST API (one process, bound to `127.0.0.1:<random-port>`)
- `reqwest` (with `gzip`/`brotli`/`deflate`/`socks` features) for outbound HTTP
- `tokio` runtime
- `serde` for everything wire-shaped — the `Body` enum is adjacently-tagged so the JSON shape stays clean
- `flate2` + `brotli` as fallbacks for servers that mislabel content-encoding

**Cross-compilation:**
- macOS arm64: native `cargo build`
- Linux x64: `cargo zigbuild --target x86_64-unknown-linux-musl` (fully static, no glibc dependency, runs on anything from Debian 10 up)
- Windows x64: `cargo zigbuild --target x86_64-pc-windows-gnu`

All three builds are produced from a Mac, no VMs.

**Things that surprised me:**
- `url::Url::parse` happily parses `localhost:3000/foo` "successfully" because dots are legal in scheme syntax — the bogus scheme then explodes inside reqwest. Had to do an explicit `starts_with("http://") || starts_with("https://")` check to match Postman's schemeless-default behavior.
- `reqwest` strips the `Content-Encoding` header on auto-decompression success but leaves it intact on failure, which I use as a signal to fall back to manual `flate2`/`brotli` decoding.
- The `Body::None` adjacently-tagged variant must NOT carry a `content` field — serde rejects the payload otherwise. That cost me an evening.

Repo: <https://github.com/YOUR_USERNAME/Postie>

Roasts welcome on the Rust side specifically. The renderer is vanilla JS so don't bother :)

---

## Version C — r/programming (technical, neutral)

**Title:** Postie — local-first Postman alternative built with Electron + Rust

**Body:**

I've been building a Postman-like API client called **Postie** in my spare time and just cut v1.1.0. Sharing in case the architecture is interesting or the result is useful.

**The pitch:** local-first (no accounts, no sync, no telemetry), Postman v2.1 import/export, and a `pm.*`-compatible Tests tab so existing test scripts work without rewriting.

**Architecture:**
- **Electron renderer** (vanilla JS, CodeMirror) — pure UI, no HTTP work.
- **Rust sidecar** spawned by Electron at boot, binding to `127.0.0.1:<random-port>` and exposing a small REST API. Renderer hits it via `fetch`. All actual outbound HTTP is `reqwest`.
- Single `workspace.json` on disk holds collections, environments, history, settings.

**What's in v1.1.0:**
- HTTP methods, headers, query params, all the body types (JSON/XML/form-data/urlencoded/raw/binary), basic/bearer/API-key auth, proxy support with bypass rules.
- Environments with `{{var}}` substitution.
- Import + export Postman collections (v2.1). Round-trips through the same shape.
- Tests tab with a `pm.*` API subset (`pm.test`, `pm.expect`, `pm.environment.set/get`, `pm.response.*`) — chaining works because `pm.environment.set()` writes through to the active environment.
- Paste a `curl` command into the URL bar; Postie parses method/URL/headers/query/body/auth.
- Tabs, last response, and test results all persist across reloads.
- Cross-platform builds: macOS (Apple Silicon dmg), Linux (Debian/Ubuntu deb), Windows (x64 NSIS + portable exe).

**Honest limitations:**
- No GraphQL UI, no WebSocket support, no mock servers, no monitors.
- macOS arm64 only (no Intel build); Linux deb only (no rpm/Flatpak yet); Windows x64 only.
- Binaries are unsigned — code-signing certs are ~$300/year and I'm not paying that for a hobby project. The install scripts handle the Gatekeeper / SmartScreen workarounds.

Repo + binaries: <https://github.com/YOUR_USERNAME/Postie>
Architecture doc: <https://github.com/YOUR_USERNAME/Postie/blob/main/ARCHITECTURE.md>

Feedback welcome.

---

## Posting checklist

Before you hit submit:

1. **Replace `YOUR_USERNAME`** in the repo URL above (and anywhere else the repo is referenced).
2. **Push the v1.1.0 release** to GitHub so the binaries in `dist/` are downloadable from the Releases page — Reddit readers will follow the link, not build from source.
3. **First comment, not the post body**, is the right place for "edit: thanks for the feedback" updates and direct download links — keeps the OP clean.
4. **r/programming** is strict about self-promotion: don't post if your account is brand new, and don't post the same content to multiple programming subs within an hour or two — they cross-check.
5. **Pick a flair** if the sub uses them (`Project` / `Show` / `Release`).
6. **Don't edit the title after posting** — it locks reach on most clients.
7. **Reply to early comments fast.** First-hour engagement is what the algorithm watches.
