# Postie

A lightweight, fast, and modern API client built with Electron and Rust. Think Postman, but simpler and local-first.

## Features

### Core Capabilities
- **All HTTP methods**: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS
- **Advanced request building**: Headers, query parameters, multiple body types (JSON, XML, form-data, urlencoded, raw text)
- **Environment variables**: Use `{{variable}}` syntax in URLs, headers, and bodies; switch between environments (dev, qa, prod) instantly
- **Collections & History**: Organize requests into collections, automatically track request history (last 200 entries)
- **Import Postman data**: Import Postman v2.1 collections and environments via `File → Import Postman`
- **Paste curl commands**: Drop a curl command into the URL bar and Postie parses method, URL, headers, query params, body, and auth
- **Response formatting**: Auto-detect and format JSON/XML responses; syntax highlighting with CodeMirror
- **Export responses**: Save response bodies to disk
- **Copy as curl**: Export any request as a curl command
- **Proxy support**: Configure HTTP/HTTPS/SOCKS5 proxy with bypass rules

### Architecture
- **Rust backend**: High-performance HTTP client (reqwest) with axum REST API
- **Electron frontend**: Modern vanilla JavaScript UI with CodeMirror editors
- **Local-first**: All data stored in `~/Library/Application Support/Postie/workspace.json` (macOS) or platform equivalent
- **Zero external dependencies**: No cloud accounts, no telemetry, no tracking

## Installation

### Prerequisites
- **Node.js** (v18 or later)
- **Rust** (v1.70 or later) with cargo
- **npm** (comes with Node.js)

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/postie/postie.git
   cd Postie
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Build and run**
   ```bash
   npm start
   ```
   
   This builds the Rust backend in release mode, bundles the renderer JavaScript, and launches Electron.

### Development Mode

If you're only working on the frontend and the backend is already built:

```bash
npm run dev
```

This skips the backend build and just launches Electron with the existing binary.

### Watch Mode (Frontend)

To continuously rebuild the renderer bundle while editing:

```bash
npm run watch:renderer
```

In another terminal:
```bash
npm run dev
```

## Project Structure

```
Postie/
├── backend/                 # Rust sidecar (HTTP client)
│   ├── src/
│   │   ├── main.rs          # Entry point, starts axum server
│   │   ├── routes.rs        # REST API endpoints
│   │   ├── http_client.rs   # reqwest wrapper for HTTP execution
│   │   ├── models.rs        # Shared data structures
│   │   └── storage.rs       # JSON file persistence layer
│   └── Cargo.toml
│
├── electron/                # Electron main process
│   ├── main.js              # Window management, backend spawning, IPC
│   └── preload.js           # Sandboxed bridge (contextBridge)
│
├── renderer/                # Frontend UI
│   ├── index.html           # Main layout
│   ├── styles.css           # UI styling
│   └── js/
│       ├── app.js           # Main application logic
│       ├── api.js           # Fetch wrapper for backend API
│       ├── curl.js          # curl command parser
│       ├── postman.js       # Postman v2.1 importer
│       ├── format.js        # JSON/XML formatters
│       ├── env.js           # Environment variable substitution
│       ├── toCurl.js        # Export request as curl
│       ├── editor-entry.js  # CodeMirror editor setup
│       └── editor.bundle.js # Bundled CodeMirror (generated)
│
├── package.json             # Node.js dependencies and scripts
└── README.md
```

## How to Use

### Making Your First Request

1. **Launch Postie** with `npm start`
2. **Enter a URL** in the address bar (e.g., `https://api.github.com/users/octocat`)
3. **Select HTTP method** (GET, POST, etc.) from the dropdown
4. **Click Send** or press `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows/Linux)
5. **View response** in the lower panel with syntax highlighting

### Using Environment Variables

1. **Create an environment**: Click the environment dropdown (top-right) → `Manage Environments` → `New Environment`
2. **Add variables**: Define key-value pairs (e.g., `baseUrl` = `https://api.example.com`)
3. **Use in requests**: Reference with `{{baseUrl}}/users` in URL, headers, or body
4. **Switch environments**: Select from the dropdown to retarget requests instantly

### Collections

1. **Create a collection**: Sidebar → `Collections` → `+` button
2. **Save requests**: After making a request, click `Save` and choose a collection
3. **Organize**: Drag requests between collections, rename, delete
4. **Load saved requests**: Click any request in the sidebar to load it into a new tab

### Importing from Postman

1. **Export from Postman**: Collection → `Export` → `Collection v2.1`
2. **Import to Postie**: `File` → `Import Postman Collection` → Select exported `.json` file
3. **Import environments**: `File` → `Import Postman Environment` → Select environment `.json`

### Paste curl Commands

Copy any curl command and paste it directly into the URL bar. Postie automatically parses:
- HTTP method (`-X POST`)
- URL and query parameters
- Headers (`-H "Content-Type: application/json"`)
- Request body (`-d '{"key":"value"}'`)
- Basic auth (`-u user:pass`)

Example:
```bash
curl -X POST https://httpbin.org/post -H "Content-Type: application/json" -d '{"test":true}'
```

### Keyboard Shortcuts

- **Send request**: `Cmd+Enter` / `Ctrl+Enter`
- **New tab**: `Cmd+T` / `Ctrl+T`
- **Close tab**: `Cmd+W` / `Ctrl+W`
- **Format response**: `Cmd+Shift+F` / `Ctrl+Shift+F`
- **Toggle sidebar**: `Cmd+B` / `Ctrl+B`

## Building Distributable Packages

### macOS (DMG)

