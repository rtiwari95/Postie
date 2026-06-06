// Build a `curl` command line from a Postie request.
// Single-quote shell-escaping: ' → '\'' so values with quotes/newlines survive.

export function toCurl(req) {
  const parts = ['curl'];
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET') parts.push('-X', method);

  const url = buildUrl(req.url, req.query);
  parts.push(q(url));

  const headers = (req.headers || []).filter((h) => h.enabled !== false && h.key);
  for (const h of headers) {
    parts.push('-H', q(`${h.key}: ${h.value}`));
  }

  const b = req.body;
  if (b && b.type && b.type !== 'none') {
    if (b.type === 'json' || b.type === 'xml' || b.type === 'text') {
      const ct = headerValue(headers, 'content-type');
      if (!ct) {
        if (b.type === 'json') parts.push('-H', q('Content-Type: application/json'));
        else if (b.type === 'xml') parts.push('-H', q('Content-Type: application/xml'));
      }
      parts.push('--data-raw', q(b.content || ''));
    } else if (b.type === 'urlencoded') {
      const items = (b.content || []).filter((p) => p.enabled !== false && p.key);
      const encoded = items
        .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`)
        .join('&');
      if (!headerValue(headers, 'content-type')) {
        parts.push('-H', q('Content-Type: application/x-www-form-urlencoded'));
      }
      parts.push('--data-raw', q(encoded));
    } else if (b.type === 'form') {
      const items = (b.content || []).filter((p) => p.enabled !== false && p.key);
      for (const p of items) {
        parts.push('-F', q(`${p.key}=${p.value || ''}`));
      }
    }
  }

  return parts.join(' ');
}

function buildUrl(url, query) {
  const enabled = (query || []).filter((p) => p.enabled !== false && p.key);
  if (!enabled.length) return url || '';
  const sep = (url || '').includes('?') ? '&' : '?';
  const qs = enabled
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value || '')}`)
    .join('&');
  return (url || '') + sep + qs;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const hit = headers.find((h) => (h.key || '').toLowerCase() === lower);
  return hit ? hit.value : null;
}

function q(s) {
  const str = String(s ?? '');
  return `'${str.replace(/'/g, `'\\''`)}'`;
}
