// Parse a `curl ...` command string into a Postie request.
// Handles line-continuations, quoting, common flags, and `@filename` skipping.

export function isCurl(text) {
  return /^\s*curl(\s|$)/i.test(text);
}

// Split text containing multiple curl commands into individual ones.
// Detects new commands by lines starting with "curl" (after handling
// shell line-continuations).
export function splitCurlCommands(input) {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // First, join shell line-continuations so each command is on a single line
  const normalized = trimmed.replace(/\\\r?\n/g, ' ');
  const lines = normalized.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const commands = [];
  let current = '';

  for (const line of lines) {
    if (/^curl(\s|$)/i.test(line)) {
      if (current) commands.push(current.trim());
      current = line;
    } else if (current) {
      current += ' ' + line;
    }
  }
  if (current) commands.push(current.trim());

  return commands.length > 0 ? commands : [trimmed];
}

export function parseCurl(input) {
  const cleaned = input.replace(/\\\r?\n/g, ' ').trim();
  const tokens = tokenize(cleaned);
  if (!tokens.length || tokens[0].toLowerCase() !== 'curl') {
    throw new Error('Not a curl command');
  }

  let method = null;
  const headers = [];
  const dataParts = [];
  const formParts = []; // multipart
  const urlencodedParts = []; // when --data-urlencode used
  let url = null;
  let user = null;
  let bodyType = null; // 'data' | 'form' | 'urlencoded'

  const expectsValue = new Set([
    '-X', '--request',
    '-H', '--header',
    '-d', '--data', '--data-raw', '--data-binary', '--data-ascii',
    '--data-urlencode',
    '-F', '--form',
    '-u', '--user',
    '-A', '--user-agent',
    '-e', '--referer',
    '-b', '--cookie',
    '--url',
    '-o', '--output',
    '--max-time', '--connect-timeout',
  ]);

  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];

    if (t === '-X' || t === '--request') {
      method = (tokens[++i] || '').toUpperCase();
    } else if (t === '-H' || t === '--header') {
      const h = tokens[++i] || '';
      const idx = h.indexOf(':');
      if (idx > -1) {
        headers.push({
          key: h.slice(0, idx).trim(),
          value: h.slice(idx + 1).trim(),
          enabled: true,
        });
      }
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-ascii') {
      let v = tokens[++i] || '';
      if (v.startsWith('@')) v = ''; // file refs not supported in renderer
      dataParts.push(v);
      bodyType = bodyType || 'data';
    } else if (t === '--data-urlencode') {
      const v = tokens[++i] || '';
      urlencodedParts.push(v);
      bodyType = 'urlencoded';
    } else if (t === '-F' || t === '--form') {
      formParts.push(tokens[++i] || '');
      bodyType = 'form';
    } else if (t === '-u' || t === '--user') {
      user = tokens[++i] || '';
    } else if (t === '-A' || t === '--user-agent') {
      headers.push({ key: 'User-Agent', value: tokens[++i] || '', enabled: true });
    } else if (t === '-e' || t === '--referer') {
      headers.push({ key: 'Referer', value: tokens[++i] || '', enabled: true });
    } else if (t === '-b' || t === '--cookie') {
      headers.push({ key: 'Cookie', value: tokens[++i] || '', enabled: true });
    } else if (t === '--url') {
      url = tokens[++i] || '';
    } else if (expectsValue.has(t)) {
      i++; // consume value, ignore
    } else if (t === '-G' || t === '--get') {
      method = method || 'GET';
    } else if (t === '-I' || t === '--head') {
      method = method || 'HEAD';
    } else if (t.startsWith('-')) {
      // boolean flag we don't care about (--compressed, -L, -k, -s, -v, ...)
    } else if (!url) {
      url = t;
    }
  }

  if (!url) throw new Error('curl command has no URL');

  // -u user:pass becomes Basic auth on the auth tab (cleaner than a manual header)
  let auth = { type: 'none' };
  if (user) {
    const i = user.indexOf(':');
    const username = i === -1 ? user : user.slice(0, i);
    const password = i === -1 ? '' : user.slice(i + 1);
    auth = { type: 'basic', username, password };
  }

  // Curl accepts schemeless URLs (`example.com/foo`); url::Url::parse rejects
  // them. Prepend https:// so the request bar shows the full URL.
  if (!/^[a-z][a-z0-9+\-.]*:\/\//i.test(url)) {
    url = 'https://' + url;
  }

  // Split URL → base + query params (Postie shows them in the Params tab).
  let base = url;
  const query = [];
  const qIdx = url.indexOf('?');
  if (qIdx > -1) {
    base = url.slice(0, qIdx);
    const qs = url.slice(qIdx + 1);
    for (const pair of qs.split('&')) {
      if (!pair) continue;
      const eq = pair.indexOf('=');
      const k = eq === -1 ? pair : pair.slice(0, eq);
      const v = eq === -1 ? '' : pair.slice(eq + 1);
      query.push({
        key: safeDecode(k),
        value: safeDecode(v),
        enabled: true,
      });
    }
  }

  let body = { type: 'none', content: '' };

  if (bodyType === 'data' && dataParts.length) {
    const joined = dataParts.join('&');
    const ct = (headers.find((h) => h.key.toLowerCase() === 'content-type') || {}).value || '';
    if (/json/i.test(ct) || isLikelyJson(joined)) {
      body = { type: 'json', content: joined };
    } else if (/xml/i.test(ct)) {
      body = { type: 'xml', content: joined };
    } else if (/x-www-form-urlencoded/i.test(ct) || looksFormEncoded(joined)) {
      body = { type: 'urlencoded', content: parseFormPairs(joined) };
    } else {
      body = { type: 'text', content: joined };
    }
  } else if (bodyType === 'urlencoded') {
    const pairs = urlencodedParts.map((p) => {
      const eq = p.indexOf('=');
      if (eq === -1) return { key: p, value: '', enabled: true };
      return { key: p.slice(0, eq), value: p.slice(eq + 1), enabled: true };
    });
    body = { type: 'urlencoded', content: pairs };
  } else if (bodyType === 'form') {
    const pairs = formParts.map((p) => {
      const eq = p.indexOf('=');
      if (eq === -1) return { key: p, value: '', enabled: true };
      let v = p.slice(eq + 1);
      if (v.startsWith('@') || v.startsWith('<')) v = ''; // skip file refs
      return { key: p.slice(0, eq), value: v, enabled: true };
    });
    body = { type: 'form', content: pairs };
  }

  if (!method) method = body.type === 'none' ? 'GET' : 'POST';

  return {
    method,
    url: base,
    headers,
    query,
    body,
    auth,
  };
}

