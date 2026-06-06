// Thin wrapper around the Rust backend's HTTP API.

let baseUrl = null;

export async function init() {
  const port = await window.postie.getPort();
  baseUrl = `http://127.0.0.1:${port}`;
}

async function jsonFetch(path, opts = {}) {
  const res = await fetch(baseUrl + path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(`${res.status} ${res.statusText}${detail ? ': ' + detail : ''}`);
  }
  return res.json();
}

export const api = {
  workspace: () => jsonFetch('/workspace'),
  execute: (req, signal) =>
    jsonFetch('/execute', { method: 'POST', body: JSON.stringify(req), signal }),
  createCollection: (c) =>
    jsonFetch('/collections', { method: 'POST', body: JSON.stringify(c) }),
  updateCollection: (id, c) =>
    jsonFetch(`/collections/${id}`, { method: 'PUT', body: JSON.stringify(c) }),
  deleteCollection: (id) =>
    jsonFetch(`/collections/${id}`, { method: 'DELETE' }),
  addRequest: (cid, r) =>
    jsonFetch(`/collections/${cid}/requests`, { method: 'POST', body: JSON.stringify(r) }),
  updateRequest: (cid, rid, r) =>
    jsonFetch(`/collections/${cid}/requests/${rid}`, { method: 'PUT', body: JSON.stringify(r) }),
  deleteRequest: (cid, rid) =>
    jsonFetch(`/collections/${cid}/requests/${rid}`, { method: 'DELETE' }),
  createEnvironment: (e) =>
    jsonFetch('/environments', { method: 'POST', body: JSON.stringify(e) }),
  updateEnvironment: (id, e) =>
    jsonFetch(`/environments/${id}`, { method: 'PUT', body: JSON.stringify(e) }),
  deleteEnvironment: (id) =>
    jsonFetch(`/environments/${id}`, { method: 'DELETE' }),
  setActiveEnvironment: (id) =>
    jsonFetch('/environments/active', { method: 'POST', body: JSON.stringify({ id }) }),
  setProxy: (cfg) => jsonFetch('/proxy', { method: 'PUT', body: JSON.stringify(cfg) }),
  clearHistory: () => jsonFetch('/history', { method: 'DELETE' }),
};
