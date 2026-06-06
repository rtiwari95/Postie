// Postman-style post-response test runner.
//
// Executes a user-provided script string against a frozen response object,
// exposing a small `pm.*` API for assertions and variable extraction.
//
// Returns: {
//   tests: [{name, passed, error?}],   // each pm.test() invocation
//   logs: [string],                     // console.log output
//   warnings: [string],                 // non-fatal issues (e.g. no active env)
//   envWrites: [{key, value, op}],      // env.set/.unset calls — flushed by caller
//   error?: string,                     // top-level script error
// }

const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  429: 'Too Many Requests', 500: 'Internal Server Error',
  502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

function buildExpect(value) {
  // Chai-like fluent API. Each method returns `this` so users can chain.
  // Errors throw — pm.test() catches them and marks the test failed.
  const api = {
    to: null,
    be: null,
    have: null,
    not: false,
    equal(other) {
      const ok = value === other;
      this._check(ok, `expected ${stringify(value)} to equal ${stringify(other)}`);
      return this;
    },
    eql(other) {
      const ok = deepEqual(value, other);
      this._check(ok, `expected ${stringify(value)} to deep-equal ${stringify(other)}`);
      return this;
    },
    a(type) {
      const t = typeof value;
      const ok = (type === 'array') ? Array.isArray(value)
        : (type === 'null') ? value === null
        : t === type;
      this._check(ok, `expected typeof ${stringify(value)} to be "${type}", got "${Array.isArray(value) ? 'array' : t}"`);
      return this;
    },
    status(code) {
      const ok = value === code;
      this._check(ok, `expected status ${value} to equal ${code}`);
      return this;
    },
    include(needle) {
      let ok = false;
      if (typeof value === 'string') ok = value.includes(needle);
      else if (Array.isArray(value)) ok = value.includes(needle);
      else if (value && typeof value === 'object') ok = Object.prototype.hasOwnProperty.call(value, needle);
      this._check(ok, `expected ${stringify(value)} to include ${stringify(needle)}`);
      return this;
    },
    exist() {
      this._check(value !== null && value !== undefined, `expected value to exist (got ${stringify(value)})`);
      return this;
    },
    above(n) {
      this._check(typeof value === 'number' && value > n, `expected ${value} to be above ${n}`);
      return this;
    },
    below(n) {
      this._check(typeof value === 'number' && value < n, `expected ${value} to be below ${n}`);
      return this;
    },
    _check(ok, msg) {
      if (this.not) ok = !ok;
      if (!ok) throw new Error(this.not ? `NOT: ${msg}` : msg);
    },
  };
  // `to`, `be`, `have` are pure passthroughs — pm.expect(x).to.have.status(200)
  api.to = api;
  api.be = api;
  api.have = api;
  // `not` returns a fresh chain with the negation flag set
  Object.defineProperty(api, 'not', {
    get() {
      const flipped = buildExpect(value);
      flipped.not = true;
      return flipped;
    },
  });
  return api;
}

function stringify(v) {
  if (typeof v === 'string') return JSON.stringify(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual(a[k], b[k]));
}

// Builds the response wrapper passed to user scripts as `pm.response`.
function buildResponseApi(resp) {
  const headers = resp?.headers || {};
  // Lower-case index for case-insensitive .headers.get()
  const lcHeaders = {};
  for (const k of Object.keys(headers)) lcHeaders[k.toLowerCase()] = headers[k];

  let parsedJson;
  let jsonError;
  const tryJson = () => {
    if (parsedJson !== undefined) return parsedJson;
    if (jsonError) throw jsonError;
    try { parsedJson = JSON.parse(resp?.body ?? ''); }
    catch (e) { jsonError = e; throw e; }
    return parsedJson;
  };

  return {
    code: resp?.status ?? 0,
    status: resp?.status_text || STATUS_TEXT[resp?.status] || '',
    responseTime: resp?.elapsed_ms ?? 0,
    headers: {
      get(name) { return lcHeaders[String(name).toLowerCase()]; },
      has(name) { return Object.prototype.hasOwnProperty.call(lcHeaders, String(name).toLowerCase()); },
      all() { return { ...headers }; },
    },
    text() { return resp?.body ?? ''; },
    json() { return tryJson(); },
  };
}

export function runTests(script, resp, ctx) {
  const result = {
    tests: [],
    logs: [],
    warnings: [],
    envWrites: [],
  };
  if (!script || !script.trim()) return result;

  const env = ctx?.environment || null;
  const envVars = env?.variables || [];

  const envApi = {
    name: env?.name || null,
    get(key) {
      const hit = envVars.find((v) => v.enabled !== false && v.key === key);
      return hit ? hit.value : undefined;
    },
    set(key, value) {
      if (!env) {
        result.warnings.push(`pm.environment.set("${key}", ...) ignored — no active environment selected.`);
        return;
      }
      result.envWrites.push({ op: 'set', key: String(key), value: String(value) });
    },
    unset(key) {
      if (!env) {
        result.warnings.push(`pm.environment.unset("${key}") ignored — no active environment selected.`);
        return;
      }
      result.envWrites.push({ op: 'unset', key: String(key) });
    },
    has(key) { return this.get(key) !== undefined; },
  };

  const variablesApi = {
    get(key) { return envApi.get(key); },
  };

  const pm = {
    response: buildResponseApi(resp),
    environment: envApi,
    variables: variablesApi,
    expect: (value) => buildExpect(value),
    test(name, fn) {
      try {
        fn();
        result.tests.push({ name: String(name), passed: true });
      } catch (e) {
        result.tests.push({ name: String(name), passed: false, error: e?.message || String(e) });
      }
    },
  };

  const consoleShim = {
    log: (...args) => result.logs.push(args.map(stringify).join(' ')),
    warn: (...args) => result.logs.push('[warn] ' + args.map(stringify).join(' ')),
    error: (...args) => result.logs.push('[error] ' + args.map(stringify).join(' ')),
  };

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('pm', 'console', script);
    fn(pm, consoleShim);
  } catch (e) {
    result.error = e?.message || String(e);
  }
  return result;
}
