import { init, api } from './api.js';
import { isCurl, parseCurl, splitCurlCommands } from './curl.js';
import { importPostmanCollection, importPostmanEnvironment, exportPostmanCollection } from './postman.js';
import { applyEnvToRequest } from './env.js';
import { autoFormat, formatJson, formatXml, detectFormat } from './format.js';
import { toCurl } from './toCurl.js';
import { createEditor } from './editor.bundle.js';
import { runTests } from './tests.js';

// CodeMirror editors mounted at boot. The body editor reflects the active
// tab's request body; the response editor shows the (possibly truncated)
// response body. The tests editor holds the post-response script.
let bodyEditor = null;
let responseEditor = null;
let testsEditor = null;
let bodyEditorSetting = false; // suppress onChange feedback while we set value programmatically
let testsEditorSetting = false;
let responseLanguage = 'none';

// User-tweakable preferences persisted in localStorage. Defaults are tuned to
// match Postman's current behavior so the app feels familiar out of the box.
const SETTINGS_KEY = 'postie.settings.v1';
const TABS_KEY = 'postie.tabs.v1';
const SETTINGS_DEFAULTS = {
  openInNewTab: true,
  renderLimitMb: 0.5,
  historyCount: 20,
  sidebarCollapsed: false,
  splitRequestPx: null,  // null = not yet sized; resolved on first render
  splitHorizontal: false, // false = top/bottom split, true = side-by-side
  splitRequestPct: 50,    // request panel width % when in horizontal mode
  // When true, Cmd/Ctrl+S over an existing saved request shows a Yes/No
  // confirmation before overwriting. When false, save is silent.
  confirmOverwrite: false,
  // Body syntax-highlighting toggles. When false, the corresponding editor
  // shows plain text — useful for users who find the colors distracting or
  // need to copy raw content without color baggage.
  highlightRequestBody: true,
  highlightResponseBody: true,
};
const settings = loadSettings();
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return { ...SETTINGS_DEFAULTS, ...parsed };
  } catch {
    return { ...SETTINGS_DEFAULTS };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

// Returns the effective language for a body editor, taking the
// "Highlight request/response body" setting into account.
function effectiveRequestLang(kind) {
  return settings.highlightRequestBody === false ? 'none' : kind;
}
function effectiveResponseLang(kind) {
  return settings.highlightResponseBody === false ? 'none' : kind;
}

// Re-applies the highlight setting to the live editors so a settings toggle
// shows up immediately without needing to switch tabs.
function reapplyEditorHighlighting() {
  if (bodyEditor && state.current?.body) {
    bodyEditor.setLanguage(effectiveRequestLang(bodyEditorLanguageFor(state.current.body.type)));
  }
  if (responseEditor) {
    // responseLanguage holds the language we'd show when allowed; respect it.
    responseEditor.setLanguage(effectiveResponseLang(responseLanguage));
  }
  if (testsEditor) {
    // Tests editor follows the request-body setting since it's also user-
    // authored code on the request side.
    testsEditor.setLanguage(effectiveRequestLang('javascript'));
  }
}

// ----- Tab session persistence -----
//
// Tabs (and their last response, when small enough) are restored across
// reloads. We do NOT persist transient runtime state — `pendingSince` and
// `abortController` are dropped, and any in-flight request is treated as
// cancelled across reload.
//
// localStorage caps at ~5 MB per origin in Electron. To stay well under
// that we cap each response body at PERSIST_BODY_CAP and the total payload
// at PERSIST_TOTAL_CAP. When a body is too large to persist, we keep its
// status/headers/timing and mark it with `body_evicted: true` so the
// renderer shows a clear placeholder.
const PERSIST_BODY_CAP = 1024 * 1024;       // 1 MB per response body
const PERSIST_TOTAL_CAP = 4 * 1024 * 1024;  // 4 MB serialized total

function trimResponseForPersist(resp) {
  if (!resp) return null;
  // Errors are tiny strings — keep as-is.
  if (resp.error) return { error: resp.error };
  const body = typeof resp.body === 'string' ? resp.body : '';
  if (body.length <= PERSIST_BODY_CAP) return resp;
  return {
    ...resp,
    body: '',
    body_evicted: true,
    body_size_at_persist: body.length,
  };
}

let persistTabsTimer = null;
function persistTabs() {
  if (persistTabsTimer) return;
  persistTabsTimer = setTimeout(() => {
    persistTabsTimer = null;
    try {
      const payload = {
        activeTabId: state.activeTabId,
        tabs: state.tabs.map((t) => ({
          id: t.id,
          request: t.request,
          savedSnapshot: t.savedSnapshot,
          savedRef: t.savedRef,
          lastResponse: trimResponseForPersist(t.lastResponse),
          lastTestResults: t.lastTestResults || null,
        })),
      };
      let serialized = JSON.stringify(payload);
      // If we're over the total cap, drop response bodies entirely (one pass)
      // and try again. Status/headers stay so the restored tab at least
      // shows what happened.
      if (serialized.length > PERSIST_TOTAL_CAP) {
        for (const t of payload.tabs) {
          if (t.lastResponse && t.lastResponse.body) {
            t.lastResponse = {
              ...t.lastResponse,
              body: '',
              body_evicted: true,
              body_size_at_persist: t.lastResponse.body.length || 0,
            };
          }
        }
        serialized = JSON.stringify(payload);
      }
      // Last resort: if still over, drop responses outright.
      if (serialized.length > PERSIST_TOTAL_CAP) {
        for (const t of payload.tabs) t.lastResponse = null;
        serialized = JSON.stringify(payload);
      }
      localStorage.setItem(TABS_KEY, serialized);
    } catch (e) {
      // Quota errors etc. — drop silently; not worth a dialog.
      console.warn('Failed to persist tabs:', e);
    }
  }, 200);
}

function loadPersistedTabs() {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const state = {
  workspace: { collections: [], environments: [], history: [], active_environment_id: null },
  tabs: [],
  activeTabId: null,
  // .current and .lastResponse are *aliases* into the active tab; reassigned by activateTab().
  current: null,
  lastResponse: null,
  envEdit: null,
  // Set to a tab id when the user picks "Save" in the unsaved-changes prompt;
  // the save-dialog confirm handler reads this and closes the tab after saving.
  pendingCloseAfterSave: null,
};

function blankRequest() {
  return {
    method: 'GET',
    url: '',
    headers: [],
    query: [],
    body: { type: 'none', content: '' },
    auth: { type: 'none' },
    tests: '',
  };
}

// Fills in any missing-but-expected fields on a request loaded from disk so
// the dirty-snapshot comparison stays stable. Mutates and returns the input.
function normalizeRequest(req) {
  if (!req) return req;
  if (!req.body) req.body = { type: 'none', content: '' };
  if (!req.auth) req.auth = { type: 'none' };
  if (typeof req.tests !== 'string') req.tests = '';
  if (!Array.isArray(req.headers)) req.headers = [];
  if (!Array.isArray(req.query)) req.query = [];
  return req;
}

// Inject a default Content-Type header for raw body sub-types if the user
// hasn't already specified one. Called at send time only.
function applyDefaultContentType(payload, body) {
  const ct = defaultContentTypeFor(body && body.type);
  if (!ct) return payload;
  const headers = payload.headers || [];
  const hasCt = headers.some((h) => h.enabled !== false && (h.key || '').toLowerCase() === 'content-type');
  if (hasCt) return payload;
  return { ...payload, headers: [...headers, { key: 'Content-Type', value: ct, enabled: true }] };
}

// Apply the request-level auth into a wire payload's headers/query.
// Called only at send time so the saved request shape stays clean.
function applyAuthToWire(payload, auth) {
  if (!auth || !auth.type || auth.type === 'none') return payload;
  const headers = [...(payload.headers || [])];
  const query = [...(payload.query || [])];

  if (auth.type === 'basic' && (auth.username || auth.password)) {
    const token = btoa(`${auth.username || ''}:${auth.password || ''}`);
    headers.push({ key: 'Authorization', value: `Basic ${token}`, enabled: true });
  } else if (auth.type === 'bearer' && auth.token) {
    headers.push({ key: 'Authorization', value: `Bearer ${auth.token}`, enabled: true });
  } else if (auth.type === 'apikey' && auth.key) {
    const target = auth.in === 'query' ? query : headers;
    target.push({ key: auth.key, value: auth.value || '', enabled: true });
  }
  return { ...payload, headers, query };
}

// Maps a UI body type to a CodeMirror language identifier.
function bodyEditorLanguageFor(type) {
  if (type === 'json') return 'json';
  if (type === 'xml') return 'xml';
  if (type === 'html') return 'html';
  if (type === 'javascript') return 'javascript';
  return 'none';
}

// Default Content-Type for raw body sub-types. Used at send time only when the
// user hasn't set their own Content-Type header.
function defaultContentTypeFor(type) {
  if (type === 'json') return 'application/json';
  if (type === 'xml') return 'application/xml';
  if (type === 'html') return 'text/html';
  if (type === 'javascript') return 'application/javascript';
  return null;
}

// Backend's Body enum is adjacently-tagged; the `none` variant must NOT carry
// a `content` field, or serde rejects the payload. The backend doesn't know
// about html/javascript types — wire them as 'text'.
function normalizeBodyForWire(body) {
  if (!body || body.type === 'none') return { type: 'none' };
  if (body.type === 'json' || body.type === 'xml' || body.type === 'text') {
    return { type: body.type, content: typeof body.content === 'string' ? body.content : '' };
  }
  if (body.type === 'html' || body.type === 'javascript') {
    return { type: 'text', content: typeof body.content === 'string' ? body.content : '' };
  }
  if (body.type === 'urlencoded' || body.type === 'form') {
    return { type: body.type, content: Array.isArray(body.content) ? body.content : [] };
  }
  if (body.type === 'formdata') {
    const items = Array.isArray(body.content) ? body.content : [];
    const parts = items
      .filter((it) => it.enabled !== false && (it.key || '').length > 0)
      .map((it) => {
        if (it.kind === 'file') {
          return {
            kind: 'file',
            key: it.key || '',
            path: it.path || '',
            filename: it.filename || null,
            content_type: it.contentType || null,
            enabled: it.enabled !== false,
          };
        }
        return {
          kind: 'text',
          key: it.key || '',
          value: it.value || '',
          enabled: it.enabled !== false,
        };
      });
    return { type: 'formdata', content: parts };
  }
  if (body.type === 'binary') {
    const c = body.content || {};
    if (!c.path) return { type: 'none' };
    return { type: 'binary', content: { path: c.path, content_type: c.contentType || null } };
  }
  return { type: 'none' };
}

function requestForWire(req) {
  const wire = {
    method: req.method,
    url: req.url,
    headers: req.headers || [],
    query: req.query || [],
    body: normalizeBodyForWire(req.body),
  };
  // Persist renderer-side auth so saved requests round-trip through the
  // backend with their auth intact. Backend ignores this field at execute
  // time — auth is baked into headers/query at send time on the renderer.
  if (req.auth && req.auth.type && req.auth.type !== 'none') {
    wire.auth = req.auth;
  }
  // Persist test script — backend treats it as opaque text.
  if (typeof req.tests === 'string' && req.tests.trim().length > 0) {
    wire.tests = req.tests;
  }
  return wire;
}

let tabSeq = 0;
function newTab(req, opts) {
  // Normalize before snapshot so subsequent renders don't mutate the request
  // shape and falsely flip the tab dirty.
  const r = normalizeRequest(req || blankRequest());
  const tab = {
    id: opts?.id || 't' + (++tabSeq),
    request: r,
    lastResponse: null,
    pendingSince: null, // Date.now() while a request is in-flight on this tab
    abortController: null,
    // savedSnapshot: stringified normalized request at the last save point.
    // A blank new tab gets the empty-request snapshot so it's only "dirty"
    // once the user actually edits something.
    savedSnapshot: opts?.savedSnapshot ?? JSON.stringify(r),
    // Link to the saved-collection entry this tab was opened from, used when saving
    // back to the same place. null = tab was never saved.
    savedRef: opts?.savedRef ?? null, // { collectionId, requestId, name }
  };
  state.tabs.push(tab);
  persistTabs();
  return tab;
}

function isTabDirty(tab) {
  if (!tab) return false;
  return JSON.stringify(tab.request) !== tab.savedSnapshot;
}

function markTabSaved(tab, ref) {
  tab.savedSnapshot = JSON.stringify(tab.request);
  if (ref) tab.savedRef = ref;
  renderTabs();
  persistTabs();
}

function activateTab(id) {
  const t = state.tabs.find((x) => x.id === id);
  if (!t) return;
  // Request was already normalized at newTab time — don't mutate here, that
  // would shift the snapshot and falsely flip the tab dirty.
  state.activeTabId = id;
  state.current = t.request;
  state.lastResponse = t.lastResponse;
  hideWelcomeScreen();
  renderTabs();
  renderRequest();
  paintResponseFromTab(t);
  paintLoaderForActiveTab();
  persistTabs();
}

function tabTitle(t) {
  const u = t.request.url || '';
  if (!u) return 'New request';
  try {
    const parsed = new URL(/^[a-z]+:\/\//i.test(u) ? u : 'https://' + u);
    return (parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : parsed.host) || u;
  } catch {
    return u;
  }
}

function renderTabs() {
  const wrap = $('#request-tabs');
  wrap.innerHTML = '';
  for (const t of state.tabs) {
    const el = document.createElement('div');
    const dirty = isTabDirty(t);
    el.className = 'req-tab'
      + (t.id === state.activeTabId ? ' active' : '')
      + (dirty ? ' dirty' : '');
    const pendingMark = t.pendingSince ? '<span class="tab-spinner"></span>' : '';
    const dirtyMark = dirty ? '<span class="dirty-dot" title="Unsaved changes">●</span>' : '';
    el.innerHTML = `
      <span class="method-badge" data-method="${escapeAttr(t.request.method)}">${escapeHtml(t.request.method)}</span>
      <span class="label" title="${escapeAttr(tabTitle(t))}">${escapeHtml(tabTitle(t))}</span>
      ${dirtyMark}
      ${pendingMark}
      <button class="close" title="Close">×</button>
    `;
    el.onclick = (e) => {
      if (e.target.closest('.close')) return;
      activateTab(t.id);
    };
    el.querySelector('.close').onclick = (e) => {
      e.stopPropagation();
      closeTab(t.id);
    };
    wrap.appendChild(el);
  }
  const plus = document.createElement('button');
  plus.id = 'new-tab';
  plus.className = 'new-tab-inline';
  plus.title = 'New tab';
  plus.textContent = '+';
  plus.onclick = () => activateTab(newTab().id);
  wrap.appendChild(plus);
}

// Public close — gated by the unsaved-changes prompt when the tab is dirty.
function closeTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (isTabDirty(tab)) {
    askCloseDirty(tab).then((decision) => {
      if (decision === 'cancel') return;
      if (decision === 'save') {
        // Need to make sure this tab is active so the save dialog targets it,
        // then re-trigger the user's normal save flow. We'll close after save resolves.
        if (state.activeTabId !== id) activateTab(id);
        // pendingCloseAfterSave is read by the save-dialog confirm handler.
        state.pendingCloseAfterSave = id;
        openSaveDialog();
        return;
      }
      // 'discard' — just drop it
      forceCloseTab(id);
    });
    return;
  }
  forceCloseTab(id);
}

function forceCloseTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (state.tabs.length === 0) {
    state.activeTabId = null;
    state.current = null;
    state.lastResponse = null;
    showWelcomeScreen();
    persistTabs();
    return;
  }
  if (state.activeTabId === id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    activateTab(next.id);
  } else {
    renderTabs();
    persistTabs();
  }
}

// Returns one of 'save' | 'discard' | 'cancel'.
function askCloseDirty(tab) {
  return new Promise((resolve) => {
    const dlg = $('#confirm-close-dialog');
    const title = tabTitle(tab);
    $('#confirm-close-msg').textContent = `"${title}" has unsaved changes. Save before closing?`;
    const cleanup = () => {
      $('#confirm-close-save').onclick = null;
      $('#confirm-close-discard').onclick = null;
      $('#confirm-close-cancel').onclick = null;
      dlg.close();
    };
    $('#confirm-close-save').onclick = (e) => { e.preventDefault(); cleanup(); resolve('save'); };
    $('#confirm-close-discard').onclick = (e) => { e.preventDefault(); cleanup(); resolve('discard'); };
    $('#confirm-close-cancel').onclick = (e) => { e.preventDefault(); cleanup(); resolve('cancel'); };
    dlg.showModal();
  });
}

function showWelcomeScreen() {
  const w = document.getElementById('welcome-screen');
  if (w) w.classList.remove('hidden');
  renderTabs(); // re-render tab strip so the + button still shows
}

function hideWelcomeScreen() {
  const w = document.getElementById('welcome-screen');
  if (w) w.classList.add('hidden');
}

function wireWelcomeScreen() {
  const newBtn = document.getElementById('welcome-new');
  const importBtn = document.getElementById('welcome-import');
  const shortcutsBtn = document.getElementById('welcome-shortcuts');
  if (newBtn) newBtn.onclick = () => activateTab(newTab().id);
  if (importBtn) importBtn.onclick = () => onImportPostman();
  if (shortcutsBtn) shortcutsBtn.onclick = () => showShortcutsHelp();
}

// ----- Boot -----
(async function boot() {
  await init();
  mountEditors();
  await refreshWorkspace();
  wireUi();
  wireKeyboardShortcuts();
  wireContextMenus();
  wireWelcomeScreen();
  // Restore previously-open tabs if any; otherwise show the welcome screen.
  if (!restoreTabs()) showWelcomeScreen();
})();

// Returns true if tabs were restored, false if there's nothing to restore.
function restoreTabs() {
  const persisted = loadPersistedTabs();
  if (!persisted || persisted.tabs.length === 0) return false;

  // Bump tabSeq past any restored ids so future newTab() never collides.
  let maxSeq = 0;
  for (const t of persisted.tabs) {
    const m = /^t(\d+)$/.exec(t.id || '');
    if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
  }
  tabSeq = maxSeq;

  for (const saved of persisted.tabs) {
    const tab = newTab(saved.request, {
      id: saved.id,
      savedSnapshot: saved.savedSnapshot,
      savedRef: saved.savedRef,
    });
    if (saved.lastResponse) tab.lastResponse = saved.lastResponse;
    if (saved.lastTestResults) tab.lastTestResults = saved.lastTestResults;
  }
  // Restore the previously-active tab if it still exists, else fall back to
  // the first one.
  const activeId = state.tabs.find((t) => t.id === persisted.activeTabId)
    ? persisted.activeTabId
    : state.tabs[0]?.id;
  if (activeId) activateTab(activeId);
  return true;
}

function mountEditors() {
  bodyEditor = createEditor({
    parent: document.getElementById('body-editor'),
    doc: '',
    language: 'none',
    onChange: (text) => {
      if (bodyEditorSetting) return;
      if (state.current && state.current.body) state.current.body.content = text;
    },
  });
  responseEditor = createEditor({
    parent: document.getElementById('response-body'),
    doc: '',
    language: 'none',
    readOnly: true,
  });
  testsEditor = createEditor({
    parent: document.getElementById('tests-editor'),
    doc: '',
    language: effectiveRequestLang('javascript'),
    onChange: (text) => {
      if (testsEditorSetting) return;
      if (state.current) state.current.tests = text;
    },
  });
}

async function refreshWorkspace() {
  state.workspace = await api.workspace();
  renderEnvSelect();
  renderCollections();
  renderHistory();
  updateProxyIndicator();
}

// ----- Render: sidebar -----
function renderCollections() {
  const ul = $('#collections-list');
  ul.innerHTML = '';
  for (const c of state.workspace.collections) {
    const li = document.createElement('li');
    li.className = 'collection';
    li.textContent = c.name;
    li.title = 'Right-click for rename / delete';
    li.dataset.collectionId = c.id;
    ul.appendChild(li);

    for (const r of c.requests) {
      const child = document.createElement('li');
      child.className = 'req';
      child.innerHTML = `<span class="method-badge" data-method="${escapeAttr(r.request.method)}">${escapeHtml(r.request.method)}</span><span>${escapeHtml(r.name)}</span>`;
      child.onclick = () => openRequest(r.request, r.name, { collectionId: c.id, requestId: r.id, name: r.name });
      child.dataset.collectionId = c.id;
      child.dataset.requestId = r.id;
      ul.appendChild(child);
    }
  }
}

async function renameCollection(c) {
  const name = await askText({
    title: 'Rename collection',
    label: 'New name',
    value: c.name,
  });
  if (!name || name === c.name) return;
  try {
    await api.updateCollection(c.id, { ...c, name });
    await refreshWorkspace();
  } catch (e) {
    alert('Rename failed: ' + e.message);
  }
}

async function renameSavedRequest(collectionId, r) {
  const name = await askText({
    title: 'Rename request',
    label: 'New name',
    value: r.name,
  });
  if (!name || name === r.name) return;
  try {
    await api.updateRequest(collectionId, r.id, { ...r, name });
    await refreshWorkspace();
  } catch (e) {
    alert('Rename failed: ' + e.message);
  }
}

async function confirmDeleteCollection(c) {
  if (!confirm(`Delete collection "${c.name}" and all its requests?`)) return;
  await api.deleteCollection(c.id);
  await refreshWorkspace();
}

async function confirmDeleteRequest(collectionId, r) {
  if (!confirm(`Delete request "${r.name}"?`)) return;
  await api.deleteRequest(collectionId, r.id);
  await refreshWorkspace();
}

function renderHistory() {
  const ul = $('#history-list');
  ul.innerHTML = '';
  const limit = Math.max(1, settings.historyCount || 20);
  for (const h of state.workspace.history.slice(0, limit)) {
    const li = document.createElement('li');
    li.className = 'req';
    const stat = h.response_status ? `<span class="method-badge">${h.response_status}</span>` : '<span class="method-badge">ERR</span>';
    li.innerHTML = `${stat}<span class="method-badge" data-method="${escapeAttr(h.request.method)}">${escapeHtml(h.request.method)}</span><span>${escapeHtml(truncate(h.request.url, 60))}</span>`;
    li.onclick = () => openRequest(h.request);
    ul.appendChild(li);
  }
}

function renderEnvSelect() {
  const sel = $('#env-select');
  sel.innerHTML = '<option value="">No environment</option>';
  for (const e of state.workspace.environments) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.name;
    if (e.id === state.workspace.active_environment_id) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ----- Render: request panel -----
function renderRequest() {
  $('#method').value = state.current.method;
  $('#url').value = state.current.url;
  renderKv('params-body', state.current.query);
  renderKv('headers-body', state.current.headers);
  renderAuth();
  renderBody();
  renderTestsEditor();
  // Keep any open bulk-edit textareas in sync with the active request's data
  if (bulkMode.params) syncBulkTextarea('params');
  if (bulkMode.headers) syncBulkTextarea('headers');
}

function renderTestsEditor() {
  if (!testsEditor) return;
  testsEditorSetting = true;
  testsEditor.setValue(typeof state.current?.tests === 'string' ? state.current.tests : '');
  testsEditorSetting = false;
}

function renderKv(tbodyId, items, opts = {}) {
  const tb = document.getElementById(tbodyId);
  tb.innerHTML = '';
  // Auto-enable header autocomplete when rendering the headers table
  const rowOpts = { ...opts };
  if (tbodyId === 'headers-body') rowOpts.keyDatalist = 'header-suggestions';
  items.forEach((kv, idx) => tb.appendChild(kvRow(items, kv, idx, rowOpts)));
}

// ----- Bulk edit (raw key:value text mode) -----
// targets: 'params' | 'headers' | 'body'
const bulkMode = { params: false, headers: false, body: false };

function getBulkItems(target) {
  if (target === 'params') return state.current.query;
  if (target === 'headers') return state.current.headers;
  if (target === 'body') {
    const b = state.current.body;
    if (!b || (b.type !== 'urlencoded' && b.type !== 'form')) return null;
    if (!Array.isArray(b.content)) b.content = [];
    return b.content;
  }
  return null;
}

function setBulkItems(target, items) {
  if (target === 'params') state.current.query = items;
  else if (target === 'headers') state.current.headers = items;
  else if (target === 'body') {
    if (!state.current.body) return;
    state.current.body.content = items;
  }
}

function serializeKv(items) {
  return (items || [])
    .map((it) => {
      const k = it.key || '';
      const v = it.value || '';
      const line = `${k}:${v}`;
      return it.enabled === false ? `# ${line}` : line;
    })
    .join('\n');
}

function parseKv(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    let enabled = true;
    let body = line;
    if (line.startsWith('#')) {
      enabled = false;
      body = line.replace(/^#\s?/, '');
    }
    const i = body.indexOf(':');
    const key = (i === -1 ? body : body.slice(0, i)).trim();
    const value = i === -1 ? '' : body.slice(i + 1).trim();
    if (!key && !value) continue;
    out.push({ key, value, description: '', enabled });
  }
  return out;
}

function syncBulkTextarea(target) {
  const ta = document.querySelector(`textarea[data-bulk-text="${target}"]`);
  if (!ta) return;
  const items = getBulkItems(target);
  ta.value = items ? serializeKv(items) : '';
}

function commitBulkTextarea(target) {
  const ta = document.querySelector(`textarea[data-bulk-text="${target}"]`);
  if (!ta) return;
  const items = parseKv(ta.value);
  setBulkItems(target, items);
}

function setBulkMode(target, on) {
  bulkMode[target] = !!on;
  const ta = document.querySelector(`textarea[data-bulk-text="${target}"]`);
  const tableView = document.querySelector(`[data-view="${target}-table"]`);
  const btn = document.querySelector(`.bulk-edit-toggle[data-bulk="${target}"]`);
  if (!ta || !tableView) return;

  if (on) {
    syncBulkTextarea(target);
    ta.classList.remove('hidden');
    tableView.classList.add('hidden');
    if (btn) { btn.classList.add('active'); btn.textContent = 'Key-Value Edit'; }
  } else {
    commitBulkTextarea(target);
    ta.classList.add('hidden');
    tableView.classList.remove('hidden');
    if (btn) { btn.classList.remove('active'); btn.textContent = 'Bulk Edit'; }
    // Re-render the corresponding table from the new items
    if (target === 'params') renderKv('params-body', state.current.query);
    else if (target === 'headers') renderKv('headers-body', state.current.headers);
    else if (target === 'body') renderBody();
  }
}

function wireBulkEdit() {
  document.querySelectorAll('.bulk-edit-toggle').forEach((btn) => {
    const target = btn.dataset.bulk;
    btn.addEventListener('click', () => setBulkMode(target, !bulkMode[target]));
  });
  // Live update items on textarea input so Send picks them up immediately
  document.querySelectorAll('textarea[data-bulk-text]').forEach((ta) => {
    const target = ta.dataset.bulkText;
    ta.addEventListener('input', () => {
      if (bulkMode[target]) {
        const items = parseKv(ta.value);
        setBulkItems(target, items);
      }
    });
  });
}

function kvRow(items, kv, idx, opts = {}) {
  const tr = document.createElement('tr');
  const listAttr = opts.keyDatalist ? ` list="${opts.keyDatalist}"` : '';
  tr.innerHTML = `
    <td><input type="checkbox" ${kv.enabled !== false ? 'checked' : ''}></td>
    <td><input type="text" value="${escapeAttr(kv.key)}" placeholder="Key"${listAttr}></td>
    <td><input type="text" value="${escapeAttr(kv.value)}" placeholder="Value"></td>
    <td><input type="text" value="${escapeAttr(kv.description || '')}" placeholder="Description"></td>
    <td><button class="ghost">×</button></td>
  `;
  const [chk, k, v, d, del] = tr.querySelectorAll('input, button');
  chk.onchange = () => { kv.enabled = chk.checked; };
  k.oninput = () => { kv.key = k.value; };
  v.oninput = () => { kv.value = v.value; };
  d.oninput = () => { kv.description = d.value; };
  del.onclick = () => { items.splice(idx, 1); renderRequest(); };
  return tr;
}

function renderBody() {
  const b = state.current.body || { type: 'none', content: '' };
  $('#body-type').value = b.type;
  const editorHost = $('#body-editor');
  const tbl = $('#body-kv-table');
  const addBtn = $('#body-kv-add');
  const kvToolbar = document.getElementById('body-kv-toolbar');
  const fdTable = document.getElementById('formdata-table');
  const fdAdd = document.getElementById('formdata-add');
  const binBox = document.getElementById('binary-body');

  // Default: hide everything, then re-enable per body type below.
  editorHost.classList.add('hidden');
  tbl.classList.add('hidden');
  addBtn.classList.add('hidden');
  if (kvToolbar) kvToolbar.classList.add('hidden');
  if (fdTable) fdTable.classList.add('hidden');
  if (fdAdd) fdAdd.classList.add('hidden');
  if (binBox) binBox.classList.add('hidden');

  if (b.type === 'urlencoded' || b.type === 'form') {
    tbl.classList.remove('hidden');
    addBtn.classList.remove('hidden');
    if (kvToolbar) kvToolbar.classList.remove('hidden');
    if (!Array.isArray(b.content)) b.content = [];
    renderKv('body-kv-body', b.content);
  } else if (b.type === 'formdata') {
    if (fdTable) fdTable.classList.remove('hidden');
    if (fdAdd) fdAdd.classList.remove('hidden');
    if (!Array.isArray(b.content)) b.content = [];
    renderFormData(b.content);
  } else if (b.type === 'binary') {
    if (binBox) binBox.classList.remove('hidden');
    renderBinaryBody(b);
  } else if (b.type === 'none') {
    // everything stays hidden
  } else {
    // json / xml / html / javascript / text — code editor
    editorHost.classList.remove('hidden');
    if (bodyEditor) {
      bodyEditorSetting = true;
      bodyEditor.setLanguage(effectiveRequestLang(bodyEditorLanguageFor(b.type)));
      bodyEditor.setValue(typeof b.content === 'string' ? b.content : '');
      bodyEditorSetting = false;
    }
  }
  // If this tab is currently in bulk-edit mode, keep textarea synced
  if (bulkMode.body && (b.type === 'urlencoded' || b.type === 'form')) {
    syncBulkTextarea('body');
  }
}

// ----- form-data rendering -----
function renderFormData(items) {
  const tb = document.getElementById('formdata-body');
  if (!tb) return;
  tb.innerHTML = '';
  items.forEach((it, idx) => tb.appendChild(formDataRow(items, it, idx)));
}

function formDataRow(items, it, idx) {
  // Each row stores: { kind: 'text'|'file', key, value (for text) | path/filename/contentType (for file), description, enabled }
  const tr = document.createElement('tr');
  const isFile = it.kind === 'file';
  tr.innerHTML = `
    <td><input type="checkbox" ${it.enabled !== false ? 'checked' : ''}></td>
    <td><input type="text" value="${escapeAttr(it.key || '')}" placeholder="Key"></td>
    <td>
      <select class="fd-type-select">
        <option value="text" ${!isFile ? 'selected' : ''}>Text</option>
        <option value="file" ${isFile ? 'selected' : ''}>File</option>
      </select>
    </td>
    <td class="fd-value-cell"></td>
    <td><input type="text" value="${escapeAttr(it.description || '')}" placeholder="Description"></td>
    <td><button class="ghost row-del">×</button></td>
  `;
  const chk = tr.querySelector('input[type="checkbox"]');
  const keyEl = tr.querySelectorAll('input[type="text"]')[0];
  const descEl = tr.querySelectorAll('input[type="text"]')[1];
  const typeSel = tr.querySelector('.fd-type-select');
  const valueCell = tr.querySelector('.fd-value-cell');
  const del = tr.querySelector('.row-del');

  const renderValueCell = () => {
    valueCell.innerHTML = '';
    if (it.kind === 'file') {
      const wrap = document.createElement('div');
      wrap.className = 'fd-file-cell';
      const info = document.createElement('span');
      info.className = 'fd-file-info';
      info.textContent = it.filename || it.path || 'No file selected';
      info.title = it.path || '';
      const pickBtn = document.createElement('button');
      pickBtn.className = 'ghost';
      pickBtn.textContent = it.path ? 'Change…' : 'Choose…';
      pickBtn.onclick = async (e) => {
        e.preventDefault();
        const picked = await window.postie.pickFilePath();
        if (!picked) return;
        it.path = picked.path;
        it.filename = picked.name;
        info.textContent = picked.name;
        info.title = picked.path;
        pickBtn.textContent = 'Change…';
      };
      wrap.appendChild(info);
      wrap.appendChild(pickBtn);
      valueCell.appendChild(wrap);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Value';
      inp.value = it.value || '';
      inp.oninput = () => { it.value = inp.value; };
      valueCell.appendChild(inp);
    }
  };
  renderValueCell();

  chk.onchange = () => { it.enabled = chk.checked; };
  keyEl.oninput = () => { it.key = keyEl.value; };
  descEl.oninput = () => { it.description = descEl.value; };
  typeSel.onchange = () => {
    it.kind = typeSel.value;
    if (it.kind === 'file') {
      delete it.value;
      it.path = it.path || '';
      it.filename = it.filename || '';
    } else {
      delete it.path; delete it.filename; delete it.contentType;
      it.value = it.value || '';
    }
    renderValueCell();
  };
  del.onclick = () => { items.splice(idx, 1); renderRequest(); };
  return tr;
}

// ----- binary body rendering -----
function renderBinaryBody(b) {
  const info = document.getElementById('binary-info');
  const clearBtn = document.getElementById('binary-clear');
  const pickBtn = document.getElementById('binary-pick');
  if (!info || !pickBtn) return;
  // b.content is { path, filename, contentType } or empty
  const c = (b.content && typeof b.content === 'object') ? b.content : {};
  if (c.path) {
    info.textContent = `${c.filename || c.path}${c.contentType ? ' · ' + c.contentType : ''}`;
    info.title = c.path;
    pickBtn.textContent = 'Change file…';
    if (clearBtn) clearBtn.classList.remove('hidden');
  } else {
    info.textContent = 'No file selected.';
    info.title = '';
    pickBtn.textContent = 'Choose file…';
    if (clearBtn) clearBtn.classList.add('hidden');
  }
}

function wireBinaryBody() {
  const pickBtn = document.getElementById('binary-pick');
  const clearBtn = document.getElementById('binary-clear');
  if (pickBtn) {
    pickBtn.onclick = async () => {
      const picked = await window.postie.pickFilePath();
      if (!picked) return;
      state.current.body = {
        type: 'binary',
        content: { path: picked.path, filename: picked.name, contentType: '' },
      };
      renderBody();
    };
  }
  if (clearBtn) {
    clearBtn.onclick = () => {
      state.current.body = { type: 'binary', content: {} };
      renderBody();
    };
  }
}

function wireFormData() {
  const addBtn = document.getElementById('formdata-add');
  if (addBtn) {
    addBtn.onclick = () => {
      if (!state.current.body || state.current.body.type !== 'formdata') return;
      if (!Array.isArray(state.current.body.content)) state.current.body.content = [];
      state.current.body.content.push({ kind: 'text', key: '', value: '', description: '', enabled: true });
      renderBody();
    };
  }
}

// ----- Render: auth tab -----
function renderAuth() {
  const a = state.current.auth || { type: 'none' };
  const sel = $('#auth-type');
  if (!sel) return;
  sel.value = a.type;

  const showSet = new Set();
  if (a.type !== 'none') showSet.add(a.type);
  ['basic', 'bearer', 'apikey'].forEach((t) => {
    const el = document.getElementById('auth-fields-' + t);
    if (el) el.classList.toggle('hidden', !showSet.has(t));
  });

  if (a.type === 'basic') {
    $('#auth-basic-user').value = a.username || '';
    $('#auth-basic-pass').value = a.password || '';
  } else if (a.type === 'bearer') {
    $('#auth-bearer-token').value = a.token || '';
  } else if (a.type === 'apikey') {
    $('#auth-apikey-key').value = a.key || '';
    $('#auth-apikey-value').value = a.value || '';
    $('#auth-apikey-in').value = a.in || 'header';
  }

  const hint = $('#auth-hint');
  if (hint) {
    if (a.type === 'none') hint.textContent = 'No authentication will be applied to the request.';
    else if (a.type === 'basic') hint.textContent = 'Sent as: Authorization: Basic <base64(user:pass)>';
    else if (a.type === 'bearer') hint.textContent = 'Sent as: Authorization: Bearer <token>';
    else if (a.type === 'apikey') hint.textContent = 'Adds a key/value to the chosen location at send time.';
  }
}

function wireAuthTab() {
  $('#auth-type').onchange = (e) => {
    const type = e.target.value;
    // Preserve existing values for the new type if any, else start fresh
    const prev = state.current.auth || { type: 'none' };
    const next = { type };
    if (type === 'basic') {
      next.username = prev.username || '';
      next.password = prev.password || '';
    } else if (type === 'bearer') {
      next.token = prev.token || '';
    } else if (type === 'apikey') {
      next.key = prev.key || '';
      next.value = prev.value || '';
      next.in = prev.in || 'header';
    }
    state.current.auth = next;
    renderAuth();
  };
  $('#auth-basic-user').oninput = (e) => { ensureAuth('basic').username = e.target.value; };
  $('#auth-basic-pass').oninput = (e) => { ensureAuth('basic').password = e.target.value; };
  $('#auth-bearer-token').oninput = (e) => { ensureAuth('bearer').token = e.target.value; };
  $('#auth-apikey-key').oninput = (e) => { ensureAuth('apikey').key = e.target.value; };
  $('#auth-apikey-value').oninput = (e) => { ensureAuth('apikey').value = e.target.value; };
  $('#auth-apikey-in').onchange = (e) => { ensureAuth('apikey').in = e.target.value; };
}

function ensureAuth(type) {
  if (!state.current.auth || state.current.auth.type !== type) {
    state.current.auth = { type };
  }
  return state.current.auth;
}

// ----- Render: response panel -----
// Painting more than this many chars into the response editor risks blowing
// Blink's Oilpan heap. We keep the full string in memory and only hand the DOM
// the cap; the rest is reachable via Show-full / Save-to-file. The cap is
// driven by the user's "Render limit (MB)" setting.
function renderCap() {
  return Math.max(1, Math.round((settings.renderLimitMb || 0.5) * 1024 * 1024));
}
function highlightLimit() {
  return renderCap(); // highlight up to whatever fits in the painted region
}

function paintResponseFromTab(tab) {
  if (!tab.lastResponse) {
    $('#status-pill').textContent = '—';
    $('#status-pill').className = 'pill';
    $('#time-pill').textContent = '—';
    $('#size-pill').textContent = '—';
    if (responseEditor) {
      responseEditor.setLanguage('none');
      responseEditor.setValue('');
      responseLanguage = 'none';
    }
    $('#response-headers').textContent = '';
    $('#response-truncation').classList.add('hidden');
    renderTestResults(null);
    updateTestResultsTabBadge(null);
    return;
  }
  renderResponse(tab.lastResponse);
  renderTestResults(tab.lastTestResults || null);
  updateTestResultsTabBadge(tab.lastTestResults || null);
}

function renderResponse(resp) {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (tab) tab.lastResponse = resp;
  state.lastResponse = resp;

  const trunc = $('#response-truncation');

  if (resp.error) {
    $('#status-pill').textContent = 'ERROR';
    $('#status-pill').className = 'pill s5xx';
    $('#time-pill').textContent = '—';
    $('#size-pill').textContent = '—';
    if (responseEditor) {
      responseEditor.setLanguage('none');
      responseEditor.setValue(resp.error);
      responseLanguage = 'none';
    }
    $('#response-headers').textContent = '';
    trunc.classList.add('hidden');
    return;
  }
  const cls = resp.status >= 500 ? 's5xx' : resp.status >= 400 ? 's4xx' : resp.status >= 300 ? 's3xx' : 's2xx';
  $('#status-pill').className = 'pill ' + cls;
  $('#status-pill').textContent = `${resp.status} ${resp.status_text}`;
  $('#time-pill').textContent = `${resp.elapsed_ms} ms`;
  $('#size-pill').textContent = formatSize(resp.size_bytes);

  // body_evicted: response was too big to persist across reload. Status,
  // headers, and timing are still here; only the body text was dropped.
  if (resp.body_evicted) {
    if (responseEditor) {
      responseEditor.setLanguage('none');
      responseEditor.setValue(
        '[Response body was too large to restore after reload — ' +
        formatSize(resp.body_size_at_persist || resp.size_bytes || 0) +
        '. Re-send the request to fetch it again.]'
      );
      responseLanguage = 'none';
    }
    $('#response-headers').textContent = Object.entries(resp.headers || {})
      .map(([k, v]) => `${k}: ${v}`).join('\n');
    $('#response-truncation').classList.add('hidden');
    return;
  }

  const body = resp.body_is_base64 ? '[binary response — ' + formatSize(resp.size_bytes) + ']' : resp.body;
  const formatted = autoFormat(resp.headers, body);
  responseLanguage = detectFormat(resp.headers, body);
  paintBody(formatted, false);

  $('#response-headers').textContent = Object.entries(resp.headers)
    .map(([k, v]) => `${k}: ${v}`).join('\n');
}

function paintBody(text, showFull) {
  if (!responseEditor) return;
  const trunc = $('#response-truncation');
  const total = text.length;
  const cap = renderCap();
  const painted = (showFull || total <= cap) ? text : text.slice(0, cap);
  const lang = painted.length > highlightLimit() ? 'none' : responseLanguage;
  responseEditor.setLanguage(effectiveResponseLang(lang));
  responseEditor.setValue(painted);
  if (showFull || total <= cap) {
    trunc.classList.toggle('hidden', total <= cap);
    if (total > cap) {
      $('#truncation-info').textContent =
        `Showing full ${formatSize(total)} — highlighting disabled, large bodies may be slow.`;
      $('#show-full').classList.add('hidden');
    }
    return;
  }
  trunc.classList.remove('hidden');
  $('#show-full').classList.remove('hidden');
  $('#truncation-info').textContent =
    `Showing first ${formatSize(cap)} of ${formatSize(total)} — Show full may be slow.`;
}

function getFullResponseText() {
  const r = state.lastResponse;
  if (!r || r.error) return '';
  const body = r.body_is_base64 ? '[binary response — ' + formatSize(r.size_bytes) + ']' : r.body;
  return autoFormat(r.headers, body);
}

let timerInterval = null;
function paintLoaderForActiveTab() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  const pending = !!(tab && tab.pendingSince);
  $('#response-loader').classList.toggle('hidden', !pending);
  $('#send').disabled = pending;
  if (pending) {
    updateTimer();
    if (!timerInterval) timerInterval = setInterval(updateTimer, 50);
  } else if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimer() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab || !tab.pendingSince) return;
  const ms = Date.now() - tab.pendingSince;
  $('#response-timer').textContent =
    ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

// ----- Wire UI -----
function wireUi() {
  $$('.tabs').forEach((row) => {
    row.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      [...row.children].forEach((b) => b.classList.toggle('active', b === btn));
      const isSide = btn.dataset.side;
      const isResp = btn.dataset.rtab;
      const key = btn.dataset.tab || isSide || isResp;
      const prefix = isSide ? 'side-' : isResp ? 'rtab-' : 'tab-';
      const scope = isSide ? '.side-pane' : isResp ? '.response-panel .pane' : '.request-panel > .pane';
      document.querySelectorAll(scope).forEach((p) => p.classList.remove('active'));
      const target = document.getElementById(prefix + key);
      if (target) target.classList.add('active');
    });
  });

  $('#method').addEventListener('change', (e) => {
    state.current.method = e.target.value;
    renderTabs();
  });

  $('#url').addEventListener('input', (e) => {
    state.current.url = e.target.value;
    renderTabs();
  });
  $('#url').addEventListener('paste', (e) => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (text && isCurl(text)) {
      e.preventDefault();
      try {
        const commands = splitCurlCommands(text);
        const parsed = [];
        const errors = [];
        for (const cmd of commands) {
          try {
            parsed.push(parseCurl(cmd));
          } catch (cmdErr) {
            errors.push(cmdErr.message);
          }
        }
        if (parsed.length === 0) {
          throw new Error(errors[0] || 'No valid curl commands found');
        }

        // Replace current tab with first command
        const tab = state.tabs.find((t) => t.id === state.activeTabId);
        if (tab) {
          tab.request = parsed[0];
          state.current = tab.request;
        }
        // Open additional commands in new tabs
        let lastTabId = state.activeTabId;
        for (let i = 1; i < parsed.length; i++) {
          lastTabId = newTab(parsed[i]).id;
        }
        renderTabs();
        renderRequest();

        if (parsed.length > 1) {
          const skipped = errors.length ? ` (${errors.length} skipped)` : '';
          alert(`Imported ${parsed.length} curl commands${skipped}.`);
        }
      } catch (err) {
        alert('Could not parse curl: ' + err.message);
      }
    }
  });

  $$('[data-add]').forEach((btn) => {
    btn.onclick = () => {
      const which = btn.dataset.add;
      const arr = which === 'params' ? state.current.query : state.current.headers;
      arr.push({ key: '', value: '', description: '', enabled: true });
      renderRequest();
    };
  });
  $('#body-kv-add').onclick = () => {
    if (!Array.isArray(state.current.body.content)) state.current.body.content = [];
    state.current.body.content.push({ key: '', value: '', description: '', enabled: true });
    renderBody();
  };

  $('#body-type').onchange = (e) => {
    const t = e.target.value;
    if (t === 'urlencoded' || t === 'form' || t === 'formdata') {
      state.current.body = { type: t, content: [] };
    } else if (t === 'binary') {
      state.current.body = { type: 'binary', content: {} };
    } else if (t === 'none') {
      state.current.body = { type: 'none', content: '' };
    } else {
      const prev = state.current.body;
      const content = typeof prev.content === 'string' ? prev.content : '';
      state.current.body = { type: t, content };
    }
    renderBody();
  };
  $('#format-body').onclick = () => {
    const b = state.current.body;
    if (!bodyEditor) return;
    const current = bodyEditor.getValue();
    let next = current;
    if (b.type === 'json') next = formatJson(current);
    else if (b.type === 'xml') next = formatXml(current);
    b.content = next;
    bodyEditorSetting = true;
    bodyEditor.setValue(next);
    bodyEditorSetting = false;
  };

  $('#format-response').onclick = () => {
    if (!state.lastResponse || state.lastResponse.error) return;
    const r = state.lastResponse;
    const kind = detectFormat(r.headers, r.body);
    const txt = kind === 'json' ? formatJson(r.body) : kind === 'xml' ? formatXml(r.body) : r.body;
    responseLanguage = kind;
    paintBody(txt, false);
  };

  $('#copy-response').onclick = async () => {
    const activeTab = document.querySelector('.response-panel .pane.active')?.id;
    const text = activeTab === 'rtab-headers'
      ? $('#response-headers').textContent || ''
      : getFullResponseText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashButton($('#copy-response'), 'Copied!');
    } catch {
      showText('Copy response', text);
    }
  };

  $('#show-full').onclick = () => {
    const text = getFullResponseText();
    if (!text) return;
    paintBody(text, true);
  };

  $('#save-response').onclick = async () => {
    const text = getFullResponseText();
    if (!text) return;
    const r = state.lastResponse;
    const ct = (r.headers['content-type'] || r.headers['Content-Type'] || '').toLowerCase();
    const ext = ct.includes('json') ? 'json' : ct.includes('xml') || ct.includes('html') ? 'xml' : 'txt';
    try {
      const saved = await window.postie.saveFile({
        defaultName: `response.${ext}`,
        content: text,
      });
      if (saved) flashButton($('#save-response'), 'Saved');
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  };

  $('#send').onclick = sendRequest;
  $('#cancel-request').onclick = () => {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab && tab.abortController) tab.abortController.abort();
  };

  $('#env-select').onchange = async (e) => {
    const id = e.target.value || null;
    state.workspace.active_environment_id = id;
    await api.setActiveEnvironment(id);
  };

  $('#settings-btn').onclick = openSettingsDialog;
  $('#manage-environments').onclick = openEnvDialog;
  $('#sidebar-toggle').onclick = toggleSidebar;
  $('#layout-toggle').onclick = toggleLayout;
  wireProxyDialog();
  wireSettingsDialog();
  wireSplitHandle();
  applySidebarState();
  applyLayoutState();
  $('#new-collection').onclick = async () => {
    const name = await askText({
      title: 'New collection',
      label: 'Collection name',
      placeholder: 'My Collection',
    });
    if (!name) return;
    await api.createCollection({ id: '', name, requests: [] });
    refreshWorkspace();
  };
  $('#clear-history').onclick = async () => {
    await api.clearHistory();
    refreshWorkspace();
  };

  // Toolbar Save button: behaves like Cmd+S — overwrite if known, else picker.
  // Shift-click forces Save As.
  $('#save').onclick = (e) => {
    if (e.shiftKey) saveAsActiveTab();
    else saveActiveTab();
  };
  $('#copy-curl').onclick = onCopyCurl;

  const snippetBtn = $('#tests-snippet');
  if (snippetBtn) {
    snippetBtn.onclick = () => {
      const example =
`pm.test("Status is 2xx", function () {
  pm.expect(pm.response.code).to.be.below(300);
});

pm.test("Response is JSON", function () {
  const ct = pm.response.headers.get("content-type") || "";
  pm.expect(ct).to.include("application/json");
});

// Extract a value for the next request — picked up by {{authToken}} substitution.
const data = pm.response.json();
if (data && data.token) {
  pm.environment.set("authToken", data.token);
}`;
      if (state.current) state.current.tests = example;
      if (testsEditor) {
        testsEditorSetting = true;
        testsEditor.setValue(example);
        testsEditorSetting = false;
      }
      renderTabs(); // marks tab dirty
    };
  }
  wireSaveDialog();
  wireEnvDialog();
  wireAuthTab();
  wireBulkEdit();
  wireFormData();
  wireBinaryBody();

  // Live dirty-state watcher: any edit inside the request workbench may have
  // mutated state.current, so refresh the tab strip to update the dirty dot.
  // Debounced so rapid typing doesn't thrash the DOM. Also persists tabs so
  // edits survive a reload.
  let dirtyRedrawTimer = null;
  const scheduleTabRedraw = () => {
    if (dirtyRedrawTimer) return;
    dirtyRedrawTimer = setTimeout(() => {
      dirtyRedrawTimer = null;
      renderTabs();
      persistTabs();
    }, 120);
  };
  const workbench = document.querySelector('.workbench');
  if (workbench) {
    workbench.addEventListener('input', scheduleTabRedraw, true);
    workbench.addEventListener('change', scheduleTabRedraw, true);
  }
}