1. **Build backend for ARM64**
   ```bash
   cd backend && cargo build --release --target aarch64-apple-darwin && cd ..
   ```

2. **Package with electron-builder**
   ```bash
   npm run package
   ```

3. **Ad-hoc sign** (required for Apple Silicon)
   ```bash
   codesign --force --deep --sign - "dist/mac-arm64/Postie.app"
   ```

4. **Create DMG**
   ```bash
   electron-builder build --mac dmg --arm64
   ```

Output: `dist/Postie-0.1.0-arm64.dmg`

### Linux (Debian package)

1. **Build backend for x64 with musl** (for portability)
   ```bash
   cd backend
   rustup target add x86_64-unknown-linux-musl
   cargo build --release --target x86_64-unknown-linux-musl
   cd ..
   ```

2. **Package**
   ```bash
   npm run package -- --linux deb --x64
   ```

3. **Repackage if needed** (electron-builder on macOS sometimes produces broken .deb)
   ```bash
   # Extract, inspect, and rebuild with dpkg-deb
   mkdir -p tmp && dpkg-deb -R dist/postie_0.1.0_amd64.deb tmp/
   dpkg-deb -b tmp/ dist/postie_0.1.0_amd64-fixed.deb
   ```

Output: `dist/postie_0.1.0_amd64.deb`

### Windows (NSIS installer)

1. **Build backend for Windows**
   ```bash
   cd backend
   rustup target add x86_64-pc-windows-msvc
   cargo build --release --target x86_64-pc-windows-msvc
   cd ..
   ```

2. **Package**
   ```bash
   npm run package -- --win nsis --x64
   ```

Output: `dist/Postie Setup 0.1.0.exe`

## Architecture Overview

### Communication Flow

```
┌─────────────────┐
│  Electron Main  │ Spawns backend on random port (127.0.0.1:0)
└────────┬────────┘
         │
         ├─> Rust Backend (axum server on localhost)
         │   └─> Executes HTTP requests via reqwest
         │   └─> Persists workspace to ~/Library/Application Support/Postie/workspace.json
         │
         └─> Renderer (Electron window)
             └─> Communicates with backend via REST API (fetch)
             └─> CodeMirror for request/response editing
```

### Technology Stack

- **Backend**: Rust + axum (REST API) + reqwest (HTTP client) + tokio (async runtime)
- **Frontend**: Vanilla JavaScript + CodeMirror 6 (editors) + esbuild (bundler)
- **Desktop**: Electron 31 (chromium + Node.js)
- **Storage**: JSON file (`workspace.json`) with atomic writes

### Why Rust for the Backend?

- **Performance**: Handles large request/response bodies with minimal memory
- **Safety**: No crashes from concurrent workspace access (Mutex)
- **Binary size**: Compiled binary is ~5MB (vs. 50MB+ for Node.js equivalents)
- **HTTP client**: reqwest supports HTTP/2, brotli, gzip, SOCKS5, and streaming out of the box

## Data Storage

All workspace data (collections, environments, history) is stored in:

- **macOS**: `~/Library/Application Support/Postie/workspace.json`
- **Linux**: `~/.local/share/Postie/workspace.json`
- **Windows**: `%APPDATA%\Postie\workspace.json`

The file is JSON-formatted and human-readable. You can manually edit it or back it up.

### Workspace Schema

```json
{
  "collections": [
    {
      "id": "uuid",
      "name": "My API",
      "requests": [
        {
          "id": "uuid",
          "name": "Get Users",
          "request": { "method": "GET", "url": "...", ... }
        }
      ]
    }
  ],
  "environments": [
    {
      "id": "uuid",
      "name": "Production",
      "variables": [
        { "key": "baseUrl", "value": "https://api.prod.com", "enabled": true }
      ]
    }
  ],
  "active_environment_id": "uuid",
  "history": [...],
  "proxy": { "enabled": false, "url": "", "bypass": "" }
}
```

## Troubleshooting

### Backend fails to start

**Error**: `postie-backend binary not found`

**Solution**: Run `npm run build:backend` to compile the Rust binary.

### cargo not on PATH

**Error**: `cargo: command not found`

**Solution**: Install Rust via [rustup.rs](https://rustup.rs) or run directly with:
```bash
node_modules/.bin/electron .
```
(after manually building backend with `cd backend && cargo build --release`)

### Electron shows blank window

**Solution**: Check Developer Tools (View → Toggle Developer Tools) for JavaScript errors. Ensure `npm run build:renderer` completed successfully.

### Response not displaying

**Solution**: Large responses (>500KB) are truncated by default. Adjust `renderLimitMb` in settings or use `File → Save Response` to export the full body.

### Import fails with "Invalid Postman format"

**Solution**: Ensure you're exporting Postman Collection v2.1 (not v1 or v2.0). Postie only supports v2.1 schema.

## Contributing

This is a personal project, but contributions are welcome.

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

MIT License. See `LICENSE` file for details.

## Acknowledgments

- **Postman**: Inspiration for the UI and workflow
- **reqwest**: Excellent Rust HTTP client
- **CodeMirror**: Powerful code editor component
- **Electron**: Cross-platform desktop framework

## Roadmap

- [ ] WebSocket support
- [ ] GraphQL query builder
- [ ] Request scripting (pre-request / post-response scripts)
- [ ] OAuth 2.0 flow automation
- [ ] Response assertions / testing
- [ ] Import from Insomnia
- [ ] Dark/light theme toggle
- [ ] Request chaining (use response data in next request)

## Support

For bugs or feature requests, open an issue on GitHub: https://github.com/postie/postie/issues
