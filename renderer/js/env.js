// {{var}} substitution against an active environment.

export function substitute(value, vars) {
  if (typeof value !== 'string' || !value.includes('{{')) return value;
  return value.replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (_, name) => {
    const hit = vars.find((v) => v.enabled && v.key === name);
    return hit ? hit.value : `{{${name}}}`;
  });
}

export function applyEnvToRequest(req, env) {
  const vars = env?.variables?.filter((v) => v.enabled) || [];
  if (!vars.length) return req;

  const sub = (s) => substitute(s, vars);
  const subKv = (kv) => kv.map((p) => ({ ...p, key: sub(p.key), value: sub(p.value) }));

  const body = (() => {
    if (!req.body || req.body.type === 'none') return req.body;
    if (typeof req.body.content === 'string') {
      return { ...req.body, content: sub(req.body.content) };
    }
    return { ...req.body, content: subKv(req.body.content) };
  })();

  return {
    ...req,
    url: sub(req.url),
    headers: subKv(req.headers || []),
    query: subKv(req.query || []),
    body,
  };
}