async function sendRequest() {
  const env = state.workspace.environments.find(
    (e) => e.id === state.workspace.active_environment_id
  );
  const merged = applyEnvToRequest(state.current, env);
  const wireBase = requestForWire(merged);
  const withCt = applyDefaultContentType(wireBase, state.current.body);
  const payload = applyAuthToWire(withCt, state.current.auth);

  const startedTab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!startedTab) return;
  startedTab.pendingSince = Date.now();
  startedTab.abortController = new AbortController();
  renderTabs();
  paintLoaderForActiveTab();

  try {
    const resp = await api.execute(payload, startedTab.abortController.signal);
    startedTab.lastResponse = resp;
    if (state.activeTabId === startedTab.id) renderResponse(resp);
    // Run user tests against the response, in the context of the active env (if any).
    await runAndApplyTests(startedTab, resp, env);
    refreshWorkspace();
  } catch (e) {
    const isAbort = e.name === 'AbortError';
    const msg = isAbort ? 'Request cancelled.' : describeRequestError(e, payload);
    startedTab.lastResponse = { error: msg };
    if (state.activeTabId === startedTab.id) renderResponse({ error: msg });
  } finally {
    startedTab.pendingSince = null;
    startedTab.abortController = null;
    renderTabs();
    paintLoaderForActiveTab();
    // Persist so the response survives a reload (debounced — runAndApplyTests
    // may have just scheduled a write too; the timer coalesces).
    persistTabs();
  }
}

