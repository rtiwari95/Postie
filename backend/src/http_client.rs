use crate::models::*;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::Method;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub async fn execute(
    req: &ExecuteRequest,
    proxy: Option<&ProxyConfig>,
) -> Result<ExecuteResponse, String> {
    let started = Instant::now();

    let method = Method::from_bytes(req.method.to_uppercase().as_bytes())
        .map_err(|e| format!("invalid method: {e}"))?;

    // Postman-style: if the URL doesn't start with http:// or https://, default
    // to http://. We can't rely on Url::parse failing for schemeless URLs —
    // dots are legal in scheme syntax, so `localhost:3000` and
    // `192.168.1.1:7210/path` both parse "successfully" with a bogus scheme,
    // which then makes reqwest fail at send time.
    let trimmed = req.url.trim();
    if trimmed.is_empty() {
        return Err("invalid url: empty".to_string());
    }
    let lower = trimmed.to_ascii_lowercase();
    let has_http_scheme = lower.starts_with("http://") || lower.starts_with("https://");
    let to_parse = if has_http_scheme {
        trimmed.to_string()
    } else {
        format!("http://{}", trimmed)
    };
    let mut url = url::Url::parse(&to_parse).map_err(|e| format!("invalid url: {e}"))?;

    {
        let mut pairs = url.query_pairs_mut();
        for kv in &req.query {
            if kv.enabled && !kv.key.is_empty() {
                pairs.append_pair(&kv.key, &kv.value);
            }
        }
    }

    let mut headers = HeaderMap::new();
    for kv in &req.headers {
        if !kv.enabled || kv.key.is_empty() {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(kv.key.as_bytes()),
            HeaderValue::from_str(&kv.value),
        ) {
            headers.append(name, val);
        }
    }

    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(60_000));
    let follow = req.follow_redirects.unwrap_or(true);

    let mut client_builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(if follow {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .danger_accept_invalid_certs(false);

    if let Some(p) = proxy {
        if p.enabled && !p.url.trim().is_empty() {
            let proxy_obj = build_proxy(p)?;
            client_builder = client_builder.proxy(proxy_obj).no_proxy();
        } else {
            // Disable system proxy lookups when no explicit proxy is set,
            // so HTTP_PROXY env vars in Postie's environment don't leak in.
            client_builder = client_builder.no_proxy();
        }
    } else {
        client_builder = client_builder.no_proxy();
    }

    let client = client_builder.build().map_err(|e| e.to_string())?;

    let mut builder = client.request(method, url).headers(headers);

    builder = match &req.body {
        Body::None => builder,
        Body::Text(s) => builder.body(s.clone()),
        Body::Json(s) => {
            let mut b = builder.body(s.clone());
            if !has_header(&req.headers, "content-type") {
                b = b.header(CONTENT_TYPE, "application/json");
            }
            b
        }
        Body::Xml(s) => {
            let mut b = builder.body(s.clone());
            if !has_header(&req.headers, "content-type") {
                b = b.header(CONTENT_TYPE, "application/xml");
            }
            b
        }
        Body::Urlencoded(items) => {
            let pairs: Vec<(String, String)> = items
                .iter()
                .filter(|kv| kv.enabled)
                .map(|kv| (kv.key.clone(), kv.value.clone()))
                .collect();
            builder.form(&pairs)
        }
        Body::Form(items) => {
            let mut form = reqwest::multipart::Form::new();
            for kv in items.iter().filter(|kv| kv.enabled) {
                form = form.text(kv.key.clone(), kv.value.clone());
            }
            builder.multipart(form)
        }
        Body::FormData(parts) => {
            let mut form = reqwest::multipart::Form::new();
            for p in parts.iter() {
                match p {
                    FormPart::Text { key, value, enabled } => {
                        if !*enabled || key.is_empty() { continue; }
                        form = form.text(key.clone(), value.clone());
                    }
                    FormPart::File { key, path, filename, content_type, enabled } => {
                        if !*enabled || key.is_empty() || path.is_empty() { continue; }
                        let bytes = std::fs::read(path)
                            .map_err(|e| format!("could not read file '{path}': {e}"))?;
                        let fname = filename
                            .clone()
                            .unwrap_or_else(|| {
                                std::path::Path::new(path)
                                    .file_name()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("file")
                                    .to_string()
                            });
                        let mut part = reqwest::multipart::Part::bytes(bytes).file_name(fname);
                        if let Some(ct) = content_type {
                            if !ct.is_empty() {
                                part = part.mime_str(ct).map_err(|e| format!("invalid mime '{ct}': {e}"))?;
                            }
                        }
                        form = form.part(key.clone(), part);
                    }
                }
            }
            builder.multipart(form)
        }
        Body::Binary(bin) => {
            let bytes = std::fs::read(&bin.path)
                .map_err(|e| format!("could not read file '{}': {e}", bin.path))?;
            let mut b = builder.body(bytes);
            if !has_header(&req.headers, "content-type") {
                let ct = bin.content_type.clone().unwrap_or_else(|| "application/octet-stream".to_string());
                b = b.header(CONTENT_TYPE, ct);
            }
            b
        }
    };

    let resp = builder.send().await.map_err(|e| e.to_string())?;

    let status = resp.status();
    let final_url = resp.url().to_string();
    let mut header_map: HashMap<String, String> = HashMap::new();
    for (k, v) in resp.headers().iter() {
        header_map.insert(k.to_string(), v.to_str().unwrap_or("").to_string());
    }

    let raw = resp.bytes().await.map_err(|e| e.to_string())?;

    // reqwest auto-decompresses gzip/deflate/brotli when its features are
    // enabled and strips the Content-Encoding header on success. If the
    // header is still present, decompression didn't happen (e.g. user-set
    // Accept-Encoding sent something we don't recognize, or the server
    // mislabelled the body) — try the common encodings ourselves.
    let body_bytes = match header_map
        .get("content-encoding")
        .map(|s| s.to_ascii_lowercase())
    {
        Some(enc) if enc.contains("gzip") || enc.contains("x-gzip") => {
            decompress_gzip(&raw).unwrap_or_else(|| raw.to_vec())
        }
        Some(enc) if enc.contains("deflate") => {
            decompress_deflate(&raw).unwrap_or_else(|| raw.to_vec())
        }
        Some(enc) if enc.contains("br") => {
            decompress_brotli(&raw).unwrap_or_else(|| raw.to_vec())
        }
        _ => raw.to_vec(),
    };

    if body_bytes.len() != raw.len() {
        // We just decompressed; the size & encoding header would mislead the UI.
        header_map.remove("content-encoding");
        header_map.insert("content-length".to_string(), body_bytes.len().to_string());
    }

    let size = body_bytes.len();
    let content_type = header_map
        .get("content-type")
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let (body_string, is_b64) = if is_textual_content_type(&content_type) {
        // Decode lossily so a single invalid UTF-8 byte (BOM, latin-1 stray,
        // mismatched charset) doesn't force the whole body to base64.
        (String::from_utf8_lossy(&body_bytes).into_owned(), false)
    } else {
        match std::str::from_utf8(&body_bytes) {
            Ok(s) => (s.to_string(), false),
            Err(_) => (B64.encode(&body_bytes), true),
        }
    };

    Ok(ExecuteResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: header_map,
        body: body_string,
        body_is_base64: is_b64,
        elapsed_ms: started.elapsed().as_millis(),
        size_bytes: size,
        final_url,
    })
}

