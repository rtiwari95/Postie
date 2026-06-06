// Import a Postman v2.1 collection JSON and a Postman environment JSON
// into Postie's internal shapes.

export function importPostmanCollection(json) {
  if (!json || !json.info || !Array.isArray(json.item)) {
    throw new Error('Not a Postman v2.1 collection');
  }
  const requests = [];
  walk(json.item, requests, []);
  return {
    name: json.info.name || 'Imported',
    requests,
  };
}

function walk(items, out, prefix) {
  for (const item of items) {
    if (Array.isArray(item.item)) {
      walk(item.item, out, prefix.concat(item.name || 'folder'));
    } else if (item.request) {
      out.push({
        name: prefix.concat(item.name || 'request').join(' / '),
        request: convertRequest(item.request),
      });
    }
  }
}

function convertRequest(r) {
  const method = (typeof r === 'string' ? 'GET' : r.method || 'GET').toUpperCase();
  const urlObj = typeof r === 'string' ? { raw: r } : r.url || {};
  const rawUrl = typeof urlObj === 'string' ? urlObj : urlObj.raw || rebuildUrl(urlObj);

  const [base, queryFromUrl] = splitUrl(rawUrl);

  const query = (urlObj.query || []).map((q) => ({
    key: q.key || '',
    value: q.value || '',
    enabled: !q.disabled,
  }));
  for (const q of queryFromUrl) {
    if (!query.find((x) => x.key === q.key)) query.push(q);
  }

  const headers = ((r.header) || []).map((h) => ({
    key: h.key || '',
    value: h.value || '',
    enabled: !h.disabled,
  }));

  const body = convertBody(r.body);
  const auth = convertAuth(r.auth);

  return { method, url: base, headers, query, body, auth };
}

function convertAuth(a) {
  if (!a || !a.type) return { type: 'none' };
  // Postman auth: { type: 'basic'|'bearer'|'apikey'|'noauth'|..., basic:[{key,value},...], bearer:[...], apikey:[...] }
  const get = (key, val) => {
    const arr = a[a.type];
    if (Array.isArray(arr)) {
      const hit = arr.find((x) => x.key === key);
      return hit ? hit.value : val;
    }
    if (arr && typeof arr === 'object') return arr[key] != null ? arr[key] : val;
    return val;
  };
  switch (a.type) {
    case 'basic':
      return { type: 'basic', username: get('username', ''), password: get('password', '') };
    case 'bearer':
      return { type: 'bearer', token: get('token', '') };
    case 'apikey': {
      const inLoc = (get('in', 'header') || 'header').toLowerCase();
      return { type: 'apikey', key: get('key', ''), value: get('value', ''), in: inLoc === 'query' ? 'query' : 'header' };
    }
    default:
      return { type: 'none' };
  }
}

function rebuildUrl(u) {
  const proto = u.protocol ? `${u.protocol}://` : '';
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
  const port = u.port ? `:${u.port}` : '';
  const pathArr = Array.isArray(u.path) ? u.path : (u.path ? [u.path] : []);
  const path = pathArr.length ? '/' + pathArr.join('/') : '';
  return `${proto}${host}${port}${path}`;
}

function splitUrl(raw) {
  const i = (raw || '').indexOf('?');
  if (i === -1) return [raw || '', []];
  const base = raw.slice(0, i);
  const qs = raw.slice(i + 1);
  const pairs = qs.split('&').filter(Boolean).map((p) => {
    const eq = p.indexOf('=');
    return {
      key: eq === -1 ? p : decodeURIComponent(p.slice(0, eq).replace(/\+/g, ' ')),
      value: eq === -1 ? '' : decodeURIComponent(p.slice(eq + 1).replace(/\+/g, ' ')),
      enabled: true,
    };
  });
  return [base, pairs];
}