// Runs the user's post-response test script for `tab` against `resp`, persists
// any pm.environment.set() / .unset() writes to the active environment, and
// paints the test-results pane.
async function runAndApplyTests(tab, resp, env) {
  const script = tab.request?.tests || '';
  if (!script.trim()) {
    tab.lastTestResults = null;
    if (state.activeTabId === tab.id) renderTestResults(null);
    updateTestResultsTabBadge(null);
    return;
  }
  const result = runTests(script, resp, { environment: env });

  // Persist env writes — flush all of them in one update to avoid races.
  if (result.envWrites.length && env) {
    const next = { ...env, variables: [...(env.variables || [])] };
    for (const w of result.envWrites) {
      const idx = next.variables.findIndex((v) => v.key === w.key);
      if (w.op === 'set') {
        if (idx >= 0) next.variables[idx] = { ...next.variables[idx], value: w.value, enabled: true };
        else next.variables.push({ key: w.key, value: w.value, description: '', enabled: true });
      } else if (w.op === 'unset' && idx >= 0) {
        next.variables.splice(idx, 1);
      }
    }
    try {
      await api.updateEnvironment(env.id, next);
      // Refresh in-memory workspace so subsequent sends see the new vars without
      // a full reload.
      const i = state.workspace.environments.findIndex((e) => e.id === env.id);
      if (i >= 0) state.workspace.environments[i] = next;
    } catch (e) {
      result.warnings.push('Failed to persist environment changes: ' + (e?.message || e));
    }
  }

  tab.lastTestResults = result;
  if (state.activeTabId === tab.id) renderTestResults(result);
  updateTestResultsTabBadge(result);
}