fn build_proxy(p: &ProxyConfig) -> Result<reqwest::Proxy, String> {
    // Accept urls like:
    //   http://host:port    https://host:port    socks5://host:port
    //   socks5h://host:port  socks4://host:port  host:port (assumed http)
    // Auth is encoded in the URL: scheme://user:pass@host:port
    let raw = p.url.trim();
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{}", raw)
    };

    let parsed =
        url::Url::parse(&with_scheme).map_err(|e| format!("invalid proxy url: {e}"))?;

    let scheme = parsed.scheme().to_ascii_lowercase();
    if !matches!(
        scheme.as_str(),
        "http" | "https" | "socks5" | "socks5h" | "socks4" | "socks4a"
    ) {
        return Err(format!("unsupported proxy scheme: {scheme}"));
    }

    let user = parsed.username();
    let auth = if user.is_empty() {
        None
    } else {
        Some((
            urlencoding_decode(user),
            urlencoding_decode(parsed.password().unwrap_or("")),
        ))
    };

    let bypass: Vec<String> = p
        .bypass
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mut proxy = if bypass.is_empty() {
        reqwest::Proxy::all(with_scheme).map_err(|e| format!("invalid proxy: {e}"))?
    } else {
        let proxy_url = with_scheme;
        reqwest::Proxy::custom(move |url| {
            let host = url.host_str().unwrap_or("");
            if bypass.iter().any(|p| host_matches(host, p)) {
                None
            } else {
                Some(proxy_url.clone())
            }
        })
    };

    if let Some((u, pw)) = auth {
        proxy = proxy.basic_auth(&u, &pw);
    }

    Ok(proxy)
}

fn host_matches(host: &str, pattern: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    if let Some(suffix) = pattern.strip_prefix("*.") {
        return host == suffix || host.ends_with(&format!(".{}", suffix));
    }
    host.eq_ignore_ascii_case(pattern)
}

fn urlencoding_decode(s: &str) -> String {
    // Minimal percent-decoder for proxy creds; reqwest will re-encode.
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (
                hex_val(bytes[i + 1]),
                hex_val(bytes[i + 2]),
            ) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn has_header(headers: &[KeyValue], name: &str) -> bool {
    headers
        .iter()
        .any(|h| h.enabled && h.key.eq_ignore_ascii_case(name))
}

fn is_textual_content_type(ct: &str) -> bool {
    if ct.is_empty() {
        return false;
    }
    let head = ct.split(';').next().unwrap_or("").trim();
    head.starts_with("text/")
        || head == "application/json"
        || head == "application/xml"
        || head == "application/javascript"
        || head == "application/ecmascript"
        || head == "application/graphql"
        || head == "application/x-www-form-urlencoded"
        || head == "application/ld+json"
        || head == "application/problem+json"
        || head == "application/problem+xml"
        || head == "application/soap+xml"
        || head.ends_with("+json")
        || head.ends_with("+xml")
}

fn decompress_gzip(b: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(b)
        .read_to_end(&mut out)
        .ok()
        .map(|_| out)
}

fn decompress_deflate(b: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    // Servers labelling responses `Content-Encoding: deflate` send raw deflate
    // about half the time and zlib-wrapped deflate the other half. Try zlib
    // first (the spec-correct shape), fall back to raw.
    if flate2::read::ZlibDecoder::new(b).read_to_end(&mut out).is_ok() {
        return Some(out);
    }
    out.clear();
    flate2::read::DeflateDecoder::new(b)
        .read_to_end(&mut out)
        .ok()
        .map(|_| out)
}

fn decompress_brotli(b: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut out = Vec::new();
    brotli::Decompressor::new(b, 4096)
        .read_to_end(&mut out)
        .ok()
        .map(|_| out)
}
