# Postie — Changes Log

This document captures every change made to Postie since 2026-06-02. Bug fixes
and new Postman-parity features are grouped separately.

---

## Bug Fixes

### 1. cURL import handles multiple commands at once
**Files:** `renderer/js/curl.js`, `renderer/js/app.js`

- New `splitCurlCommands(input)` helper detects multiple `curl ...` commands
  in a single paste (separated by newlines, with shell line-continuations
  joined first).
- The URL-bar paste handler now imports the first command into the active tab
  and opens each additional command in a new tab. Errors from individual
  commands are reported but don't abort the import; an alert summarizes how
  many imports succeeded and how many were skipped.
- `parseCurl` now also surfaces `-u user:pass` as Basic Auth on the new
  Authorization tab (rather than as a manual `Authorization` header), so the
  imported credentials show up in the right place.

### 2 & 3. Drag-to-resize fixes (request/response split)
**Files:** `renderer/js/app.js`, `renderer/styles.css`

- `wireSplitHandle()` now calls `e.preventDefault()` on `mousedown` to avoid
  text-selection / focus-jump artifacts during a drag.
- The response panel's status-meta bar (`.response-meta`) is wired up as a
  secondary drag handle — clicking-and-dragging from the pills/buttons row
  resizes the split too. Clicks on actual buttons are excluded.
- A pseudo-element gives the 6px split handle an additional ±6px invisible
  hit area so it's easier to grab.
- A grip-dot indicator (visual only) on the handle communicates draggability.

### 4. Error messages are descriptive and actionable
**Files:** `renderer/js/app.js`

- New `describeRequestError(err, payload)` helper translates raw error
  messages into human-readable explanations with hints. It recognizes:
  - Missing/blank URL
  - Schemeless URL (`http://`/`https://` missing)
  - Network / connection refused / DNS failure
  - Timeouts
  - TLS/SSL certificate failures
  - CORS rejections
  - JSON parse failures
- Errors include the failing `METHOD URL` for context so it's clear which
  request failed when many tabs are in flight.

### 5. Keyboard shortcuts and right-click menus
**Files:** `renderer/js/app.js`, `renderer/styles.css`

#### Shortcuts (Cmd on macOS, Ctrl elsewhere)
| Shortcut | Action |
|---|---|
| `⌘/Ctrl + Enter` | Send request |
| `⌘/Ctrl + S` | Save request |
| `⌘/Ctrl + T` | New tab |
| `⌘/Ctrl + W` | Close active tab |
| `⌘/Ctrl + L` or `⌘/Ctrl + K` | Focus URL bar |
| `⌘/Ctrl + B` | Toggle sidebar |
| `⌘/Ctrl + Shift + F` | Format response |
| `⌘/Ctrl + Shift + C` | Copy as cURL |
| `Esc` | Cancel an in-flight request |
| `?` | Show keyboard-shortcut help |

#### Context menus
- **Request tab** → Duplicate, Close, Close other tabs.
- **Sidebar request item** (Collections / History) → Open in new tab.
- **Response body / response headers** → Copy response, Save response to
  file, Format.

A small CSS context-menu component was added (`.context-menu` /
`.context-menu-item`).

---

## Layout

### 6. Side-by-side layout toggle
**Files:** `renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`

- New **⇆** toolbar button toggles between vertical (default) and horizontal
  splits between the request body panel and the response panel.
- The URL row (method dropdown, URL input, Send/Save/Copy buttons) and the
  request-tabs bar now live above the split, so they remain full-width and
  always reachable in either layout — Postman-style.
- The split handle drag works in both modes: vertical drag in column layout,
  horizontal drag in side-by-side layout. The drag updates the workbench's
  `grid-template-columns` directly so CSS Grid actually honors the new
  proportions.
- Each layout remembers its own size in user settings (`splitRequestPx` for
  vertical, `splitRequestPct` for horizontal), so toggling between modes
  preserves your preferred ratio for each.
- New settings keys: `splitHorizontal` (boolean), `splitRequestPct` (number).

---

## New Postman-parity features

### 7. Authorization tab
**Files:** `renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`,
`renderer/js/postman.js`, `renderer/js/curl.js`

- New **Authorization** tab between Params and Headers.
- Supported types: **No Auth**, **Basic Auth**, **Bearer Token**, **API Key**
  (added to either a request header or a query param).