function updateTestResultsTabBadge(result) {
  const btn = document.getElementById('rtab-tests-btn');
  if (!btn) return;
  if (!result) { btn.textContent = 'Test Results'; btn.classList.remove('has-fail', 'all-pass'); return; }
  const total = result.tests.length;
  const failed = result.tests.filter((t) => !t.passed).length;
  const errored = !!result.error;
  const summary = errored ? '!' : `${total - failed}/${total}`;
  btn.textContent = `Test Results (${summary})`;
  btn.classList.toggle('has-fail', failed > 0 || errored);
  btn.classList.toggle('all-pass', !errored && failed === 0 && total > 0);
}

function renderTestResults(result) {
  const host = document.getElementById('test-results');
  if (!host) return;
  if (!result) {
    host.innerHTML = '<div class="muted-help">No tests defined for this request. Add a script in the Tests tab to run after each response.</div>';
    return;
  }
  const parts = [];

  if (result.error) {
    parts.push(`<div class="test-error"><strong>Script error:</strong> ${escapeHtml(result.error)}</div>`);
  }

  if (result.tests.length) {
    const passed = result.tests.filter((t) => t.passed).length;
    parts.push(`<div class="test-summary"><strong>${passed}/${result.tests.length}</strong> passed</div>`);
    parts.push('<ul class="test-list">');
    for (const t of result.tests) {
      const cls = t.passed ? 'pass' : 'fail';
      const icon = t.passed ? '✓' : '✗';
      const detail = t.passed ? '' : `<div class="test-error-msg">${escapeHtml(t.error || '')}</div>`;
      parts.push(`<li class="${cls}"><span class="ico">${icon}</span><span class="name">${escapeHtml(t.name)}</span>${detail}</li>`);
    }
    parts.push('</ul>');
  } else if (!result.error) {
    parts.push('<div class="muted-help">Script ran but did not register any pm.test() calls.</div>');
  }

  if (result.warnings.length) {
    parts.push('<div class="test-warnings"><strong>Warnings</strong><ul>');
    for (const w of result.warnings) parts.push(`<li>${escapeHtml(w)}</li>`);
    parts.push('</ul></div>');
  }

  if (result.logs.length) {
    parts.push('<details class="test-logs"><summary>console output (' + result.logs.length + ')</summary><pre>');
    parts.push(result.logs.map(escapeHtml).join('\n'));
    parts.push('</pre></details>');
  }

  host.innerHTML = parts.join('');
}

