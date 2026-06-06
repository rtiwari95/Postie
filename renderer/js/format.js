// JSON & XML pretty-printers. The XML formatter is a small, dependency-free
// indenter — good enough for typical API responses, not a full parser.

export function formatJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function formatXml(text) {
  if (!text || typeof text !== 'string') return text;

  // Push tokens into an array and .join() at the end — O(n). The previous
  // implementation rebuilt `out` on every iteration, which is O(n²) and
  // freezes the renderer on bodies >100KB.
  const src = text
    .replace(/>\s+</g, '><')
    .replace(/^\s+|\s+$/g, '');
  const parts = [];
  let indent = 0;
  let pendingInlineText = false; // last token written was a text node — keep next close-tag inline

  const PADS = ['', '  ', '    ', '      ', '        ', '          ', '            '];
  const pad = (n) => (n < PADS.length ? PADS[n] : '  '.repeat(n));

  const re = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/[^>]+>|<[^>]+\/>|<[^>]+>|[^<]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];

    if (tok.startsWith('<!--') || tok.startsWith('<?') || tok.startsWith('<![CDATA[')) {
      parts.push(pad(indent), tok, '\n');
      pendingInlineText = false;
      continue;
    }
    if (tok.startsWith('</')) {
      indent = Math.max(indent - 1, 0);
      if (pendingInlineText) {
        parts.push(tok, '\n');
      } else {
        parts.push(pad(indent), tok, '\n');
      }
      pendingInlineText = false;
      continue;
    }
    if (tok.startsWith('<') && tok.endsWith('/>')) {
      parts.push(pad(indent), tok, '\n');
      pendingInlineText = false;
      continue;
    }
    if (tok.startsWith('<')) {
      parts.push(pad(indent), tok);
      indent++;
      pendingInlineText = false;
      // Don't emit \n yet — if the next token is a short text node we want it
      // inline. We'll emit \n at the start of the next non-text token.
      parts.push('__PENDING_NL__');
      continue;
    }
    // Text node.
    const trimmed = tok.trim();
    if (trimmed) {
      // If the previous pushed marker is __PENDING_NL__, drop it (inline open tag).
      if (parts[parts.length - 1] === '__PENDING_NL__') parts.pop();
      else if (parts[parts.length - 1] === '\n') parts.pop();
      parts.push(trimmed);
      pendingInlineText = true;
    }
  }

  // Flush any remaining pending newlines.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '__PENDING_NL__') parts[i] = '\n';
  }

  return parts.join('').trimEnd();
}

export function detectFormat(headers, body) {
  const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  if (ct.includes('json') || /^\s*[{[]/.test(body)) return 'json';
  if (ct.includes('xml') || /^\s*<\?xml|^\s*</.test(body)) return 'xml';
  return 'text';
}

// Skip auto-formatting for very large bodies — formatting is fast on the new
// array-based path, but parse/stringify on a multi-MB JSON still blocks the
// renderer. The user can still trigger it manually with the Format button.
const AUTO_FORMAT_LIMIT = 1_000_000;

export function autoFormat(headers, body) {
  if (typeof body === 'string' && body.length > AUTO_FORMAT_LIMIT) return body;
  const kind = detectFormat(headers, body);
  if (kind === 'json') return formatJson(body);
  if (kind === 'xml') return formatXml(body);
  return body;
}
