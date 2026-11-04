// termdeck – Hauptprozess: Fenster, PTYs, Sitzung speichern
const { app, BrowserWindow, ipcMain, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');

const SESSION_FILE = process.env.TERMDECK_SESSION || path.join(app.getPath('userData'), 'session.json');
const ptys = new Map(); // id -> pty
const owners = new Map(); // id -> webContents (Dashboard oder gelöstes Fenster); null = unterwegs
const inTransit = new Map(); // id -> { data: [], payload } während des Umzugs
let nextId = 1;
let win = null;
const allWins = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
const broadcast = (ch, ...args) => { for (const w of allWins()) w.webContents.send(ch, ...args); };

function cwdOf(id) {
  const p = ptys.get(id);
  if (!p) return null;
  try { return fs.readlinkSync(`/proc/${p.pid}/cwd`); } catch { return null; }
}

// Testmodus: TERMDECK_SHOT=/pfad.png → unsichtbar starten, Screenshot, beenden
const SHOT = process.env.TERMDECK_SHOT;

function createWindow() {
  win = new BrowserWindow({
    fullscreen: !SHOT,
    show: !SHOT,
    width: +process.env.TERMDECK_W || 1600,
    height: 900,
    backgroundColor: '#14141c',
    title: 'termdeck',
    icon: path.join(__dirname, 'assets', 'termdeck.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'app', 'index.html'), SHOT ? { query: { shot: '1' } } : undefined);
  win.on('closed', () => { win = null; for (const w of allWins()) w.close(); });
  if (SHOT) {
    win.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
    win.webContents.on('did-finish-load', () => {
      const script = process.env.TERMDECK_SCRIPT || '';
      setTimeout(async () => {
        if (script) await win.webContents.executeJavaScript(script).catch((e) => console.log('script error', e));
        setTimeout(async () => {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(SHOT, img.toPNG());
          app.quit();
        }, 2500);
      }, 1500);
    });
  }
}

ipcMain.handle('pty:create', (_e, { cols, rows, cwd }) => {
  const id = nextId++;
  const shell = process.env.SHELL || '/bin/bash';
  let dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const p = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: dir,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'termdeck' },
  });
  ptys.set(id, p);
  owners.set(id, _e.sender);
  p.onData((data) => {
    const t = inTransit.get(id);
    if (t) return void t.data.push(data);
    const o = owners.get(id);
    if (o && !o.isDestroyed()) o.send('pty:data', id, data);
  });
  p.onExit(() => {
    const o = owners.get(id);
    ptys.delete(id); owners.delete(id); inTransit.delete(id);
    if (o && !o.isDestroyed()) o.send('pty:exit', id);
  });
  return id;
});

// ---------- Lösen / Andocken ----------
// Ausgabe anhalten (puffern), bevor der Inhalt für den Umzug serialisiert wird
ipcMain.handle('pty:hold', (_e, id) => { if (!inTransit.has(id)) inTransit.set(id, { data: [] }); return ptys.has(id); });
function openDetached(id, payload, bounds) {
  const tr = inTransit.get(id) || { data: [] };
  tr.payload = payload;
  inTransit.set(id, tr);
  const w = new BrowserWindow({
    width: bounds?.width || 960, height: bounds?.height || 620,
    x: bounds?.x, y: bounds?.y,
    backgroundColor: '#14141c', title: payload.title || 'termdeck',
    icon: path.join(__dirname, 'assets', 'termdeck.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.loadFile(path.join(__dirname, 'app', 'index.html'), { query: { single: String(id), ...(SHOT ? { shot: '1' } : {}) } });
  if (SHOT) {
    w.webContents.on('console-message', (_e, _l, msg) => console.log('[single]', msg));
    if (process.env.TERMDECK_SINGLE_SCRIPT) w.webContents.on('did-finish-load', () => setTimeout(() =>
      w.webContents.executeJavaScript(process.env.TERMDECK_SINGLE_SCRIPT).catch((e) => console.log('single script error', e)), 1200));
  }
  // Fenster zu = Terminal beenden (außer es wurde vorher angedockt)
  w.on('closed', () => { if (owners.get(id) === null || owners.get(id)?.isDestroyed?.()) { const p = ptys.get(id); if (p) try { p.kill(); } catch {} } });
  owners.set(id, null);
  return w;
}
ipcMain.on('pty:detach', (e, id, payload) => {
  if (!ptys.has(id)) return;
  const b = BrowserWindow.fromWebContents(e.sender)?.getBounds();
  openDetached(id, payload, b && { x: b.x + 80, y: b.y + 80, width: Math.min(1000, b.width - 160), height: Math.min(650, b.height - 160) });
});
// gelöstes Fenster holt sich Inhalt + zwischengepufferte Ausgabe ab
ipcMain.handle('single:init', (e, id) => {
  const t = inTransit.get(id);
  inTransit.delete(id);
  if (!ptys.has(id)) return null;
  owners.set(id, e.sender);
  return { ...(t?.payload || {}), pending: (t?.data || []).join(''), cwd: cwdOf(id) };
});
ipcMain.on('pty:dock', (e, id, payload) => {
  if (!ptys.has(id) || !win) return;
  const tr = inTransit.get(id) || { data: [] };
  tr.payload = payload;
  inTransit.set(id, tr);
  owners.set(id, win.webContents);
  win.webContents.send('pty:adopt', id, payload);
  win.focus();
  BrowserWindow.fromWebContents(e.sender)?.destroy();
});
ipcMain.handle('adopt:init', (_e, id) => {
  const t = inTransit.get(id);
  inTransit.delete(id);
  return { pending: (t?.data || []).join(''), cwd: cwdOf(id) };
});

ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try { ptys.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 1)); } catch {}
});
ipcMain.on('pty:kill', (_e, id) => {
  const p = ptys.get(id);
  if (p) { try { p.kill(); } catch {} ptys.delete(id); }
});
ipcMain.handle('pty:cwd', (_e, id) => cwdOf(id));