// Translates a raw error into a human-readable message with hints.
function describeRequestError(err, payload) {
  const raw = err && err.message ? String(err.message) : String(err);
  const lower = raw.toLowerCase();
  const url = payload && payload.url ? payload.url : '';

  if (!url || !url.trim()) {
    return 'No URL provided. Enter a URL in the address bar (e.g., https://api.example.com/users).';
  }
  if (lower.includes('failed to fetch') || lower.includes('networkerror') || lower.includes('econnrefused')) {
    return `Network error contacting ${url}\n\nPossible causes:\n• Backend or target server is not reachable\n• DNS resolution failed\n• Wrong port or host\n\nDetails: ${raw}`;
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return `Request timed out for ${url}\n\nThe server didn't respond in time. Check connectivity, increase timeout, or try again.\n\nDetails: ${raw}`;
  }
  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl')) {
    return `TLS/SSL error for ${url}\n\nThe server's certificate could not be verified.\n\nDetails: ${raw}`;
  }
  if (lower.includes('cors')) {
    return `CORS policy blocked the request to ${url}\n\nDetails: ${raw}`;
  }
  if (lower.includes('json') && lower.includes('parse')) {
    return `Failed to parse JSON response from ${url}\n\nDetails: ${raw}`;
  }
  // Default: show the original message but with request context
  return `Request failed: ${raw}\n\n${payload.method || 'GET'} ${url}`;
}