- The auth config is stored on the request (`request.auth = { type, ... }`)
  but **never mutates** the saved Headers / Params lists. It's applied at
  send time by a new helper `applyAuthToWire(payload, auth)`, which keeps
  the user's saved request shape clean.
- "Copy as cURL" bakes the auth into the generated command so the curl
  stands alone.
- Postman v2.1 import (`postman.js`) now reads basic / bearer / apikey auth
  from imported collections and populates this tab.
- Curl paste (`curl.js`) with `-u user:pass` populates Basic Auth here
  instead of inserting a manual header.

### 8. Description column on KV tables
**Files:** `renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`

- A new **Description** column on Params, Headers, body x-www-form-urlencoded,
  and environment variables.
- Description is metadata only — it's persisted with the request but never
  sent over the wire.
- `kvRow()` adds a fourth input bound to `kv.description`. New blank rows
  start with an empty `description`.
- CSS gives the columns explicit widths so the description column fits
  alongside the others without crowding the inputs.

### 9. Bulk-edit mode for KV tables
**Files:** `renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`

- Each KV-style tab (Params, Headers, body urlencoded) gets a **Bulk Edit**
  toggle. Clicking it swaps the table for a textarea where you can edit the
  pairs as plain `key:value` lines.
- Round-trips: switching back to **Key-Value Edit** parses the textarea
  into items and re-renders the table.
- Disabled rows round-trip as `# key:value` (leading `#` marks them
  disabled). Empty lines are ignored.
- Description is intentionally not part of the bulk format — switching back
  preserves any existing descriptions and starts new rows with `''`.
- Live updates while typing: the model is updated on every textarea input
  so **Send** and **Copy as cURL** see your edits immediately, even before
  you switch back to table view.

### 10. Header autocomplete
**Files:** `renderer/index.html`, `renderer/js/app.js`

- A native HTML `<datalist id="header-suggestions">` containing common HTTP
  header names is rendered once at the bottom of `index.html`.
- `renderKv()` recognizes `tbodyId === 'headers-body'` and adds
  `list="header-suggestions"` to the key input on every row.
- Suggestions appear only on the Headers tab — Params, body form-data, and
  env-vars are unaffected.
- Suggestion list (28 headers): `Accept`, `Accept-Charset`,
  `Accept-Encoding`, `Accept-Language`, `Authorization`, `Cache-Control`,
  `Connection`, `Content-Type`, `Content-Length`, `Content-Encoding`,
  `Cookie`, `DNT`, `Host`, `If-Match`, `If-None-Match`, `If-Modified-Since`,
  `If-Unmodified-Since`, `Origin`, `Pragma`, `Range`, `Referer`,
  `User-Agent`, `X-Api-Key`, `X-Auth-Token`, `X-CSRF-Token`,
  `X-Forwarded-For`, `X-Requested-With`.

### 11. Raw body sub-types (HTML, JavaScript)
**Files:** `renderer/index.html`, `renderer/js/editor-entry.js`,
`renderer/js/app.js`, `package.json`

- Two new options under the body type dropdown: **HTML** and **JavaScript**.
- Added CodeMirror language packages and wired them into the editor's
  `languageFor()` switch:
  - `npm install @codemirror/lang-html @codemirror/lang-javascript`
  - Bundle grew from ~792 kB → ~982 kB.
- `bodyEditorLanguageFor(type)` helper centralizes the type → CodeMirror
  language mapping.