function convertBody(b) {
  // Backend's Body enum is adjacently-tagged; the `none` variant must NOT
  // carry a `content` field, or serde rejects the payload.
  if (!b || b.mode === 'none' || !b.mode) return { type: 'none' };
  switch (b.mode) {
    case 'raw': {
      const lang = (b.options && b.options.raw && b.options.raw.language) || '';
      const txt = b.raw || '';
      if (lang === 'json' || /^\s*[{[]/.test(txt)) return { type: 'json', content: txt };
      if (lang === 'xml' || /^\s*</.test(txt)) return { type: 'xml', content: txt };
      return { type: 'text', content: txt };
    }
    case 'urlencoded':
      return {
        type: 'urlencoded',
        content: (b.urlencoded || []).map((p) => ({
          key: p.key || '', value: p.value || '', enabled: !p.disabled,
        })),
      };
    case 'formdata':
      return {
        type: 'form',
        content: (b.formdata || [])
          .filter((p) => p.type !== 'file')
          .map((p) => ({ key: p.key || '', value: p.value || '', enabled: !p.disabled })),
      };
    default:
      return { type: 'text', content: typeof b.raw === 'string' ? b.raw : '' };
  }
}

// ----- Export -----
//
// Round-trips importPostmanCollection: produces a Postman v2.1 collection
// JSON that can be imported back into Postman. Folders are reconstructed
// from " / "-separated names (the same delimiter walk() emits on import).

export function exportPostmanCollection(collection) {
  if (!collection || !Array.isArray(collection.requests)) {
    throw new Error('Not a valid collection');
  }
  // Group requests into a folder tree based on " / " path segments in the
  // request name. Single-segment names become top-level items.
  const root = { items: [], folders: new Map() };
  for (const r of collection.requests) {
    const parts = String(r.name || 'request').split(' / ');
    const leafName = parts.pop();
    let cursor = root;
    for (const folder of parts) {
      if (!cursor.folders.has(folder)) {
        cursor.folders.set(folder, { items: [], folders: new Map() });
      }
      cursor = cursor.folders.get(folder);
    }
    cursor.items.push({ ...r, _leafName: leafName });
  }

  return {
    info: {
      name: collection.name || 'Collection',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      _postman_id: collection.id || undefined,
    },
    item: serializeNode(root),
  };
}

function serializeNode(node) {
  const out = [];
  for (const [name, child] of node.folders) {
    out.push({ name, item: serializeNode(child) });
  }
  for (const r of node.items) {
    out.push({ name: r._leafName, request: requestToPostman(r.request) });
  }
  return out;
}

function requestToPostman(req) {
  const out = {
    method: (req.method || 'GET').toUpperCase(),
    header: (req.headers || []).map((h) => ({
      key: h.key || '', value: h.value || '',
      ...(h.description ? { description: h.description } : {}),
      ...(h.enabled === false ? { disabled: true } : {}),
    })),
    url: urlToPostman(req.url || '', req.query || []),
  };
  const body = bodyToPostman(req.body);
  if (body) out.body = body;
  const auth = authToPostman(req.auth);
  if (auth) out.auth = auth;
  return out;
}

function urlToPostman(rawBase, query) {
  // Postman accepts a `raw` URL plus a structured `query` array. Splitting
  // host/path/protocol is best-effort — Postman re-parses `raw` on import,
  // so the structured fields are mostly cosmetic. We provide them anyway
  // so the collection looks right in the Postman UI.
  const enabledQuery = (query || []).map((q) => ({
    key: q.key || '', value: q.value || '',
    ...(q.description ? { description: q.description } : {}),
    ...(q.enabled === false ? { disabled: true } : {}),
  }));
  const raw = appendQuery(rawBase, query);
  let protocol, host, port, path;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(rawBase) ? rawBase : 'https://' + rawBase);
    protocol = u.protocol.replace(':', '') || undefined;
    host = u.hostname ? u.hostname.split('.') : undefined;
    port = u.port || undefined;
    path = u.pathname && u.pathname !== '/' ? u.pathname.replace(/^\//, '').split('/') : undefined;
  } catch { /* leave structured fields off if parse fails */ }
  return {
    raw,
    ...(protocol ? { protocol } : {}),
    ...(host ? { host } : {}),
    ...(port ? { port } : {}),
    ...(path ? { path } : {}),
    ...(enabledQuery.length ? { query: enabledQuery } : {}),
  };
}

function appendQuery(base, query) {
  const enabled = (query || []).filter((q) => q.enabled !== false && q.key);
  if (!enabled.length) return base || '';
  const qs = enabled
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value || '')}`)
    .join('&');
  return (base || '') + (base.includes('?') ? '&' : '?') + qs;
}

function bodyToPostman(b) {
  if (!b || b.type === 'none') return null;
  switch (b.type) {
    case 'json':
      return { mode: 'raw', raw: typeof b.content === 'string' ? b.content : '',
               options: { raw: { language: 'json' } } };
    case 'xml':
      return { mode: 'raw', raw: typeof b.content === 'string' ? b.content : '',
               options: { raw: { language: 'xml' } } };
    case 'html':
      return { mode: 'raw', raw: typeof b.content === 'string' ? b.content : '',
               options: { raw: { language: 'html' } } };
    case 'javascript':
      return { mode: 'raw', raw: typeof b.content === 'string' ? b.content : '',
               options: { raw: { language: 'javascript' } } };
    case 'text':
      return { mode: 'raw', raw: typeof b.content === 'string' ? b.content : '' };
    case 'urlencoded':
      return { mode: 'urlencoded',
               urlencoded: (b.content || []).map((p) => ({
                 key: p.key || '', value: p.value || '',
                 ...(p.enabled === false ? { disabled: true } : {}),
               })) };
    case 'form':
    case 'formdata':
      return { mode: 'formdata',
               formdata: (b.content || []).map((p) => ({
                 key: p.key || '', value: p.value || '', type: 'text',
                 ...(p.enabled === false ? { disabled: true } : {}),
               })) };
    case 'binary':
      // Postman stores binary as a file path that doesn't survive across
      // machines. Skip the body — the recipient picks the file again.
      return null;
    default:
      return null;
  }
}

function authToPostman(a) {
  if (!a || !a.type || a.type === 'none') return null;
  switch (a.type) {
    case 'basic':
      return { type: 'basic', basic: [
        { key: 'username', value: a.username || '', type: 'string' },
        { key: 'password', value: a.password || '', type: 'string' },
      ] };
    case 'bearer':
      return { type: 'bearer', bearer: [
        { key: 'token', value: a.token || '', type: 'string' },
      ] };
    case 'apikey':
      return { type: 'apikey', apikey: [
        { key: 'key', value: a.key || '', type: 'string' },
        { key: 'value', value: a.value || '', type: 'string' },
        { key: 'in', value: a.in === 'query' ? 'query' : 'header', type: 'string' },
      ] };
    default:
      return null;
  }
}

export function importPostmanEnvironment(json) {
  if (!json || !Array.isArray(json.values)) {
    throw new Error('Not a Postman environment');
  }
  return {
    name: json.name || 'Imported env',
    variables: json.values.map((v) => ({
      key: v.key || '',
      value: v.value || '',
      enabled: v.enabled !== false,
    })),
  };
}