// Sidebar entry point: respect the "open in new tab" setting. Holding alt/meta
// inverts the default for one-off cases.
function openRequest(req, _name, savedRef) {
  const useNewTab = settings.openInNewTab;
  const cloned = normalizeRequest(JSON.parse(JSON.stringify(req)));
  if (useNewTab) {
    const t = newTab(cloned, {
      savedSnapshot: JSON.stringify(cloned),
      savedRef: savedRef || null,
    });
    activateTab(t.id);
  } else {
    loadRequestInActiveTab(cloned, savedRef);
  }
}

function loadRequestInActiveTab(req, savedRef) {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return;
  tab.request = normalizeRequest(JSON.parse(JSON.stringify(req)));
  tab.lastResponse = null;
  // Loading a saved request resets the baseline — it's no longer dirty.
  tab.savedSnapshot = JSON.stringify(tab.request);
  if (savedRef !== undefined) tab.savedRef = savedRef;
  state.current = tab.request;
  state.lastResponse = null;
  renderTabs();
  renderRequest();
  paintResponseFromTab(tab);
}

// ----- Copy as curl -----
async function onCopyCurl() {
  const env = state.workspace.environments.find(
    (e) => e.id === state.workspace.active_environment_id
  );
  const merged = applyEnvToRequest(state.current, env);
  // Bake auth and default Content-Type into headers so the curl stands alone.
  const withCt = applyDefaultContentType(merged, state.current.body);
  const withAuth = applyAuthToWire(withCt, state.current.auth);
  const cmd = toCurl({ ...merged, headers: withAuth.headers, query: withAuth.query });
  try {
    await navigator.clipboard.writeText(cmd);
    flashButton($('#copy-curl'), 'Copied!');
  } catch {
    showText('Copy this curl command', cmd);
  }
}

// ----- Modal-based confirm (window.confirm is blocked in Electron) -----
function askConfirm({ title = 'Confirm', message = '', okLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#confirm-dialog');
    $('#confirm-dialog-title').textContent = title;
    $('#confirm-dialog-msg').textContent = message;
    $('#confirm-dialog-ok').textContent = okLabel;
    $('#confirm-dialog-cancel').textContent = cancelLabel;
    const cleanup = () => {
      $('#confirm-dialog-ok').onclick = null;
      $('#confirm-dialog-cancel').onclick = null;
      dlg.onclose = null;
    };
    const finish = (v) => { cleanup(); dlg.close(); resolve(v); };
    $('#confirm-dialog-ok').onclick = (e) => { e.preventDefault(); finish(true); };
    $('#confirm-dialog-cancel').onclick = (e) => { e.preventDefault(); finish(false); };
    dlg.onclose = () => { cleanup(); resolve(false); };
    dlg.showModal();
  });
}

// ----- Modal-based prompt (window.prompt is blocked in Electron) -----
function askText({ title = 'Input', label = 'Value', value = '', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#prompt-dialog');
    const input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    $('#prompt-label').textContent = label;
    input.value = value;
    input.placeholder = placeholder;

    const cleanup = () => {
      $('#prompt-confirm').onclick = null;
      $('#prompt-cancel').onclick = null;
      input.onkeydown = null;
      dlg.onclose = null;
    };
    const finish = (val) => { cleanup(); dlg.close(); resolve(val); };

    $('#prompt-confirm').onclick = (e) => { e.preventDefault(); finish(input.value.trim() || null); };
    $('#prompt-cancel').onclick = (e) => { e.preventDefault(); finish(null); };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    dlg.onclose = () => { cleanup(); resolve(null); };

    dlg.showModal();
    setTimeout(() => input.select(), 0);
  });
}

function showText(title, content) {
  const dlg = $('#text-dialog');
  $('#text-title').textContent = title;
  $('#text-content').value = content;
  $('#text-close').onclick = (e) => { e.preventDefault(); dlg.close(); };
  dlg.showModal();
  setTimeout(() => $('#text-content').select(), 0);
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
}

// ----- Save flow -----
//
// Two entry points:
//   - saveActiveTab()   = Cmd+S       : overwrite the existing saved entry if
//                                       the active tab has a savedRef, else
//                                       fall through to Save As.
//   - saveAsActiveTab() = Cmd+Shift+S : always opens the Save dialog so the
//                                       user picks a (possibly new) name +
//                                       collection.
//
// `confirmOverwrite` setting gates the silent overwrite with a Yes/No prompt.