ipcMain.on('clip:write', (_e, text, type) => clipboard.writeText(text, type || 'clipboard'));
ipcMain.handle('clip:read', (_e, type) => clipboard.readText(type || 'clipboard'));

// ---------- Dateien/Bilder ins Terminal ziehen ----------
// Dateien ohne eigenen Pfad (Bilder aus dem Browser, Zwischenablage) landen hier und werden als Pfad eingefügt.
const DROP_DIR = path.join(app.getPath('userData'), 'drops');
const MAX_DROP = 30 * 1024 * 1024;
function dropName(name, ext) {
  const base = String(name || 'bild').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'bild';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(DROP_DIR, `${stamp}-${Math.random().toString(36).slice(2, 6)}-${ext && !base.includes('.') ? base + '.' + ext : base}`);
}
function writeDrop(name, bytes, ext) {
  fs.mkdirSync(DROP_DIR, { recursive: true });
  const f = dropName(name, ext);
  fs.writeFileSync(f, bytes);
  return f;
}
ipcMain.handle('drop:save', (_e, name, bytes) => {
  if (!bytes || bytes.byteLength > MAX_DROP) return null;
  return writeDrop(name, Buffer.from(bytes));
});
ipcMain.handle('drop:url', async (_e, url) => {
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_DROP) return null;
    const ext = type.split('/')[1].split(';')[0].replace('jpeg', 'jpg').replace('svg+xml', 'svg');
    return writeDrop(decodeURIComponent(new URL(url).pathname.split('/').pop() || 'bild'), buf, ext);
  } catch { return null; }
});
ipcMain.handle('clip:image', () => {
  const img = clipboard.readImage();
  return img.isEmpty() ? null : writeDrop('zwischenablage', img.toPNG(), 'png');
});
// alte abgelegte Dateien (> 14 Tage) aufräumen
try { for (const f of fs.readdirSync(DROP_DIR)) { const p = path.join(DROP_DIR, f); if (Date.now() - fs.statSync(p).mtimeMs > 14 * 864e5) fs.unlinkSync(p); } } catch {}