function safeDecode(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}
function isLikelyJson(s) {
  const t = s.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}
function looksFormEncoded(s) {
  return /^[\w\-\.~%+]+=([^&]*)?(&[\w\-\.~%+]+=([^&]*)?)*$/.test(s);
}
function parseFormPairs(s) {
  return s.split('&').filter(Boolean).map((p) => {
    const eq = p.indexOf('=');
    return {
      key: safeDecode(eq === -1 ? p : p.slice(0, eq)),
      value: safeDecode(eq === -1 ? '' : p.slice(eq + 1)),
      enabled: true,
    };
  });
}

// Shell-ish tokenizer: handles ' ', " ", $'...' (ANSI-C), backslash escapes.
function tokenize(input) {
  const out = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    while (i < n && /\s/.test(input[i])) i++;
    if (i >= n) break;

    let token = '';
    let inSingle = false;
    let inDouble = false;
    let inAnsiC = false;

    while (i < n) {
      const c = input[i];

      if (!inSingle && !inDouble && !inAnsiC && /\s/.test(c)) break;

      if (inAnsiC) {
        if (c === "'") { inAnsiC = false; i++; continue; }
        if (c === '\\' && i + 1 < n) {
          token += ansiCEscape(input[i + 1]);
          i += 2;
          continue;
        }
        token += c; i++; continue;
      }

      if (inSingle) {
        if (c === "'") { inSingle = false; i++; continue; }
        token += c; i++; continue;
      }

      if (inDouble) {
        if (c === '"') { inDouble = false; i++; continue; }
        if (c === '\\' && i + 1 < n) {
          const next = input[i + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
            token += next; i += 2; continue;
          }
        }
        token += c; i++; continue;
      }

      if (c === "'") { inSingle = true; i++; continue; }
      if (c === '"') { inDouble = true; i++; continue; }
      if (c === '$' && input[i + 1] === "'") { inAnsiC = true; i += 2; continue; }
      if (c === '\\' && i + 1 < n) {
        token += input[i + 1]; i += 2; continue;
      }

      token += c; i++;
    }

    out.push(token);
  }

  return out;
}

function ansiCEscape(c) {
  const map = { n: '\n', r: '\r', t: '\t', '\\': '\\', "'": "'", '"': '"', '0': '\0' };
  return map[c] ?? c;
}