async function saveActiveTab() {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return;
  const ref = tab.savedRef;
  // Never saved before, or the saved entry was deleted out from under us —
  // fall back to the full Save As dialog.
  if (!ref || !ref.collectionId || !ref.requestId || !findSavedRequest(ref)) {
    return saveAsActiveTab();
  }
  if (settings.confirmOverwrite) {
    const ok = await askConfirm({
      title: 'Overwrite saved request?',
      message: `Overwrite "${ref.name}" in this collection with the current changes?`,
      okLabel: 'Overwrite',
    });
    if (!ok) return;
  }
  try {
    await api.updateRequest(ref.collectionId, ref.requestId, {
      id: ref.requestId,
      name: ref.name,
      request: requestForWire(state.current),
    });
    markTabSaved(tab, ref);
    refreshWorkspace();
    // Honor a pending close-after-save (initiated from the close-dirty prompt).
    if (state.pendingCloseAfterSave === tab.id) {
      state.pendingCloseAfterSave = null;
      forceCloseTab(tab.id);
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function saveAsActiveTab() {
  if (state.workspace.collections.length === 0) {
    const name = await askText({
      title: 'Create collection',
      label: 'No collections yet — name one to save into:',
      value: 'My Collection',
    });
    if (!name) return;
    await api.createCollection({ id: '', name, requests: [] });
    await refreshWorkspace();
  }
  const sel = $('#save-collection');
  sel.innerHTML = '';
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  const preferredCollection = tab?.savedRef?.collectionId || null;
  for (const c of state.workspace.collections) {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    if (preferredCollection && preferredCollection === c.id) o.selected = true;
    sel.appendChild(o);
  }
  // Preserve the existing name when re-saving an already-named request, so
  // Save As starts from the right value.
  $('#save-name').value = tab?.savedRef?.name || state.current.url || '';
  $('#save-dialog').showModal();
}

// Back-compat: legacy callers still use openSaveDialog().
const openSaveDialog = saveAsActiveTab;

function findSavedRequest(ref) {
  const c = state.workspace.collections.find((x) => x.id === ref.collectionId);
  return c?.requests.find((r) => r.id === ref.requestId) || null;
}

function wireSaveDialog() {
  $('#save-cancel').onclick = (e) => {
    e.preventDefault();
    $('#save-dialog').close();
    // If user backed out of save during a close-confirmation flow, abort the close too.
    state.pendingCloseAfterSave = null;
  };
  $('#save-confirm').onclick = async (e) => {
    e.preventDefault();
    const name = $('#save-name').value.trim() || 'Untitled';
    const cid = $('#save-collection').value;
    try {
      const saved = await api.addRequest(cid, {
        id: '',
        name,
        request: requestForWire(state.current),
      });
      // Clear the dirty marker on the active tab — its current state is now the baseline.
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab) {
        markTabSaved(tab, {
          collectionId: cid,
          requestId: saved?.id ?? tab.savedRef?.requestId ?? null,
          name,
        });
      }
      $('#save-dialog').close();
      refreshWorkspace();
      // If save was triggered by the close-confirmation flow, drop the tab now.
      if (state.pendingCloseAfterSave) {
        const id = state.pendingCloseAfterSave;
        state.pendingCloseAfterSave = null;
        forceCloseTab(id);
      }
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  };
}

// ----- Env dialog -----
function openEnvDialog() {
  state.envEdit = null;
  redrawEnvList();
  $('#env-name').value = '';
  $('#env-vars').innerHTML = '';
  $('#env-dialog').showModal();
}

function redrawEnvList() {
  const ul = $('#env-list');
  ul.innerHTML = '';
  for (const e of state.workspace.environments) {
    const li = document.createElement('li');
    li.textContent = e.name;
    li.onclick = () => {
      state.envEdit = JSON.parse(JSON.stringify(e));
      $('#env-name').value = state.envEdit.name;
      renderKv('env-vars', state.envEdit.variables);
    };
    ul.appendChild(li);
  }
}

function wireEnvDialog() {
  $('#env-new').onclick = () => {
    state.envEdit = { id: '', name: 'New environment', variables: [] };
    $('#env-name').value = state.envEdit.name;
    renderKv('env-vars', state.envEdit.variables);
  };
  $('#env-add-var').onclick = () => {
    if (!state.envEdit) return;
    state.envEdit.variables.push({ key: '', value: '', description: '', enabled: true });
    renderKv('env-vars', state.envEdit.variables);
  };
  $('#env-name').oninput = (e) => { if (state.envEdit) state.envEdit.name = e.target.value; };
  $('#env-close').onclick = (e) => { e.preventDefault(); $('#env-dialog').close(); };
  $('#env-save').onclick = async (e) => {
    e.preventDefault();
    if (!state.envEdit) return;
    if (state.envEdit.id) {
      await api.updateEnvironment(state.envEdit.id, state.envEdit);
    } else {
      await api.createEnvironment(state.envEdit);
    }
    await refreshWorkspace();
    redrawEnvList();
  };
  $('#env-delete').onclick = async (e) => {
    e.preventDefault();
    if (!state.envEdit?.id) return;
    if (!confirm(`Delete environment "${state.envEdit.name}"?`)) return;
    await api.deleteEnvironment(state.envEdit.id);
    state.envEdit = null;
    $('#env-name').value = '';
    $('#env-vars').innerHTML = '';
    await refreshWorkspace();
    redrawEnvList();
  };
}

// ----- Sidebar collapse -----
function toggleSidebar() {
  settings.sidebarCollapsed = !settings.sidebarCollapsed;
  saveSettings();
  applySidebarState();
}
function applySidebarState() {
  document.querySelector('.layout').classList.toggle('sidebar-collapsed', !!settings.sidebarCollapsed);
}

// ----- Split between request panel and response panel -----
// In vertical mode (default), drag updates request panel's pixel height.
// In horizontal mode (side-by-side), drag updates the workbench's grid columns.
function applySplitState() {
  const rp = document.getElementById('request-panel');
  const wb = document.querySelector('.workbench');
  if (!rp || !wb) return;
  if (settings.splitHorizontal) {
    rp.style.height = '';
    rp.style.width = '';
    const pct = Math.max(15, Math.min(85, settings.splitRequestPct || 50));
    wb.style.gridTemplateColumns = `${pct}fr auto ${100 - pct}fr`;
  } else {
    rp.style.width = '';
    wb.style.gridTemplateColumns = '';
    if (settings.splitRequestPx && settings.splitRequestPx > 80) {
      rp.style.height = settings.splitRequestPx + 'px';
    }
  }
}

function applyLayoutState() {
  const wb = document.querySelector('.workbench');
  if (!wb) return;
  wb.classList.toggle('split-horizontal', !!settings.splitHorizontal);
  applySplitState();
}

function toggleLayout() {
  settings.splitHorizontal = !settings.splitHorizontal;
  saveSettings();
  applyLayoutState();
}
function wireSplitHandle() {
  const handle = document.getElementById('split-handle');
  const rp = document.getElementById('request-panel');
  if (!handle || !rp) return;
  let dragging = false;
  let horizontal = false;
  let startCoord = 0, startSize = 0;
  let workbenchStart = 0, workbenchEnd = 0;

  function startDrag(e) {
    dragging = true;
    horizontal = !!settings.splitHorizontal;
    handle.classList.add('dragging');
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    const rpRect = rp.getBoundingClientRect();
    const wbRect = document.querySelector('.workbench').getBoundingClientRect();
    if (horizontal) {
      startCoord = e.clientX;
      startSize = rpRect.width;
      workbenchStart = wbRect.left;
      workbenchEnd = wbRect.right;
    } else {
      startCoord = e.clientY;
      startSize = rpRect.height;
      workbenchStart = wbRect.top;
      workbenchEnd = wbRect.bottom;
    }
    e.preventDefault(); // prevents text selection / focus jumps during drag
  }

  handle.addEventListener('mousedown', startDrag);

  // Allow grabbing the response panel header as a secondary drag handle.
  const responseMeta = document.querySelector('.response-panel .response-meta');
  if (responseMeta) {
    responseMeta.title = 'Drag to resize request/response split';
    responseMeta.addEventListener('mousedown', (e) => {
      // Don't hijack clicks on buttons, pills, or anything inside the meta.
      if (e.target.closest('button, input, select, a')) return;
      startDrag(e);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const span = workbenchEnd - workbenchStart;
    if (horizontal) {
      const max = span - 200;
      const next = Math.max(150, Math.min(max, startSize + (e.clientX - startCoord)));
      const pct = (next / span) * 100;
      const wb = document.querySelector('.workbench');
      if (wb) wb.style.gridTemplateColumns = `${pct}fr auto ${100 - pct}fr`;
    } else {
      const max = span - 200;
      const next = Math.max(120, Math.min(max, startSize + (e.clientY - startCoord)));
      rp.style.height = next + 'px';
    }
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (horizontal) {
      const wbRect = document.querySelector('.workbench').getBoundingClientRect();
      const span = wbRect.right - wbRect.left;
      const w = rp.getBoundingClientRect().width;
      settings.splitRequestPct = (w / span) * 100;
    } else {
      settings.splitRequestPx = rp.getBoundingClientRect().height;
    }
    saveSettings();
  });
}

// ----- Settings dialog -----
function openSettingsDialog() {
  $('#open-in-new-tab').checked = !!settings.openInNewTab;
  $('#confirm-overwrite').checked = !!settings.confirmOverwrite;
  $('#highlight-request-body').checked = settings.highlightRequestBody !== false;
  $('#highlight-response-body').checked = settings.highlightResponseBody !== false;
  $('#render-limit-mb').value = settings.renderLimitMb;
  $('#history-count').value = settings.historyCount;
  $('#settings-dialog').showModal();
}
function wireSettingsDialog() {
  $('#open-in-new-tab').onchange = (e) => {
    settings.openInNewTab = e.target.checked;
    saveSettings();
  };
  $('#confirm-overwrite').onchange = (e) => {
    settings.confirmOverwrite = e.target.checked;
    saveSettings();
  };
  $('#highlight-request-body').onchange = (e) => {
    settings.highlightRequestBody = e.target.checked;
    saveSettings();
    reapplyEditorHighlighting();
  };
  $('#highlight-response-body').onchange = (e) => {
    settings.highlightResponseBody = e.target.checked;
    saveSettings();
    reapplyEditorHighlighting();
  };
  $('#render-limit-mb').onchange = (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      settings.renderLimitMb = v;
      saveSettings();
      // Re-paint active tab's response so the new cap applies immediately.
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab && tab.lastResponse) paintResponseFromTab(tab);
    } else {
      e.target.value = settings.renderLimitMb;
    }
  };
  $('#history-count').onchange = (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v) && v > 0) {
      settings.historyCount = v;
      saveSettings();
      renderHistory();
    } else {
      e.target.value = settings.historyCount;
    }
  };
  $('#open-env').onclick = (e) => { e.preventDefault(); $('#settings-dialog').close(); openEnvDialog(); };
  $('#open-proxy').onclick = (e) => { e.preventDefault(); $('#settings-dialog').close(); openProxyDialog(); };
  $('#open-import').onclick = (e) => { e.preventDefault(); $('#settings-dialog').close(); onImportPostman(); };
  $('#settings-close').onclick = (e) => { e.preventDefault(); $('#settings-dialog').close(); };
}