- `defaultContentTypeFor(type)` returns sensible defaults at send time
  (only when the user hasn't manually set a `Content-Type` header):
  - JSON → `application/json`
  - XML → `application/xml`
  - HTML → `text/html`
  - JavaScript → `application/javascript`
- Backend wire format: HTML and JavaScript are sent as `Body::Text` because
  they're indistinguishable from text on the wire — only the Content-Type
  header matters. This means **no backend changes were needed** for these
  two types.

### 12. Multipart form-data with file uploads
**Files:** `backend/src/models.rs`, `backend/src/http_client.rs`,
`renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`,
`electron/preload.js`, `electron/main.js`

- New body type **form-data** in the dropdown (in addition to the existing
  `x-www-form-urlencoded`).
- Each form-data row has a per-row **Type** selector (`Text` or `File`) and
  a Description column. File rows show a "Choose…" button that opens a
  native file-picker and a tooltip with the full path.
- New IPC `postie:pick-file-path` (added in `electron/main.js` /
  `electron/preload.js`) returns just `{ path, name, size }` — the backend
  reads the file at send time, so the renderer never needs to slurp the
  bytes.
- Backend additions:
  - `FormPart` enum (`Text { key, value, enabled }` /
    `File { key, path, filename, content_type, enabled }`).
  - New `Body::FormData(Vec<FormPart>)` variant.
  - `http_client.rs` builds a `reqwest::multipart::Form` from the parts.
    File parts read via `std::fs::read(path)`, with the on-disk filename
    used unless an override is provided.
- The existing `Body::Form(Vec<KeyValue>)` variant is preserved for
  backward compatibility — old saved requests still load.
- `Content-Type` is intentionally not set by the renderer — `reqwest` sets
  the correct `multipart/form-data; boundary=...` automatically.

### 13. Binary body type
**Files:** `backend/src/models.rs`, `backend/src/http_client.rs`,
`renderer/index.html`, `renderer/styles.css`, `renderer/js/app.js`

- New **binary** option under the body type dropdown.
- UI is a single file picker with the chosen file's name, the path as a
  tooltip, and a **Clear** button.
- Backend additions:
  - `BinaryBody { path, content_type }` struct.
  - New `Body::Binary(BinaryBody)` variant.
  - `http_client.rs` reads the file via `std::fs::read(path)` and sends the
    raw bytes. If the user hasn't set a `Content-Type` header, the backend
    falls back to `application/octet-stream`.
- Renderer wire shape: `{ type: 'binary', content: { path, content_type } }`
  — the renderer never reads the file, so very large uploads are practical.

---

## Files touched (summary)

```
backend/src/
  models.rs          # FormPart, BinaryBody, Body::FormData, Body::Binary
  http_client.rs     # Build multipart forms; stream binary file body

electron/
  main.js            # New postie:pick-file-path IPC handler
  preload.js         # Expose pickFilePath() on window.postie

renderer/
  index.html         # Layout toggle, Authorization tab, body sub-types,
                     #   form-data table + binary picker, header datalist,
                     #   shortcuts, etc.
  styles.css         # Auth styles, kv-toolbar, bulk textarea, side-by-side
                     #   grid layout, context menu, grip indicators,
                     #   binary-body card, fd-file-cell.
  js/
    app.js           # All renderer behavior — auth, bulk edit, layout
                     #   toggle, drag, error messages, shortcuts, context
                     #   menus, body sub-types, form-data, binary, etc.
    curl.js          # splitCurlCommands; -u → Basic Auth on auth tab
    postman.js       # convertAuth() reads basic/bearer/apikey
    editor-entry.js  # html() and javascript() languages
```

---

## Things I deliberately did **not** change

- The shape of `KeyValue` (existing key/value/enabled fields) — `description`
  is additive and optional.
- `Body::None | Text | Json | Xml | Form | Urlencoded` — old saved requests
  still load and behave the same.
- Existing keyboard shortcuts that already worked (`Cmd+Enter` for Send was
  already wired by browser default; the new global handler is additive).
- `kvRow()` for env-vars and existing tables — only the description input
  was appended.

---

## Settings (`localStorage` key `postie.settings.v1`)

New keys added by these changes:

| Key | Type | Purpose |
|---|---|---|
| `splitHorizontal` | boolean | Side-by-side vs top/bottom split |
| `splitRequestPct` | number | Width % of request panel in side-by-side mode |

---

# 2026-06-04 — Branding, distribution, UX polish, Tests tab

## Branding & app identity

### Pacifico wordmark icon
**Files:** `assets/icon.svg`, `assets/icon.png`, `assets/icon.ico`,
`assets/Pacifico-Regular.ttf`, `renderer/icon.svg`, `renderer/icon.png`,
`renderer/fonts/Pacifico-Regular.ttf`, `renderer/index.html`,
`renderer/styles.css`

- Replaced the envelope glyph icon with the word **Postie** in **Pacifico**.
  SVG embeds glyph paths so it rasterizes identically without the font
  installed; PNG generated via Pillow at 4× and downsampled with LANCZOS for
  clean edges and proper alpha (no white corner halo).
- Off-white text fill (`#fff8f1`) on the orange gradient — high-contrast and
  matches the brand palette.
- Welcome screen logo and topbar brand now render the wordmark in Pacifico
  with the gradient applied via `background-clip: text`.
- Self-hosted Pacifico TTF in `renderer/fonts/`; CSP gained `font-src 'self'`.
- Added `assets/icon.ico` (multi-size 16/24/32/48/64/128/256) for Windows
  builds.

### Dock tooltip says "Postie" in dev mode
**Files:** `electron/main.js`, `package.json`,
`scripts/rename-electron-bundle.js`

- `app.setName('Postie')` + `process.title = 'Postie'` set before
  `app.whenReady()`.
- Patches `node_modules/electron/dist/Electron.app/Contents/Info.plist`
  (`CFBundleName` / `CFBundleDisplayName`) so macOS Dock tooltip shows
  "Postie" instead of "Electron" when running unpackaged. A `postinstall`
  hook re-applies the patch automatically after `npm install`.
- Packaged builds already pick up the right name from
  `package.json`'s `productName`.

## Distribution

### v1.1.0 — DMG, .deb, and Windows installers
**Files:** `package.json`, `backend/Cargo.toml`, `scripts/build-deb.sh`,
`setup.md`, `dist/*`

- Bumped `version` to `1.1.0` in both `package.json` and
  `backend/Cargo.toml`.
- Added Windows targets to `package.json` build config:
  - `win.target` = NSIS + portable, x64
  - `win.icon` = `assets/icon.ico`
  - `win.extraResources` = `backend/target/x86_64-pc-windows-gnu/release/postie-backend.exe`
  - `nsis` block configures non-oneClick installer with Start Menu + Desktop
    shortcuts; `portable` block sets the artifact name.
- Cross-compiled the Rust backend for Linux (`x86_64-unknown-linux-musl`)
  and Windows (`x86_64-pc-windows-gnu`) using `cargo zigbuild`.
- Built four artifacts: `Postie-1.1.0-arm64.dmg` (ad-hoc signed),
  `postie_1.1.0_amd64.deb`, `Postie Setup 1.1.0.exe` (NSIS), and
  `Postie-1.1.0-portable.exe`.
- New `scripts/build-deb.sh` codifies the .deb workflow — electron-builder's
  bundled fpm produces a malformed 96-byte archive on macOS, so the script
  uses electron-builder for staging then `dpkg-deb --build` for the actual
  package, including hicolor icons (`sips`-resized 16/32/48/64/128/256/512),
  a `.desktop` file, dependency list, and a postinst that fixes the
  chrome-sandbox SUID bit.
- New `setup.md` documents recipient install steps for all three platforms
  (including macOS Sequoia Gatekeeper bypass — `xattr -cr` or System Settings →
  Privacy & Security → Open Anyway), and the build recipes for maintainers.

## UX polish

### Method-color pills in collections, history, and tabs
**Files:** `renderer/styles.css`

- Method badges in the saved-collections sidebar, history sidebar, and
  request tab strip now use Postman-style tinted pills: green GET, yellow
  POST, blue PUT, purple PATCH, red DELETE, grey HEAD, teal OPTIONS.
- Background tints set via `!important` on `.method-badge[data-method=...]`
  to win over the base `.tree li.req .method-badge` and
  `.req-tab .method-badge` rules without splitting the color block across
  multiple selectors.
- Status-code badges in history (which have no `data-method`) fall through
  to a neutral grey pill via `.method-badge:not([data-method])`.

### Tab right-click menu no longer overlays "+"
**File:** `renderer/js/app.js`

- The Duplicate / Close / Close-other-tabs context menu was anchored at
  cursor coordinates and would overlap the new-tab "+" button when the
  rightmost tab was clicked. Now it's anchored to the tab's bottom-left
  rect via `getBoundingClientRect()`. Existing off-screen edge clamping in
  `showContextMenu()` keeps it inside the viewport.

### Unsaved-changes indicator + close confirmation
**Files:** `renderer/js/app.js`, `renderer/index.html`,
`renderer/styles.css`

- `tab.savedSnapshot` (string) tracks the request state at the last save
  point. `isTabDirty(tab)` returns `JSON.stringify(tab.request) !== savedSnapshot`.
- Tabs with unsaved edits get a `dirty` class, an orange dot indicator, and
  italicized titles in the tab strip.
- `wireUi()` adds a delegated, debounced (120ms) `input`/`change` listener
  on `.workbench` so any edit (URL, KV table, body, auth, headers, tests,
  bulk textarea) re-evaluates dirtiness and updates the indicator.
- New `confirm-close-dialog` modal: clicking × on a dirty tab now offers
  **Save / Discard / Cancel**.
  - Save → opens the existing save dialog with a `pendingCloseAfterSave`
    flag; on save success the tab is force-closed.
  - Discard → drops the tab immediately.
  - Cancel → tab stays open.
- `closeTab(id)` is the public, gated entry point; `forceCloseTab(id)`
  performs the unconditional close used by both the discard path and the
  post-save flow.
- Sidebar saved-request clicks pass a `savedRef` so the tab knows where it
  came from; saving updates `savedSnapshot` and clears the dot.

## Tests tab — post-response scripts & request chaining

**Files:** `renderer/js/tests.js` (new), `renderer/js/app.js`,
`renderer/index.html`, `renderer/styles.css`,
`backend/src/models.rs`

- New **Tests** tab in the request panel (next to Body) with CodeMirror in
  JS mode and an "Insert example" button that drops in a starter snippet
  covering all three patterns.
- New `runTests(script, response, ctx)` runner in `renderer/js/tests.js`
  executes the user's script in a `new Function(pm, console, script)`
  invocation. Returns `{tests, logs, warnings, envWrites, error}` for the
  caller to render and persist.
- `pm.*` API (Postman-compatible subset):
  - `pm.response`: `.code`, `.status`, `.responseTime`, `.headers.get(name)` /
    `.headers.has(name)` / `.headers.all()`, `.text()`, `.json()`
  - `pm.test(name, fn)` — wraps assertion blocks; pass/fail recorded
  - `pm.expect(value)` — chai-like fluent API: `.to.equal`, `.to.eql`,
    `.to.be.a(type)`, `.to.have.status(code)`, `.to.include`, `.to.exist`,
    `.to.be.above/.below`, with `.not` negation
  - `pm.environment.set/get/unset/has`
  - `pm.variables.get`
  - `console.log/.warn/.error` captured in the results panel
- Chaining via env vars: `pm.environment.set("authToken", body.token)`
  writes through to the active environment via `api.updateEnvironment` and
  patches `state.workspace.environments` in place, so the next request that
  uses `{{authToken}}` picks it up immediately. No new substitution
  machinery — reuses the existing `applyEnvToRequest()`.
- New **Test Results** tab in the response area: pass/fail per assertion,
  summary count, error/warning callouts, collapsible console output. The
  tab label shows `Test Results (N/M)` and turns green when all pass / red
  when any fail.
- `tab.lastTestResults` is restored on tab switch so results persist while
  the tab is open.
- No-active-environment behavior: `pm.environment.set/.unset` silently
  no-ops and surfaces a yellow warning in the results panel.
- Persistence: `requestForWire()` includes `tests` when non-empty.
  `ExecuteRequest` in `backend/src/models.rs` gained a
  `#[serde(default, skip_serializing_if = "String::is_empty")] tests: String`
  field so saved requests round-trip the script through the backend (which
  treats it as opaque text — never executed server-side). Mirrors the
  existing `auth` field pattern.

## File map (new files this batch)

```
assets/
  Pacifico-Regular.ttf       # Self-hosted font for renderer + icon
  icon.ico                   # Windows multi-size icon
renderer/
  fonts/Pacifico-Regular.ttf # Bundled with renderer (loaded via @font-face)
  js/tests.js                # Post-response test runner & pm.* API
scripts/
  build-deb.sh               # Maintainer .deb build recipe
  rename-electron-bundle.js  # postinstall: patch Electron.app Info.plist
setup.md                     # Recipient install + maintainer build docs
dist/
  Postie-1.1.0-arm64.dmg
  postie_1.1.0_amd64.deb
  Postie Setup 1.1.0.exe
  Postie-1.1.0-portable.exe
```

---

# 2026-06-04 (later) — Save UX

## Dirty-on-open regression fix

**Files:** `renderer/js/app.js`

- Saved requests opened from the sidebar were appearing dirty immediately
  because `activateTab()` mutated `request.auth` / `request.tests` defaults
  *after* `newTab()` had already captured `savedSnapshot` from the
  pre-mutation state — so the snapshot and the live request diverged on the
  first render.
- Introduced `normalizeRequest(req)` that fills missing `body` / `auth` /
  `tests` / `headers` / `query` fields. Called once at the entry to
  `newTab()`, `openRequest()`, and `loadRequestInActiveTab()` — *before*
  snapshot capture.
- `activateTab()` no longer mutates the request shape; the `auth` /
  `tests` defaults it used to add inline are now handled by
  `normalizeRequest()` upstream. Snapshot stays stable across renders.
- `blankRequest()` gained an explicit `tests: ''` field for symmetry.

## Save vs Save As split

**Files:** `renderer/js/app.js`, `renderer/index.html`

- New `saveActiveTab()` — bound to **⌘S** / Ctrl+S. If the active tab has
  a `savedRef` pointing at an existing collection entry, it overwrites
  that entry via `api.updateRequest()` (silently, by default). If no
  `savedRef` or the referenced entry is gone, it falls through to Save As.
- New `saveAsActiveTab()` — bound to **⌘⇧S** / Ctrl+Shift+S. Always opens
  the Save dialog so the user picks name + collection. Pre-fills the
  current `savedRef.name` and selects the current collection if any, so
  Save As starts from the right values.
- `openSaveDialog` is now an alias for `saveAsActiveTab` (back-compat for
  callers like the close-confirmation flow).
- New `findSavedRequest(ref)` helper resolves a `savedRef` to its current
  in-memory request entry; missing entries trigger the fall-through.
- Toolbar **Save** button: plain click = ⌘S behavior; **Shift+click** =
  Save As.

## "Confirm before overwriting" preference

**Files:** `renderer/js/app.js`, `renderer/index.html`

- New setting `confirmOverwrite` in `SETTINGS_DEFAULTS` (default `false` —
  silent overwrite, matching Postman).
- When `true`, `saveActiveTab()` shows a Yes/No modal before calling
  `api.updateRequest()`: *"Overwrite \"X\" in this collection with the
  current changes?"*. ⌘⇧S bypasses this — it never overwrites; it always
  creates a new entry.
- New generic `askConfirm({title, message, okLabel, cancelLabel})` helper
  backed by a new `<dialog id="confirm-dialog">` modal. Window-level
  `confirm()` is blocked in Electron, so this fills the same gap that
  `askText()` does for prompts.
- Settings → General gains a new "Confirm before overwriting saved
  request" toggle row, wired in `wireSettingsDialog()`.

## Save options in tab context menu

**Files:** `renderer/js/app.js`, `renderer/styles.css`

- Tab right-click menu now leads with **Save** and **Save As…**, then a
  divider, then the existing **Duplicate tab** / **Close tab** /
  **Close other tabs** entries.
- **Save** is rendered disabled (greyed out, non-clickable) when the tab
  is already saved AND clean — there's nothing to write.
- `showContextMenu()` extended to support `{divider: true}` rows and
  `{disabled: true}` items. New CSS rules `.context-menu-item.disabled`
  (faded, no hover effect) and `.context-menu-divider` (1px subtle line).
- Shortcuts help (`?`) updated to list both ⌘S and ⌘⇧S.

## Open tabs survive a reload

**Files:** `renderer/js/app.js`

- New localStorage key `postie.tabs.v1` stores `{activeTabId, tabs: [...]}`
  serialized after every tab open / close / activate / save / response and
  after every edit (piggy-backs on the existing 120ms dirty-redraw
  debounce).
- `persistTabs()` is itself debounced at 200ms and writes `id`, `request`,
  `savedSnapshot`, `savedRef`, plus `lastResponse` and `lastTestResults`
  per tab. Skips `pendingSince` / `abortController` (transient runtime
  state) — any in-flight request is treated as cancelled across reload.
- Response-body size guards keep us under localStorage's ~5 MB quota:
  - `PERSIST_BODY_CAP` = 1 MB per response. Bigger bodies are dropped
    via `trimResponseForPersist()` and replaced with
    `body_evicted: true`, `body_size_at_persist: <n>` so the renderer
    can show a clear placeholder.
  - `PERSIST_TOTAL_CAP` = 4 MB serialized. If the payload still exceeds
    it, every body is evicted in one pass; if still over, responses are
    dropped entirely (status/headers/timing kept where possible).
- `restoreTabs()` re-creates each tab via
  `newTab(saved.request, {id, savedSnapshot, savedRef})` so the dirty
  baseline is preserved, then re-attaches `lastResponse` and
  `lastTestResults`. Bumps `tabSeq` past the highest restored id.
- `renderResponse()` recognizes `body_evicted` and shows a placeholder
  in the body editor instructing the user to re-send. Status pill,
  timing, size, and headers all still render from the persisted
  metadata.
- `newTab()` gained an optional `opts.id` for replaying a stable id
  during restore.
- `sendRequest()` calls `persistTabs()` in its `finally` block so a
  fresh response lands in localStorage as soon as it arrives.

## Export collection (Postman v2.1)

**Files:** `renderer/js/postman.js`, `renderer/js/app.js`

- New `exportPostmanCollection(collection)` round-trips
  `importPostmanCollection`. Names like `"Auth / Login"` are split on
  `" / "` and rebuilt into nested folders so the export matches the
  shape Postie reads on import.
- Per-request converters: `requestToPostman`, `urlToPostman`,
  `bodyToPostman`, `authToPostman`. URL exports both the `raw` form
  Postman re-parses and the structured `protocol/host/port/path` for
  display. Body exports cover `raw` (with `language` for json/xml/html/js),
  `urlencoded`, and `formdata`. `binary` is intentionally dropped — its
  file path doesn't survive across machines.
- Auth exports the `basic` / `bearer` / `apikey` triplet shapes Postman
  expects on import.
- `app.js` now imports `exportPostmanCollection` and registers an
  **Export…** entry on the collection right-click menu (between
  **Rename…** and **Delete**, separated by a divider). The handler
  serializes the JSON, then opens the existing `postie:save-file` dialog
  with a default name of `<collection>.postman_collection.json`.

## Direct Environment button in topbar

**Files:** `renderer/index.html`, `renderer/js/app.js`

- New ⚙ button next to the Environment dropdown in the topbar opens the
  environment manager dialog directly. Previously the dialog was only
  reachable via Settings → Workspace → Environments.
- Reuses the existing `openEnvDialog()` and `wireEnvDialog()` so there's
  no duplication — just a new entry point.

**Files:** `renderer/js/app.js`, `renderer/index.html`

- Two new settings under **Settings → Appearance**:
  - **Syntax highlighting in request body** — gates the request-side
    CodeMirror editor (and the Tests script) between its language mode
    (`json` / `xml` / `html` / `javascript`) and plain text.
  - **Syntax highlighting in response body** — same for the response
    editor.
  - Both default ON.
- New helpers `effectiveRequestLang(kind)` and `effectiveResponseLang(kind)`
  return `'none'` when the corresponding setting is off; all
  `setLanguage` call sites (`renderBody()`, `paintBody()`,
  `mountEditors()` for the Tests editor) route through them.
- `reapplyEditorHighlighting()` re-issues `setLanguage` on all three
  editors so toggling the setting takes effect immediately, with no need
  to switch tabs or re-send a request.
- Persists to `postie.settings.v1`; honored from boot via the gated
  language helpers.

---

## 2026-06-05 — Bug fix: schemeless URLs

### Postman-style schemeless URLs (e.g. `localhost:3000`, `api.example.com/users`)

**Files:** `backend/src/http_client.rs`, `renderer/js/app.js`

- Previously the backend tried `url::Url::parse(req.url)` and only fell
  back to prepending `https://` when parsing **failed**. But dots and
  digits are legal in scheme syntax, so inputs like `localhost:3000` or
  `example.com:80/users` parse "successfully" with a bogus scheme — then
  reqwest fails at send time with an opaque error.
- Now the backend checks the prefix directly: if the URL doesn't start
  with `http://` or `https://` (case-insensitive), `http://` is
  prepended before parsing. Matches Postman's behavior — Postman also
  defaults to plain HTTP for schemeless URLs, which is what users
  typing internal IPs like `192.168.x.x:7210/...` actually want.
- `describeRequestError` in the renderer no longer reports "Missing
  scheme" — that branch is unreachable now that the backend accepts
  bare URLs.