ipcMain.on('win:fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); w?.setFullScreen(!w.isFullScreen()); });
ipcMain.on('win:title', (e, t) => { const w = BrowserWindow.fromWebContents(e.sender); if (w && w !== win) w.setTitle(t || 'termdeck'); });

// Layout: Blätter tragen ptyId; beim Speichern durch aktuelles Verzeichnis ersetzen
function withCwds(node, t = procTable()) {
  if (!node) return null;
  if (node.type === 'leaf') {
    const out = { type: 'leaf', cwd: cwdOf(node.ptyId) || node.cwd || null };
    const p = ptys.get(node.ptyId);
    const cpid = p && findClaude(p.pid, t);
    const sess = cpid && readSess(cpid);
    if (sess && transcriptPath(sess)) { out.claude = sess.sessionId; out.cwd = sess.cwd || out.cwd; }
    return out;
  }
  return { ...node, a: withCwds(node.a, t), b: withCwds(node.b, t) };
}
ipcMain.on('session:save', (_e, state) => {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...state, tree: withCwds(state.tree) }, null, 2));
  } catch (err) { console.error('session save failed', err); }
});
ipcMain.handle('session:load', () => {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')); } catch { return null; }
});

// ---------- KI-Status: Claude-Code-Sitzungen in den Terminals erkennen ----------
const CLAUDE_DIR = process.env.TERMDECK_CLAUDE_DIR || path.join(os.homedir(), '.claude');
const transcripts = new Map(); // Datei -> { offset, rest, model, ctx, out }

function procTable() {
  const kids = new Map(); // ppid -> [pid]
  const comm = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const r = stat.lastIndexOf(')');
      const ppid = +stat.slice(r + 2).split(' ')[1];
      comm.set(+d, stat.slice(stat.indexOf('(') + 1, r));
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(+d);
    } catch {}
  }
  return { kids, comm };
}

function findClaude(rootPid, t) {
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    if (t.comm.get(p) === 'claude') return p;
    stack.push(...(t.kids.get(p) || []));
  }
  return null;
}