// ----- Proxy dialog -----
function openProxyDialog() {
  const p = state.workspace.proxy || { enabled: false, url: '', bypass: '' };
  $('#proxy-enabled').checked = !!p.enabled;
  $('#proxy-url').value = p.url || '';
  $('#proxy-bypass').value = p.bypass || '';
  $('#proxy-dialog').showModal();
}

function wireProxyDialog() {
  $('#proxy-cancel').onclick = (e) => { e.preventDefault(); $('#proxy-dialog').close(); };
  $('#proxy-save').onclick = async (e) => {
    e.preventDefault();
    const cfg = {
      enabled: $('#proxy-enabled').checked,
      url: $('#proxy-url').value.trim(),
      bypass: $('#proxy-bypass').value.trim(),
    };
    try {
      await api.setProxy(cfg);
      state.workspace.proxy = cfg;
      $('#proxy-dialog').close();
      updateProxyIndicator();
    } catch (err) {
      alert('Failed to save proxy: ' + err.message);
    }
  };
}

function updateProxyIndicator() {
  // Visible affordances: a green dot on the in-Settings Proxy row, and a small
  // dot on the topbar Settings button so the user sees state at a glance.
  const p = state.workspace.proxy || {};
  const on = !!(p.enabled && p.url);
  const dot = $('#proxy-status-pill');
  if (dot) dot.classList.toggle('hidden', !on);
  const btn = $('#settings-btn');
  if (btn) {
    btn.classList.toggle('has-indicator', on);
    btn.title = on ? `Proxy active: ${p.url}` : 'Settings';
  }
}

// ----- Postman import -----
async function onImportPostman() {
  const file = await window.postie.openFile({
    filters: [{ name: 'Postman JSON', extensions: ['json'] }],
  });
  if (!file) return;
  let json;
  try {
    json = JSON.parse(file.content);
  } catch {
    alert('Selected file is not valid JSON.');
    return;
  }

  const isEnv = Array.isArray(json.values) && !json.item;
  try {
    if (isEnv) {
      const env = importPostmanEnvironment(json);
      await api.createEnvironment({ id: '', ...env });
    } else {
      const col = importPostmanCollection(json);
      const created = await api.createCollection({ id: '', name: col.name, requests: [] });
      for (const r of col.requests) {
        // Normalize body to backend wire format (strips `content` from `none`,
        // coerces shapes, etc). Auth is renderer-only — strip before saving.
        const wire = requestForWire(r.request);
        await api.addRequest(created.id, { id: '', name: r.name, request: wire });
      }
    }
    await refreshWorkspace();
    alert(isEnv ? 'Environment imported.' : 'Collection imported.');
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

async function exportCollectionToFile(c) {
  try {
    const json = exportPostmanCollection(c);
    const safeName = (c.name || 'collection').replace(/[^a-z0-9._-]+/gi, '_');
    const path = await window.postie.saveFile({
      defaultName: `${safeName}.postman_collection.json`,
      content: JSON.stringify(json, null, 2),
    });
    if (!path) return; // user cancelled
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}

// ----- utils -----
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
function truncate(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ----- Keyboard shortcuts -----
function wireKeyboardShortcuts() {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const target = e.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    // Cmd/Ctrl + Enter: Send request
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      sendRequest();
      return;
    }
    // Cmd/Ctrl + Shift + S: Save As (always opens picker)
    // Cmd/Ctrl + S:         Save (overwrite if already saved, else picker)
    if (mod && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      if (e.shiftKey) saveAsActiveTab();
      else saveActiveTab();
      return;
    }
    // Cmd/Ctrl + T: New tab
    if (mod && (e.key === 't' || e.key === 'T')) {
      e.preventDefault();
      activateTab(newTab().id);
      return;
    }
    // Cmd/Ctrl + W: Close active tab (only when not focused in input)
    if (mod && (e.key === 'w' || e.key === 'W') && !inField) {
      e.preventDefault();
      if (state.activeTabId) closeTab(state.activeTabId);
      return;
    }
    // Cmd/Ctrl + L or K: focus URL bar
    if (mod && (e.key === 'l' || e.key === 'L' || e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const url = $('#url');
      if (url) { url.focus(); url.select(); }
      return;
    }
    // Cmd/Ctrl + B: toggle sidebar
    if (mod && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    // Cmd/Ctrl + Shift + F: format response body
    if (mod && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      const btn = $('#format-response');
      if (btn) btn.click();
      return;
    }
    // Cmd/Ctrl + Shift + C: copy as cURL
    if (mod && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      onCopyCurl();
      return;
    }
    // Escape: cancel an in-flight request
    if (e.key === 'Escape') {
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      if (tab && tab.pendingSince && tab.abortController) {
        e.preventDefault();
        tab.abortController.abort();
      }
      return;
    }
    // ? : show shortcuts help (when not in input)
    if (!inField && !mod && e.key === '?') {
      e.preventDefault();
      showShortcutsHelp();
      return;
    }
  });
}

function showShortcutsHelp() {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const M = isMac ? '⌘' : 'Ctrl';
  const text =
    `Keyboard shortcuts\n\n` +
    `${M}+Enter        Send request\n` +
    `${M}+S            Save (overwrite if already saved)\n` +
    `${M}+Shift+S      Save As (always opens picker)\n` +
    `${M}+T            New tab\n` +
    `${M}+W            Close active tab\n` +
    `${M}+L  /  ${M}+K   Focus URL bar\n` +
    `${M}+B            Toggle sidebar\n` +
    `${M}+Shift+F      Format response\n` +
    `${M}+Shift+C      Copy as cURL\n` +
    `Esc            Cancel in-flight request\n` +
    `?              Show this help`;
  showText('Keyboard shortcuts', text);
}

// ----- Context menus -----
function wireContextMenus() {
  // Right-click on a request tab → tab actions
  document.addEventListener('contextmenu', (e) => {
    const reqTab = e.target.closest('.req-tab');
    if (reqTab) {
      e.preventDefault();
      const idx = [...document.querySelectorAll('#request-tabs .req-tab')].indexOf(reqTab);
      const tab = state.tabs[idx];
      if (!tab) return;
      // Anchor menu below the tab's bottom-left so it never overlays the "+" new-tab button.
      const r = reqTab.getBoundingClientRect();
      const hasSavedRef = !!(tab.savedRef && tab.savedRef.collectionId && tab.savedRef.requestId);
      showContextMenu(r.left, r.bottom + 2, [
        { label: 'Save', onClick: () => { activateTab(tab.id); saveActiveTab(); }, disabled: !isTabDirty(tab) && hasSavedRef },
        { label: 'Save As…',  onClick: () => { activateTab(tab.id); saveAsActiveTab(); } },
        { divider: true },
        { label: 'Duplicate tab', onClick: () => {
          const cloned = JSON.parse(JSON.stringify(tab.request));
          activateTab(newTab(cloned).id);
        }},
        { label: 'Close tab', onClick: () => closeTab(tab.id) },
        { label: 'Close other tabs', onClick: () => {
          for (const t of [...state.tabs]) if (t.id !== tab.id) closeTab(t.id);
        }},
      ]);
      return;
    }

    // Right-click on a saved request inside a collection → rename / delete
    const collectionReq = e.target.closest('#collections-list .req');
    if (collectionReq) {
      e.preventDefault();
      const cid = collectionReq.dataset.collectionId;
      const rid = collectionReq.dataset.requestId;
      const col = state.workspace.collections.find((c) => c.id === cid);
      const r = col?.requests.find((x) => x.id === rid);
      if (!r) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open in new tab', onClick: () => collectionReq.click() },
        { label: 'Rename…', onClick: () => renameSavedRequest(cid, r) },
        { label: 'Delete', onClick: () => confirmDeleteRequest(cid, r) },
      ]);
      return;
    }

    // Right-click on a collection header → rename / delete
    const collectionRow = e.target.closest('#collections-list .collection');
    if (collectionRow) {
      e.preventDefault();
      const cid = collectionRow.dataset.collectionId;
      const c = state.workspace.collections.find((x) => x.id === cid);
      if (!c) return;
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Rename…', onClick: () => renameCollection(c) },
        { label: 'Export…', onClick: () => exportCollectionToFile(c) },
        { divider: true },
        { label: 'Delete', onClick: () => confirmDeleteCollection(c) },
      ]);
      return;
    }

    // Right-click on a history item → open
    const historyReq = e.target.closest('#history-list .req');
    if (historyReq) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Open in new tab', onClick: () => historyReq.click() },
      ]);
      return;
    }

    // Right-click on the response body → copy/save shortcuts
    if (e.target.closest('#response-body, #response-headers')) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        { label: 'Copy response', onClick: () => $('#copy-response').click() },
        { label: 'Save response to file…', onClick: () => $('#save-response').click() },
        { label: 'Format', onClick: () => $('#format-response').click() },
      ]);
      return;
    }
  });
}

function showContextMenu(x, y, items) {
  // Remove any existing menu
  const existing = document.getElementById('postie-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'postie-context-menu';
  menu.className = 'context-menu';
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  for (const it of items) {
    if (it.divider) {
      const sep = document.createElement('div');
      sep.className = 'context-menu-divider';
      menu.appendChild(sep);
      continue;
    }
    const item = document.createElement('div');
    item.className = 'context-menu-item' + (it.disabled ? ' disabled' : '');
    item.textContent = it.label;
    if (!it.disabled) {
      item.addEventListener('click', () => {
        try { it.onClick(); } finally { menu.remove(); }
      });
    }
    menu.appendChild(item);
  }
  document.body.appendChild(menu);

  // Adjust if going off-screen
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';

  // Close on outside click / escape / scroll
  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
  };
  const onDocDown = (ev) => { if (!menu.contains(ev.target)) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  setTimeout(() => {
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
  }, 0);
}