function transcriptPath(sess) {
  const enc = (sess.cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  const direct = path.join(CLAUDE_DIR, 'projects', enc, `${sess.sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(path.join(CLAUDE_DIR, 'projects'))) {
      const f = path.join(CLAUDE_DIR, 'projects', d, `${sess.sessionId}.jsonl`);
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}

// Nur neue Bytes lesen und Verbrauch fortschreiben
function readUsage(file) {
  let st = transcripts.get(file);
  if (!st) { st = { offset: 0, rest: '', model: null, ctx: 0, out: 0, title: null }; transcripts.set(file, st); }
  let size;
  try { size = fs.statSync(file).size; } catch { return st; }
  if (size < st.offset) Object.assign(st, { offset: 0, rest: '', ctx: 0, out: 0 });
  if (size === st.offset) return st;
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - st.offset);
  fs.readSync(fd, buf, 0, buf.length, st.offset);
  fs.closeSync(fd);
  st.offset = size;
  const lines = (st.rest + buf.toString('utf8')).split('\n');
  st.rest = lines.pop();
  for (const l of lines) {
    if (!l.includes('"usage"') && !l.includes('"ai-title"')) continue;
    try {
      const d = JSON.parse(l);
      if (d.type === 'ai-title') st.title = d.aiTitle;
      const m = d.message;
      if (d.type !== 'assistant' || !m?.usage || d.isSidechain) continue;
      if (m.model && m.model !== '<synthetic>') st.model = m.model;
      const u = m.usage;
      st.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (m.id && m.id === st.lastId) st.out -= st.lastOut; // gleiche Nachricht, mehrere Zeilen
      st.lastId = m.id; st.lastOut = u.output_tokens || 0;
      st.out += st.lastOut;
    } catch {}
  }
  return st;
}

function pollAi() {
  if (!allWins().length || !ptys.size) return;
  let t;
  try { t = procTable(); } catch { return; }
  const result = {};
  for (const [id, p] of ptys) {
    const cpid = findClaude(p.pid, t);
    if (!cpid) {
      const x = findCodex(p.pid, t);
      if (x) result[id] = codexInfo(x);
      continue;
    }
    const info = { pid: cpid, agent: 'claude' };
    try {
      const sess = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', `${cpid}.json`), 'utf8'));
      info.status = sess.status;
      info.name = sess.name;
      const f = transcriptPath(sess);
      if (f) {
        const u = readUsage(f);
        Object.assign(info, { model: u.model, ctx: u.ctx, out: u.out, title: u.title });
      }
    } catch {}
    result[id] = info;
  }
  broadcast('ai:status', result);
}
setInterval(pollAi, 2000);

// ---------- Codex ----------
const CODEX_DIR = process.env.TERMDECK_CODEX_DIR || path.join(os.homedir(), '.codex');
const codexFiles = new Map(); // codex-pid -> rollout-Datei
const codexState = new Map(); // Datei -> Zustand

function findCodex(rootPid, t) {
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    const c = t.comm.get(p);
    if (c === 'codex') return p;
    if (c === 'node' || c === 'MainThread') {
      try { if (/[/\\]codex(\.js)?(\0|$)/.test(fs.readFileSync(`/proc/${p}/cmdline`, 'utf8'))) return p; } catch {}
    }
    stack.push(...(t.kids.get(p) || []));
  }
  return null;
}

function recentRollouts(days = 2) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const dir = path.join(CODEX_DIR, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.jsonl')) out.push(path.join(dir, f)); } catch {}
  }
  return out.map((f) => { try { return { f, m: fs.statSync(f).mtimeMs }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.m - a.m);
}
// Zuordnung über Ordner + Startzeit (Codex läuft u. U. über einen gemeinsamen Hintergrunddienst)
function codexFileFor(pid) {
  const known = codexFiles.get(pid);
  if (known) return known;
  const cwd = procCwd(pid);
  let started = 0; try { started = fs.statSync(`/proc/${pid}`).ctimeMs - 5000; } catch {}
  const hit = recentRollouts().find((r) => r.m >= started && rolloutMeta(r.f)?.cwd === cwd);
  if (hit) codexFiles.set(pid, hit.f);
  return hit?.f || null;
}

function readCodex(file) {
  let st = codexState.get(file);
  if (!st) { st = { offset: 0, rest: '', model: null, ctx: 0, ctxMax: 0, out: 0, status: 'idle', account: rolloutMeta(file)?.account }; codexState.set(file, st); }
  let size; try { size = fs.statSync(file).size; } catch { return st; }
  if (size <= st.offset) return st;
  const start = st.offset === 0 && size > 4e6 ? size - 4e6 : st.offset; // sehr große Dateien: nur das Ende
  const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
  st.offset = size;
  const lines = (st.rest + buf.toString('utf8')).split('\n'); st.rest = lines.pop();
  for (const l of lines) {
    if (!/"(turn_context|token_count|task_started|task_complete|turn_aborted)"/.test(l)) continue;
    try {
      const d = JSON.parse(l), pl = d.payload || {};
      if (d.type === 'turn_context' && pl.model) st.model = pl.model;
      else if (pl.type === 'task_started') st.status = 'busy';
      else if (pl.type === 'task_complete' || pl.type === 'turn_aborted') st.status = 'idle';
      else if (pl.type === 'token_count') {
        const i = pl.info;
        if (i) { st.ctx = i.last_token_usage?.input_tokens || st.ctx; st.ctxMax = i.model_context_window || st.ctxMax; st.out = i.total_token_usage?.output_tokens || st.out; }
        noteCodexLimits(pl.rate_limits, d.timestamp, st.account);
      }
    } catch {}
  }
  return st;
}
function codexInfo(pid) {
  const f = codexFileFor(pid);
  const info = { pid, agent: 'codex', status: 'idle' };
  if (f) {
    const u = readCodex(f);
    const acc = u.account && store.accounts[`codex:${u.account}`];
    Object.assign(info, { model: u.model, ctx: u.ctx, ctxMax: u.ctxMax, out: u.out, status: u.status,
      account: acc ? acc.label || acc.email || 'Konto ' + acc.id.slice(0, 8) : null });
  }
  return info;
}

// ---------- Konten & Limits (Session/Woche) ----------
// Jedes Konto, das je angemeldet war, wird gespeichert; Limits je Konto.
const ACCOUNTS_FILE = process.env.TERMDECK_ACCOUNTS || path.join(app.getPath('userData'), 'accounts.json');
let store = { accounts: {}, removed: {} };
try { store = { accounts: {}, removed: {}, ...JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')) }; } catch {}
let storeDirty = false;
function saveStore() {
  if (!storeDirty) return;
  try { fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true }); fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(store, null, 2)); storeDirty = false; } catch {}
}
// Konto anlegen/aktualisieren; Aktivität nach dem Entfernen holt es zurück
function upsert(provider, id, fields, activityAt) {
  const key = `${provider}:${id}`;
  const acc = store.accounts[key] || (store.accounts[key] = { key, provider, id, firstSeen: Date.now() });
  for (const [k, v] of Object.entries(fields)) if (v != null && acc[k] !== v) { acc[k] = v; storeDirty = true; }
  if (activityAt && (!acc.lastSeen || activityAt > acc.lastSeen)) { acc.lastSeen = activityAt; storeDirty = true; }
  if (store.removed[key] && activityAt && activityAt > store.removed[key]) { delete store.removed[key]; storeDirty = true; }
  return acc;
}
function jwtClaims(t) {
  try { const p = t.split('.')[1]; return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { return {}; }
}

// --- Codex ---
const rolloutMetaCache = new Map(); // Datei -> payload der ersten Zeile
function rolloutMeta(f) {
  if (rolloutMetaCache.has(f)) return rolloutMetaCache.get(f);
  let m = null;
  try {
    const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(16384); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    const first = b.toString('utf8', 0, n).split('\n')[0];
    const pick = (k) => (first.match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1];
    m = { cwd: pick('cwd'), account: pick('creator_account_id'), user: pick('creator_user_id') };
  } catch {}
  rolloutMetaCache.set(f, m);
  return m;
}
function codexActive() {
  try {
    const a = JSON.parse(fs.readFileSync(path.join(CODEX_DIR, 'auth.json'), 'utf8'));
    const c = jwtClaims(a.tokens?.id_token || '');
    const auth = c['https://api.openai.com/auth'] || {};
    const id = a.tokens?.account_id || auth.chatgpt_account_id;
    if (!id) return null;
    return upsert('codex', id, { email: c.email, plan: auth.chatgpt_plan_type, user: auth.chatgpt_user_id }, null);
  } catch { return null; }
}
function noteCodexLimits(rl, ts, accountId) {
  if (!rl?.primary || rl.limit_id !== 'codex' || !accountId) return;
  const at = Date.parse(ts) || Date.now();
  const acc = upsert('codex', accountId, { plan: rl.plan_type }, at);
  if (acc.limitsAt && acc.limitsAt >= at) return;
  acc.limitsAt = at;
  acc.raw = { primary: rl.primary, secondary: rl.secondary };
  storeDirty = true;
}
const scannedSize = new Map(); // Datei -> Größe beim letzten Scan
function scanCodex(maxFiles) {
  const seen = new Set();
  for (const { f, m } of recentRollouts(maxFiles > 10 ? 120 : 8).slice(0, maxFiles)) {
    const meta = rolloutMeta(f);
    if (!meta?.account) continue;
    upsert('codex', meta.account, { user: meta.user }, m);
    if (seen.has(meta.account)) continue; // neuester Stand je Konto genügt
    try {
      const size = fs.statSync(f).size, len = Math.min(size, 1.5e6);
      if (scannedSize.get(f) === size) { seen.add(meta.account); continue; }
      scannedSize.set(f, size);
      const fd = fs.openSync(f, 'r'); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, size - len); fs.closeSync(fd);
      for (const l of b.toString('utf8').split('\n').reverse()) {
        if (!l.includes('"primary":{')) continue;
        try { const d = JSON.parse(l); const rl = d.payload?.rate_limits; if (rl?.primary && rl.limit_id === 'codex') { noteCodexLimits(rl, d.timestamp, meta.account); seen.add(meta.account); break; } } catch {}
      }
    } catch {}
  }
}
function codexBars(raw) {
  if (!raw) return [];
  const now = Date.now();
  const bar = (w) => {
    if (!w) return null;
    const wm = w.window_minutes || 0, resets = (w.resets_at || 0) * 1000;
    const label = wm >= 1400 ? 'Woche' : wm >= 200 ? 'Session' : `${Math.round(wm / 60)}h-Fenster`;
    const done = resets && resets < now; // Fenster ist inzwischen zurückgesetzt
    return { label, percent: done ? 0 : w.used_percent, resetsAt: done ? null : resets || null, windowMin: wm };
  };
  return [bar(raw.primary), bar(raw.secondary)].filter(Boolean).sort((x, y) => x.windowMin - y.windowMin);
}
let codexScanned = false;

// --- Claude ---
function claudeActive() {
  try {
    const oa = JSON.parse(fs.readFileSync(path.join(path.dirname(CLAUDE_DIR), '.claude.json'), 'utf8')).oauthAccount;
    if (!oa?.accountUuid) return null;
    let plan = null; try { plan = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth?.subscriptionType; } catch {}
    return upsert('claude', oa.accountUuid, { email: oa.emailAddress, org: oa.organizationName, plan }, Date.now());
  } catch { return null; }
}
async function claudeFetch(acc) {
  let cred;
  try { cred = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, '.credentials.json'), 'utf8')).claudeAiOauth; } catch { return; }
  if (!cred?.accessToken) return;
  if (cred.expiresAt && cred.expiresAt < Date.now()) { acc.error = 'Login abgelaufen – öffne einmal Claude Code'; return; }
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'termdeck' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const name = (l) => l.kind === 'session' ? 'Session' : l.kind === 'weekly_all' ? 'Woche'
      : 'Woche · ' + (l.scope?.model?.display_name || l.scope?.surface || l.kind);
    let bars = (d.limits || []).map((l) => ({ label: name(l), percent: l.percent ?? 0, resetsAt: Date.parse(l.resets_at) || null, scoped: l.kind === 'weekly_scoped' }));
    if (!bars.length) bars = [
      d.five_hour && { label: 'Session', percent: d.five_hour.utilization, resetsAt: Date.parse(d.five_hour.resets_at) },
      d.seven_day && { label: 'Woche', percent: d.seven_day.utilization, resetsAt: Date.parse(d.seven_day.resets_at) },
    ].filter(Boolean);
    const ex = d.extra_usage;
    acc.bars = bars;
    acc.extra = ex && ex.is_enabled ? { used: ex.used_credits, limit: ex.monthly_limit, currency: ex.currency, percent: ex.utilization } : null;
    acc.limitsAt = Date.now();
    acc.error = null;
    storeDirty = true;
  } catch (err) { acc.error = 'Abfrage fehlgeschlagen (' + err.message + ')'; }
}

// --- zusammenführen ---
let lastLimits = null;
async function pollLimits() {
  const claude = claudeActive();
  if (claude) await claudeFetch(claude);
  const codex = codexActive();
  scanCodex(codexScanned ? 6 : 120);
  codexScanned = true;
  saveStore();
  const now = Date.now();
  const accounts = Object.values(store.accounts)
    .filter((a) => !store.removed[a.key] || a.key === claude?.key || a.key === codex?.key) // angemeldet = immer sichtbar
    .map((a) => {
      const active = (a.provider === 'claude' && a.key === claude?.key) || (a.provider === 'codex' && a.key === codex?.key);
      return {
        key: a.key, provider: a.provider, name: a.provider === 'claude' ? 'Claude' : 'Codex',
        email: a.email || null, label: a.label || null, idShort: a.id.slice(0, 8), plan: a.plan || null, org: a.org || null,
        active, lastSeen: a.lastSeen || null, updatedAt: a.limitsAt || null,
        stale: a.provider === 'codex' || !active,
        bars: a.provider === 'codex' ? codexBars(a.raw) : (a.bars || []),
        extra: active ? a.extra : null, error: active ? a.error : null,
      };
    })
    .sort((x, y) => (x.provider === y.provider ? 0 : x.provider === 'claude' ? -1 : 1) || (y.active - x.active) || ((y.lastSeen || 0) - (x.lastSeen || 0)));
  lastLimits = { accounts, at: now };
  broadcast('limits', lastLimits);
  return lastLimits;
}
setInterval(pollLimits, 60000);
ipcMain.handle('limits:get', async (_e, force) => (force || !lastLimits ? pollLimits() : lastLimits));
ipcMain.handle('accounts:remove', (_e, key) => {
  if (!store.accounts[key]) return pollLimits();
  store.removed[key] = Date.now();
  delete store.accounts[key];     // gespeicherte Daten verwerfen
  for (const f of scannedSize.keys()) scannedSize.delete(f);
  storeDirty = true; saveStore();
  return pollLimits();
});
ipcMain.handle('accounts:rename', (_e, key, label) => {
  const a = store.accounts[key];
  if (a) { a.label = (label || '').trim().slice(0, 40) || null; storeDirty = true; saveStore(); }
  return pollLimits();
});

// ---------- Übernahme: Sitzungen aus anderen Terminal-Fenstern holen ----------
const TERM_APPS = /^(gnome-terminal-|ptyxis|kgx|tilix|terminator|konsole|xfce4-terminal|kitty|alacritty|xterm|wezterm|foot)/;
const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash']);
const pending = new Map(); // claude-pid -> { cancelled }

const alive = (pid) => fs.existsSync(`/proc/${pid}`);
function readSess(pid) { try { return JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', `${pid}.json`), 'utf8')); } catch { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procCwd = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } };
const ppidOf = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return +s.slice(s.lastIndexOf(')') + 2).split(' ')[1]; } catch { return 0; } };

function ownPids(t) {
  const own = new Set();
  const stack = [...ptys.values()].map((p) => p.pid);
  while (stack.length) { const p = stack.pop(); own.add(p); stack.push(...(t.kids.get(p) || [])); }
  return own;
}
function descendants(pid, t) {
  const out = [], stack = [...(t.kids.get(pid) || [])];
  while (stack.length) { const p = stack.pop(); out.push(p); stack.push(...(t.kids.get(p) || [])); }
  return out;
}
// Gehört die Shell direkt zu einem Terminal-Fenster? Dann schließt SIGHUP den Tab.
const isTabShell = (pid, t) => SHELLS.has(t.comm.get(pid)) && TERM_APPS.test(t.comm.get(ppidOf(pid)) || '');

ipcMain.handle('takeover:list', () => {
  const t = procTable();
  const own = ownPids(t);
  const claudes = [], shells = [];
  let files = [];
  try { files = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')).filter((f) => /^\d+\.json$/.test(f)); } catch {}
  const claudePids = new Set();
  for (const f of files) {
    const pid = +f.split('.')[0];
    if (own.has(pid) || t.comm.get(pid) !== 'claude') continue;
    const s = readSess(pid);
    if (!s || s.kind !== 'interactive') continue;
    claudePids.add(pid);
    const tr = transcriptPath(s);
    const u = tr ? readUsage(tr) : {};
    claudes.push({ pid, sessionId: s.sessionId, cwd: s.cwd, name: s.name, status: s.status,
      title: u.title, model: u.model, ctx: u.ctx, hasTranscript: !!tr, pending: pending.has(pid),
      inTerminal: TERM_APPS.test(t.comm.get(ppidOf(ppidOf(pid))) || '') || TERM_APPS.test(t.comm.get(ppidOf(pid)) || '') });
  }
  for (const [pid, name] of t.comm) {
    if (own.has(pid) || !isTabShell(pid, t)) continue;
    const kids = descendants(pid, t);
    if (kids.some((k) => claudePids.has(k))) continue; // schon als Claude-Sitzung gelistet
    const running = [...new Set(kids.map((k) => t.comm.get(k)).filter(Boolean))];
    shells.push({ pid, shell: name, cwd: procCwd(pid), running });
  }
  claudes.sort((a, b) => (a.cwd || '').localeCompare(b.cwd || ''));
  return { claudes, shells };
});

// Claude beenden (wartet optional, bis die Sitzung bereit ist), alten Tab schließen, Startbefehl liefern
ipcMain.handle('takeover:claude', async (_e, { pid, wait }) => {
  let s = readSess(pid);
  if (!s || !alive(pid)) return { error: 'Sitzung läuft nicht mehr' };
  if (wait && s.status !== 'idle') {
    const job = { cancelled: false };
    pending.set(pid, job);
    while (!job.cancelled && alive(pid) && (readSess(pid)?.status ?? 'idle') !== 'idle') await sleep(1000);
    pending.delete(pid);
    if (job.cancelled) return { cancelled: true };
    if (!alive(pid)) return { error: 'Sitzung wurde inzwischen beendet' };
    s = readSess(pid) || s;
  }
  // ursprüngliche Startoptionen übernehmen (ohne resume/continue)
  let args = [];
  try { args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(1); } catch {}
  const keep = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-c', '--continue'].includes(a)) continue;
    if (['-r', '--resume', '--session-id'].includes(a)) { if (args[i + 1] && !args[i + 1].startsWith('-')) i++; continue; }
    if (/^--(resume|session-id)=/.test(a)) continue;
    keep.push(a);
  }
  const shellPid = ppidOf(pid);
  const t = procTable();
  const closeTab = isTabShell(shellPid, t);
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} await sleep(200); }
  if (closeTab) { try { process.kill(shellPid, 'SIGHUP'); } catch {} }
  const q = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
  const resume = transcriptPath(s) ? ['--resume', s.sessionId] : []; // leere Sitzung: neu starten
  return { cwd: s.cwd, cmd: ['claude', ...keep.map(q), ...resume].join(' ') };
});
ipcMain.on('takeover:cancel', (_e, pid) => { const j = pending.get(pid); if (j) j.cancelled = true; });

// Shell übernehmen: nur wenn darin nichts läuft → alten Tab schließen
ipcMain.handle('takeover:shell', (_e, { pid, close }) => {
  const cwd = procCwd(pid);
  if (close) {
    const t = procTable();
    if (isTabShell(pid, t) && !(t.kids.get(pid) || []).length) { try { process.kill(pid, 'SIGHUP'); } catch {} }
  }
  return { cwd };
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  for (const p of ptys.values()) { try { p.kill(); } catch {} }
  app.quit();
});
