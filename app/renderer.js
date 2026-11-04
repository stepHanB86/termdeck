// termdeck – Renderer: Kachel-Layout als Binärbaum
// node = { type:'split', dir:'row'|'col', ratio, a, b } | { type:'leaf', id }
'use strict';

const rootEl = document.getElementById('root');
const dropEl = document.getElementById('drop-indicator');
const ghostEl = document.getElementById('drag-ghost');

const panes = new Map(); // leafId -> { id, ptyId, term, fit, el, titleEl, title, cwd }
const byPty = new Map(); // ptyId -> pane
let tree = null;
let focusedId = null;
let zoomedId = null;
let nextLeaf = 1;
let fontSize = 13;
const SHOT = new URLSearchParams(location.search).has('shot');
const SINGLE = +new URLSearchParams(location.search).get('single') || 0; // gelöstes Einzelfenster
if (SINGLE) document.body.classList.add('single');

const THEME = {
  background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
  black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7',
  magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6', brightBlack: '#414868', brightRed: '#f7768e',
  brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff', brightWhite: '#c0caf5',
};

// ---------- Baum-Helfer ----------
const leaf = (id) => ({ type: 'leaf', id });
const split = (dir, a, b, ratio = 0.5) => ({ type: 'split', dir, ratio, a, b });

function leaves(node, out = []) {
  if (!node) return out;
  if (node.type === 'leaf') out.push(node.id); else { leaves(node.a, out); leaves(node.b, out); }
  return out;
}
function replaceNode(node, target, repl) {
  if (node === target) return repl;
  if (node.type === 'split') { node.a = replaceNode(node.a, target, repl); node.b = replaceNode(node.b, target, repl); }
  return node;
}
function findLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.a, id) || findLeaf(node.b, id);
}
function removeLeaf(node, id) {
  if (!node) return null;
  if (node.type === 'leaf') return node.id === id ? null : node;
  const a = removeLeaf(node.a, id), b = removeLeaf(node.b, id);
  if (!a) return b;
  if (!b) return a;
  node.a = a; node.b = b; return node;
}
// Ausgewogenes Raster aus einer Liste von Blättern
function buildGrid(ids, w, h) {
  const n = ids.length;
  if (!n) return null;
  const cols = Math.ceil(Math.sqrt(n * (w / h) / 1.6)) || 1;
  const nCols = Math.min(Math.max(cols, 1), n);
  const groups = [];
  let i = 0;
  for (let c = 0; c < nCols; c++) {
    const size = Math.floor(n / nCols) + (c < n % nCols ? 1 : 0);
    groups.push(ids.slice(i, i + size)); i += size;
  }
  const chain = (items, dir) => {
    if (items.length === 1) return items[0];
    const k = Math.floor(items.length / 2);
    return split(dir, chain(items.slice(0, k), dir), chain(items.slice(k), dir), k / items.length);
  };
  return chain(groups.map((g) => chain(g.map(leaf), 'col')), 'row');
}

// ---------- Terminals ----------
async function createPane(cwd, cmd, attach) {
  const id = nextLeaf++;
  const el = document.createElement('div');
  el.className = 'leaf';
  el.innerHTML = `<div class="head"><span class="dot"></span><span class="title">Terminal</span><span class="ai" hidden></span>
    <button class="b-detach" title="${SINGLE ? 'Zurück ins Dashboard andocken' : 'Als eigenes Fenster lösen'}">${SINGLE ? '⇲' : '⇱'}</button>
    <button class="b-zoom" title="Maximieren (Strg+Shift+Enter)">⤢</button>
    <button class="b-close" title="Schließen (Strg+Shift+W)">✕</button></div><div class="term"></div>`;
  const termEl = el.querySelector('.term');
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'DejaVu Sans Mono', 'Ubuntu Mono', monospace",
    fontSize, theme: THEME, scrollback: 10000, allowProposedApi: true, cursorBlink: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const ser = new SerializeAddon.SerializeAddon();
  term.loadAddon(ser);
  const pane = { id, term, fit, el, titleEl: el.querySelector('.title'), aiEl: el.querySelector('.ai'), ai: null, ser, title: '', cwd, ptyId: null };
  panes.set(id, pane);
  term.open(termEl);
  if (!SHOT) try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}

  term.attachCustomKeyEventHandler((e) => handleKey(e, pane));
  term.onData((d) => pane.ptyId && deck.write(pane.ptyId, d));
  term.onResize(({ cols, rows }) => pane.ptyId && deck.resize(pane.ptyId, cols, rows));
  term.onTitleChange((t) => { pane.title = t; updateTitle(pane); });
  term.onBell(() => { if (focusedId !== id) el.classList.add('bell'); });
  term.onSelectionChange(() => { const s = term.getSelection(); if (s) deck.clipWrite(s, 'selection'); });
  term.textarea?.addEventListener('focus', () => setFocus(id));
  termEl.addEventListener('mousedown', () => setFocus(id));
  termEl.addEventListener('auxclick', async (e) => { if (e.button === 1) term.paste(await deck.clipRead('selection')); });
  termEl.addEventListener('contextmenu', async (e) => {
    e.preventDefault();
    const s = term.getSelection();
    if (s) { deck.clipWrite(s); term.clearSelection(); } else term.paste(await deck.clipRead());
  });

  const head = el.querySelector('.head');
  head.addEventListener('mousedown', (e) => { if (e.button === 0 && !SINGLE && !e.target.closest('button, .ai')) startDrag(e, id); });
  el.querySelector('.b-detach').onclick = () => (SINGLE ? dockBack(id) : detachPane(id));
  pane.aiEl.addEventListener('mousedown', (e) => e.stopPropagation());
  pane.aiEl.addEventListener('click', (e) => openModelMenu(pane, e));
  head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) toggleZoom(id); });
  el.querySelector('.b-close').onclick = () => closePane(id);
  el.querySelector('.b-zoom').onclick = () => toggleZoom(id);

  new ResizeObserver(() => fitPane(pane)).observe(termEl);

  if (attach) {
    pane.ptyId = attach.ptyId;
    pane.title = attach.title || '';
    byPty.set(pane.ptyId, pane);
    const init = await attach.init();
    if (init?.data) term.write(init.data);
    if (init?.pending) term.write(init.pending);
    if (init?.cwd) pane.cwd = init.cwd;
  } else {
    pane.ptyId = await deck.createPty({ cols: 80, rows: 24, cwd });
    byPty.set(pane.ptyId, pane);
  }
  fitPane(pane);
  if (cmd) deck.write(pane.ptyId, cmd + '\r');
  updateTitle(pane);
  return id;
}

function fitPane(pane) {
  if (!pane.el.isConnected || pane.el.offsetWidth === 0) return;
  try { pane.fit.fit(); } catch {}
}
function updateTitle(pane) {
  const t = pane.title || (pane.cwd ? pane.cwd.replace(/^\/home\/[^/]+/, '~') : 'Terminal');
  pane.titleEl.textContent = t;
  pane.el.title = '';
  if (SINGLE) { deck.setTitle(t); document.title = t; }
}

deck.onData((ptyId, data) => {
  const p = byPty.get(ptyId);
  if (!p) return;
  p.term.write(data);
  if (focusedId !== p.id) p.el.classList.add('unseen');
});
deck.onExit((ptyId) => { const p = byPty.get(ptyId); if (p) closePane(p.id, true); });

// ---------- Lösen / Andocken ----------
async function packPane(p) {
  await deck.hold(p.ptyId);                         // Ausgabe puffern
  await new Promise((r) => p.term.write('', r));    // bereits empfangene Ausgabe fertig verarbeiten
  return { data: p.ser.serialize({ scrollback: 3000 }), title: p.title, cwd: p.cwd };
}
async function detachPane(id) {
  const p = panes.get(id);
  if (!p?.ptyId || SINGLE) return;
  const payload = await packPane(p);
  deck.detach(p.ptyId, payload);
  dropPane(id);
}
async function dockBack(id) {
  const p = panes.get(id);
  if (!p?.ptyId) return;
  deck.dock(p.ptyId, await packPane(p));
}
// Kachel entfernen, ohne das Terminal zu beenden
function dropPane(id) {
  const p = panes.get(id);
  byPty.delete(p.ptyId);
  p.ptyId = null;
  closePane(id, true);
}
deck.onAdopt(async (ptyId, payload) => {
  await newTerminal({ attach: { ptyId, title: payload?.title, init: async () => ({ ...(await deck.adoptInit(ptyId)), data: payload?.data }) } });
});

function setFocus(id) {
  if (focusedId === id) return;
  focusedId = id;
  for (const p of panes.values()) p.el.classList.toggle('focused', p.id === id);
  const p = panes.get(id);
  if (p) { p.el.classList.remove('unseen', 'bell'); p.term.focus(); }
}

// ---------- Aktionen ----------
async function newTerminal(opts) {
  if (!opts || opts instanceof Event) opts = {};
  const ref = panes.get(focusedId);
  const cwd = opts.attach ? null : opts.cwd || (ref?.ptyId ? await deck.cwd(ref.ptyId) : null);
  const id = await createPane(cwd, opts.cmd, opts.attach);
  if (!tree) tree = leaf(id);
  else {
    const target = (zoomedId && findLeaf(tree, zoomedId)) || findLeaf(tree, focusedId) || tree;
    const rect = target.type === 'leaf' ? panes.get(target.id).el.getBoundingClientRect() : rootEl.getBoundingClientRect();
    const dir = rect.width / 1.6 >= rect.height ? 'row' : 'col';
    tree = replaceNode(tree, target, split(dir, target, leaf(id)));
  }
  zoomedId = null;
  render();
  setFocus(id);
}

function closePane(id, exited = false) {
  const p = panes.get(id);
  if (!p) return;
  if (!exited && p.ptyId) deck.kill(p.ptyId);
  byPty.delete(p.ptyId);
  p.term.dispose();
  p.el.remove();
  panes.delete(id);
  tree = removeLeaf(tree, id);
  if (zoomedId === id) zoomedId = null;
  if (focusedId === id) { focusedId = null; const next = leaves(tree)[0]; render(); if (next) setFocus(next); }
  else render();
  if (!tree) { if (SINGLE) window.close(); else newTerminal(); }
}

function toggleZoom(id) {
  zoomedId = zoomedId === id ? null : id;
  render();
  setFocus(id);
}

function balance() {
  const r = rootEl.getBoundingClientRect();
  tree = buildGrid(leaves(tree), r.width, r.height);
  zoomedId = null;
  render();
}

function moveFocus(dx, dy) {
  const cur = panes.get(focusedId);
  if (!cur) return;
  const a = cur.el.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestD = Infinity;
  for (const p of panes.values()) {
    if (p.id === cur.id) continue;
    const b = p.el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const vx = bx - ax, vy = by - ay;
    if (vx * dx + vy * dy <= 0) continue;
    const d = Math.abs(vx * dx + vy * dy) + 2 * Math.abs(vx * dy - vy * dx);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) { if (zoomedId) { zoomedId = null; render(); } setFocus(best.id); }
}

function setFontSize(s) {
  fontSize = Math.min(28, Math.max(8, s));
  for (const p of panes.values()) { p.term.options.fontSize = fontSize; fitPane(p); }
  saveSoon();
}

// ---------- Tastatur ----------
function handleKey(e, pane) {
  if (e.type !== 'keydown') return true;
  const k = e.key.toLowerCase();
  if (e.ctrlKey && e.shiftKey) {
    if (k === 't') { newTerminal(); return false; }
    if (k === 'w') { closePane(focusedId); return false; }
    if (k === 'b') { balance(); return false; }
    if (k === 'o') { openTakeover(); return false; }
    if (k === 'enter') { toggleZoom(focusedId); return false; }
    if (k === 'c' && pane) { const s = pane.term.getSelection(); if (s) deck.clipWrite(s); return false; }
    if (k === 'v' && pane) { deck.clipRead().then((t) => pane.term.paste(t)); return false; }
  }
  if (e.ctrlKey && !e.shiftKey && (k === '+' || k === '=')) { setFontSize(fontSize + 1); return false; }
  if (e.ctrlKey && !e.shiftKey && k === '-') { setFontSize(fontSize - 1); return false; }
  if (e.ctrlKey && !e.shiftKey && k === '0') { setFontSize(13); return false; }
  if (e.altKey && !e.ctrlKey && k.startsWith('arrow')) {
    const d = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] }[k];
    moveFocus(...d); return false;
  }
  if (e.key === 'F11') { deck.toggleFullscreen(); return false; }
  return true;
}
window.addEventListener('keydown', (e) => { if (!e.target.closest?.('.xterm') && handleKey(e, panes.get(focusedId)) === false) e.preventDefault(); });

// ---------- Rendern ----------
function render() {
  // Blatt-Elemente bleiben erhalten und werden nur umgehängt
  const build = (node, parentSplit) => {
    if (node.type === 'leaf') {
      const el = panes.get(node.id).el;
      el.classList.toggle('zoomed', node.id === zoomedId);
      return el;
    }
    const s = document.createElement('div');
    s.className = `split ${node.dir}`;
    const ca = document.createElement('div'); ca.className = 'child';
    const cb = document.createElement('div'); cb.className = 'child';
    ca.style.flex = `${node.ratio} 1 0`; cb.style.flex = `${1 - node.ratio} 1 0`;
    const dv = document.createElement('div'); dv.className = 'divider';
    dv.addEventListener('mousedown', (e) => startResize(e, node, s, ca, cb, dv));
    dv.addEventListener('dblclick', () => { node.ratio = 0.5; render(); });
    ca.appendChild(build(node.a)); cb.appendChild(build(node.b));
    s.append(ca, dv, cb);
    return s;
  };
  const frag = tree ? build(tree) : document.createDocumentFragment();
  rootEl.replaceChildren(frag);
  requestAnimationFrame(() => { for (const p of panes.values()) fitPane(p); });
  saveSoon();
}

// ---------- Größe ändern ----------
function startResize(e, node, s, ca, cb, dv) {
  e.preventDefault();
  const rect = s.getBoundingClientRect();
  const horiz = node.dir === 'row';
  const total = horiz ? rect.width : rect.height;
  const minPx = horiz ? 160 : 90;
  document.body.classList.add(horiz ? 'resizing-row' : 'resizing-col');
  dv.classList.add('active');
  const move = (ev) => {
    const pos = horiz ? ev.clientX - rect.left : ev.clientY - rect.top;
    const r = Math.min(Math.max(pos / total, minPx / total), 1 - minPx / total);
    node.ratio = r;
    ca.style.flex = `${r} 1 0`; cb.style.flex = `${1 - r} 1 0`;
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    document.body.classList.remove('resizing-row', 'resizing-col'); dv.classList.remove('active');
    saveSoon();
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

// ---------- Drag & Drop ----------
function startDrag(e, srcId) {
  const sx = e.clientX, sy = e.clientY;
  let active = false, drop = null;
  const move = (ev) => {
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      active = true;
      document.body.classList.add('dragging');
      detachEl.style.display = 'flex';
      ghostEl.textContent = panes.get(srcId).titleEl.textContent;
      ghostEl.style.display = 'block';
      if (zoomedId) { zoomedId = null; render(); }
    }
    ghostEl.style.left = ev.clientX + 12 + 'px'; ghostEl.style.top = ev.clientY + 12 + 'px';
    drop = computeDrop(ev.clientX, ev.clientY, srcId);
    detachEl.classList.toggle('hot', !!drop?.detach);
    if (!drop || drop.detach) { dropEl.style.display = 'none'; return; }
    const r = drop.rect;
    Object.assign(dropEl.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const up = () => {
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
    document.body.classList.remove('dragging');
    ghostEl.style.display = 'none'; dropEl.style.display = 'none';
    detachEl.style.display = 'none'; detachEl.classList.remove('hot');
    if (active && drop?.detach) detachPane(srcId);
    else if (active && drop) applyDrop(srcId, drop);
    else setFocus(srcId);
  };
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
}

const detachEl = document.getElementById('detach-zone');
function computeDrop(x, y, srcId) {
  // Lösen: in die Zone oben ziehen oder aus dem Fenster hinaus
  const dz = detachEl.getBoundingClientRect();
  if (y <= dz.bottom || x <= 0 || y <= 0 || x >= innerWidth - 1 || y >= innerHeight - 1) return { detach: true };
  for (const p of panes.values()) {
    if (p.id === srcId) continue;
    const r = p.el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    let zone = 'center';
    if (!(fx > 0.3 && fx < 0.7 && fy > 0.3 && fy < 0.7)) {
      const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
      zone = Object.keys(d).reduce((a, b) => (d[a] <= d[b] ? a : b));
    }
    const rect = { left: r.left, top: r.top, width: r.width, height: r.height };
    if (zone === 'left') rect.width /= 2;
    if (zone === 'right') { rect.width /= 2; rect.left += rect.width; }
    if (zone === 'top') rect.height /= 2;
    if (zone === 'bottom') { rect.height /= 2; rect.top += rect.height; }
    return { targetId: p.id, zone, rect };
  }
  return null;
}

function applyDrop(srcId, { targetId, zone }) {
  if (zone === 'center') {
    const a = findLeaf(tree, srcId), b = findLeaf(tree, targetId);
    a.id = targetId; b.id = srcId;
  } else {
    tree = removeLeaf(tree, srcId);
    const t = findLeaf(tree, targetId);
    const dir = zone === 'left' || zone === 'right' ? 'row' : 'col';
    const first = zone === 'left' || zone === 'top';
    tree = replaceNode(tree, t, first ? split(dir, leaf(srcId), t) : split(dir, t, leaf(srcId)));
  }
  render();
  setFocus(srcId);
}

// ---------- Sitzung ----------
let saveTimer = null;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
function save() {
  if (SINGLE) return;
  const ser = (n) => n && (n.type === 'leaf'
    ? { type: 'leaf', ptyId: panes.get(n.id)?.ptyId, cwd: panes.get(n.id)?.cwd }
    : { type: 'split', dir: n.dir, ratio: n.ratio, a: ser(n.a), b: ser(n.b) });
  deck.saveSession({ fontSize, tree: ser(tree) });
}
setInterval(save, 15000);
window.addEventListener('beforeunload', save);

async function restore() {
  if (SINGLE) {
    const id = await createPane(null, null, { ptyId: SINGLE, init: () => deck.singleInit(SINGLE) });
    tree = leaf(id); render(); setFocus(id);
    return;
  }
  const s = await deck.loadSession();
  if (s?.fontSize) fontSize = s.fontSize;
  const build = async (n) => {
    if (!n) return null;
    if (n.type === 'leaf') return leaf(await createPane(n.cwd, n.claude ? `claude --resume ${n.claude}` : null));
    return split(n.dir, await build(n.a), await build(n.b), n.ratio);
  };
  tree = s?.tree ? await build(s.tree) : null;
  if (!tree) tree = leaf(await createPane(null));
  render();
  setFocus(leaves(tree)[0]);
}

// ---------- KI-Status ----------
const MODELS = [
  ['claude-opus-5-5', 'Opus 5.5', 'stärkstes Modell'],
  ['claude-sonnet-5-5', 'Sonnet 5.5', 'schnell & gut'],
  ['claude-haiku-5-5', 'Haiku 5.5', 'am schnellsten, günstig'],
  ['claude-fable-5-1', 'Fable 5.1', ''],
];
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n || 0));
const shortModel = (m) => (m || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-.*)?$/, ' $1.$2');
const aiSummary = document.getElementById('ai-summary');

deck.onAiStatus((all) => {
  let n = 0, busy = 0, ctx = 0, nCodex = 0;
  for (const p of panes.values()) {
    const a = all[p.ptyId] || null;
    p.ai = a;
    p.aiEl.hidden = !a;
    if (!a) continue;
    n++; ctx += a.ctx || 0;
    const working = a.status && a.status !== 'idle';
    if (working) busy++;
    const agent = a.agent || 'claude';
    if (agent === 'codex') nCodex++;
    p.aiEl.className = `ai ${agent} ${working ? 'busy' : 'idle'}`;
    const ctxTxt = a.ctxMax ? `${kfmt(a.ctx)}/${kfmt(a.ctxMax)}` : kfmt(a.ctx);
    p.aiEl.innerHTML = `<i></i><em>${agent}</em><b>${esc(shortModel(a.model) || '…')}</b><span>${ctxTxt} ctx · ${kfmt(a.out)} out</span>`;
    p.aiEl.title = `${agent === 'codex' ? 'Codex' : 'Claude Code'} (${working ? 'arbeitet' : 'bereit'})${a.name ? ' – ' + a.name : ''}\n` +
      `Modell: ${a.model || '?'}\nKontext aktuell: ${(a.ctx || 0).toLocaleString('de')} Tokens${a.ctxMax ? ' von ' + a.ctxMax.toLocaleString('de') : ''}\n` +
      `Ausgabe gesamt: ${(a.out || 0).toLocaleString('de')} Tokens${a.account ? '\nKonto: ' + a.account : ''}\nKlick: Modell wechseln`;
  }
  aiSummary.hidden = !n;
  aiSummary.innerHTML = n ? `<b>${n}</b> agent${n > 1 ? 's' : ''}${nCodex ? ` <small>(${n - nCodex} claude · ${nCodex} codex)</small>` : ''} · <b class="${busy ? 'busy' : ''}">${busy}</b> aktiv · <b>${kfmt(ctx)}</b> ctx` : '';
});

const menuEl = document.getElementById('menu');
function openModelMenu(pane, e) {
  e.stopPropagation();
  const cur = pane.ai?.model;
  if (pane.ai?.agent === 'codex') {
    menuEl.innerHTML = '<div class="m-head">Codex</div><button data-codex="1"><b>Modell-Auswahl öffnen</b><span>tippt /model in Codex</span></button>';
    const r = pane.aiEl.getBoundingClientRect();
    Object.assign(menuEl.style, { display: 'block', left: Math.min(r.left, innerWidth - 230) + 'px', top: r.bottom + 4 + 'px' });
    menuEl.onclick = () => { closeMenu(); deck.write(pane.ptyId, '/model\r'); setFocus(pane.id); pane.term.focus(); };
    return;
  }
  menuEl.innerHTML = '<div class="m-head">Modell wechseln</div>' + MODELS.map(([id, name, d]) =>
    `<button data-id="${id}" class="${id === cur ? 'cur' : ''}"><b>${name}</b><span>${d}</span></button>`).join('');
  const r = pane.aiEl.getBoundingClientRect();
  Object.assign(menuEl.style, { display: 'block', left: Math.min(r.left, innerWidth - 230) + 'px', top: r.bottom + 4 + 'px' });
  menuEl.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.id !== cur) deck.write(pane.ptyId, `/model ${b.dataset.id}\r`);
    setFocus(pane.id); pane.term.focus();
  };
}
function closeMenu() { menuEl.style.display = 'none'; }
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) closeMenu(); });

// ---------- Übernehmen ----------
const takeEl = document.getElementById('takeover');
const waiting = new Map(); // pid -> name
const home = (p) => (p || '').replace(/^\/home\/[^/]+/, '~');
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STATUS = { idle: 'bereit', busy: 'arbeitet', shell: 'Hintergrund-Befehle laufen' };

async function openTakeover() {
  const { claudes, shells } = await deck.takeoverList();
  const row = (main, sub, actions) => `<div class="t-row"><div class="t-info"><div class="t-main">${main}</div><div class="t-sub">${sub}</div></div><div class="t-act">${actions}</div></div>`;
  let html = '<div class="t-head"><b>Terminals übernehmen</b><button class="t-x" data-a="close">✕</button></div>';
  html += '<div class="t-sec">Claude-Sitzungen</div>';
  html += claudes.length ? claudes.map((c) => {
    const st = c.status || '?', idle = st === 'idle';
    const main = `<span class="st ${idle ? 'idle' : 'busy'}"></span>${esc(c.title || c.name || 'Claude')}`;
    const sub = `${esc(home(c.cwd))} · ${esc(STATUS[st] || st)}${c.model ? ' · ' + esc(shortModel(c.model)) : ''}${c.ctx ? ' · ' + kfmt(c.ctx) + ' Kontext' : ''}${c.hasTranscript ? '' : ' · noch leer'}`;
    let act;
    if (waiting.has(c.pid) || c.pending) act = `<span class="t-wait">wartet …</span><button data-a="cancel" data-pid="${c.pid}">Abbrechen</button>`;
    else if (idle) act = `<button class="pri" data-a="claude" data-pid="${c.pid}">Übernehmen</button>`;
    else act = `<button class="pri" data-a="claude-wait" data-pid="${c.pid}" title="Übernimmt automatisch, sobald Claude fertig ist">Wenn fertig</button><button class="warn" data-a="claude" data-pid="${c.pid}" title="Bricht die laufende Arbeit ab!">Sofort</button>`;
    return row(main, sub, act);
  }).join('') : '<div class="t-empty">Keine Claude-Sitzung außerhalb von termdeck.</div>';
  html += '<div class="t-sec">Andere Terminals</div>';
  html += shells.length ? shells.map((sh) => {
    const busy = sh.running.length > 0;
    const sub = busy ? `läuft: ${esc(sh.running.join(', '))} – bleibt offen, nur der Ordner wird geöffnet` : `${esc(sh.shell)} · nichts läuft – altes Fenster wird geschlossen`;
    return row(`<span class="st ${busy ? 'busy' : 'idle'}"></span>${esc(home(sh.cwd))}`, sub,
      `<button class="pri" data-a="shell" data-pid="${sh.pid}" data-close="${busy ? '' : '1'}">${busy ? 'Ordner öffnen' : 'Übernehmen'}</button>`);
  }).join('') : '<div class="t-empty">Keine weiteren Terminals gefunden.</div>';
  takeEl.innerHTML = `<div class="t-box">${html}</div>`;
  takeEl.style.display = 'flex';
}
function closeTakeover() { takeEl.style.display = 'none'; panes.get(focusedId)?.term.focus(); }

takeEl.addEventListener('click', async (e) => {
  if (e.target === takeEl) return closeTakeover();
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const pid = +b.dataset.pid, a = b.dataset.a;
  if (a === 'close') return closeTakeover();
  if (a === 'cancel') { deck.takeoverCancel(pid); waiting.delete(pid); updateWaiting(); return openTakeover(); }
  if (a === 'shell') {
    const r = await deck.takeoverShell(pid, !!b.dataset.close);
    closeTakeover(); return newTerminal({ cwd: r.cwd });
  }
  if (a === 'claude' || a === 'claude-wait') {
    const wait = a === 'claude-wait';
    b.disabled = true;
    if (wait) { waiting.set(pid, b.closest('.t-row').querySelector('.t-main').textContent); updateWaiting(); openTakeover(); }
    else closeTakeover();
    const r = await deck.takeoverClaude(pid, wait);
    waiting.delete(pid); updateWaiting();
    if (r.cancelled) return;
    if (r.error) { flash(r.error); return; }
    await newTerminal({ cwd: r.cwd, cmd: r.cmd });
    if (takeEl.style.display === 'flex') openTakeover();
  }
});
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && takeEl.style.display === 'flex') closeTakeover(); }, true);

const waitEl = document.getElementById('waiting');
function updateWaiting() {
  waitEl.hidden = !waiting.size;
  waitEl.textContent = `⏳ ${waiting.size} wartet auf Übernahme`;
  waitEl.title = [...waiting.values()].join('\n');
}
waitEl.onclick = openTakeover;
function flash(msg) {
  const f = document.createElement('div'); f.className = 'flash'; f.textContent = msg;
  document.body.appendChild(f); setTimeout(() => f.remove(), 4000);
}

// ---------- Limits (Session/Woche je Anbieter) ----------
const limitsEl = document.getElementById('limits');
const limitsPop = document.getElementById('limits-pop');
let limitsData = null;
const level = (pc) => (pc >= 90 ? 'crit' : pc >= 70 ? 'warn' : 'ok');
function until(ts) {
  if (!ts) return '';
  let m = Math.max(0, Math.round((ts - Date.now()) / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); m %= 60;
  if (h < 24) return `${h}h${String(m).padStart(2, '0')}`;
  return `${Math.floor(h / 24)}T ${h % 24}h`;
}
const ago = (ts) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'gerade eben' : m < 60 ? `vor ${m} min` : m < 1440 ? `vor ${Math.round(m / 60)} h` : `vor ${Math.round(m / 1440)} T`; };
const SHORT = { Session: '5H', Woche: '7D' };
const meter = (b, big) => {
  const pc = Math.max(0, Math.min(100, Math.round(b.percent ?? 0)));
  return `<div class="meter ${level(pc)}${big ? ' big' : ''}" title="${esc(b.label)}: ${pc}% verbraucht${b.resetsAt ? ' · Reset ' + new Date(b.resetsAt).toLocaleString('de', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}">
    <span class="m-l">${big ? esc(b.label) : SHORT[b.label] || esc(b.label)}</span>
    <span class="m-bar"><i style="width:${pc}%"></i></span>
    <span class="m-v">${pc}<small>%</small></span>
    <span class="m-r">${b.resetsAt ? '↻' + until(b.resetsAt) : ''}</span></div>`;
};
const accName = (a) => a.label || a.email || `Konto ${a.idShort}`;
const shortName = (a) => { const n = a.label || (a.email ? a.email.split('@')[0] : `#${a.idShort}`); return n.length > 16 ? n.slice(0, 15) + '…' : n; };
function renderLimits() {
  const accs = limitsData?.accounts || [];
  document.getElementById('bar').classList.toggle('many', accs.length > 2);
  limitsEl.innerHTML = accs.map((a) => {
    const main = (a.bars || []).filter((b) => !b.scoped);
    const worst = Math.max(0, ...(a.bars || []).map((b) => b.percent || 0));
    return `<div class="prov ${a.active ? 'active' : 'inactive'} ${a.error && !main.length ? 'err' : ''} lv-${level(worst)}" title="${esc(a.name)} · ${esc(accName(a))}${a.plan ? ' · ' + esc(a.plan) : ''}${a.active ? ' · angemeldet' : ' · nicht angemeldet (letzter Stand)'}">
      <span class="p-name">${esc(a.name)}${a.plan ? `<small>${esc(a.plan)}</small>` : ''}<i>${a.active ? '●' : '○'} ${esc(shortName(a))}</i></span>
      ${main.length ? main.map((b) => meter(b)).join('') : `<span class="p-err">${esc(a.error || 'noch keine Daten')}</span>`}
      ${a.error && main.length ? '<span class="p-warn">!</span>' : ''}
    </div>`;
  }).join('');
  if (limitsPop.style.display === 'block') openLimitsPop();
}
let confirmKey = null, editKey = null;
function openLimitsPop() {
  const accs = limitsData?.accounts || [];
  let html = `<div class="lp-head"><b>Konten &amp; Limits</b><button data-a="refresh" title="Jetzt aktualisieren">⟳</button></div>`;
  let lastProv = null;
  for (const a of accs) {
    if (a.provider !== lastProv) { html += `<div class="lp-group">${esc(a.name)}</div>`; lastProv = a.provider; }
    const status = a.updatedAt ? (a.active && a.provider === 'claude' ? 'live · ' + ago(a.updatedAt) : 'Stand ' + ago(a.updatedAt)) : 'keine Limit-Daten';
    const nameHtml = editKey === a.key
      ? `<input class="lp-edit" data-key="${a.key}" value="${esc(a.label || '')}" placeholder="${esc(a.email || 'Name für dieses Konto')}" maxlength="40">`
      : `<span class="lp-mail">${esc(accName(a))}</span>${a.label && a.email ? `<span class="lp-sub">${esc(a.email)}</span>` : ''}`;
    const removeBtn = a.active
      ? `<button class="lp-x" disabled title="Angemeldetes Konto – zum Entfernen erst abmelden">✕</button>`
      : confirmKey === a.key
        ? `<button class="lp-x sure" data-a="remove" data-key="${a.key}">wirklich entfernen?</button>`
        : `<button class="lp-x" data-a="ask-remove" data-key="${a.key}" title="Konto entfernen">✕</button>`;
    html += `<div class="lp-prov ${a.active ? 'active' : 'inactive'}">
      <div class="lp-title">
        <span class="lp-dot">${a.active ? '●' : '○'}</span>
        <span class="lp-who">${nameHtml}</span>
        ${a.plan ? `<small>${esc(a.plan)}</small>` : ''}
        ${a.active ? '<small class="on">angemeldet</small>' : ''}
        <span class="lp-tools"><button class="lp-x" data-a="edit" data-key="${a.key}" title="Namen vergeben">✎</button>${removeBtn}</span>
      </div>
      <div class="lp-meta">${esc(status)}${a.lastSeen ? ' · zuletzt genutzt ' + ago(a.lastSeen) : ''}${a.org && !String(a.org).includes(a.email || '\u0000') ? ' · ' + esc(a.org) : ''}</div>
      ${(a.bars || []).map((b) => meter(b, true)).join('')}
      ${a.extra ? meter({ label: `Extra-Guthaben (${a.extra.used} / ${a.extra.limit} ${a.extra.currency})`, percent: a.extra.percent }, true) : ''}
      ${a.error ? `<div class="lp-err">${esc(a.error)}</div>` : ''}
    </div>`;
  }
  if (!accs.length) html += '<div class="lp-meta">Noch kein Konto gefunden.</div>';
  html += '<div class="lp-foot">● angemeldet · ○ nicht angemeldet, letzter bekannter Stand<br>Session = 5 h · Woche = 7 Tage · ↻ = Zeit bis zum Reset · ✎ = Name · ✕ = Konto entfernen</div>';
  limitsPop.innerHTML = html;
  const r = limitsEl.getBoundingClientRect();
  Object.assign(limitsPop.style, { display: 'block', top: r.bottom + 6 + 'px', right: Math.max(8, innerWidth - r.right) + 'px' });
  const inp = limitsPop.querySelector('.lp-edit');
  if (inp) { inp.focus(); inp.select(); }
}
limitsPop.addEventListener('keydown', async (e) => {
  const inp = e.target.closest('.lp-edit');
  if (!inp) return;
  e.stopPropagation();
  if (e.key === 'Enter') { editKey = null; limitsData = await deck.renameAccount(inp.dataset.key, inp.value); renderLimits(); openLimitsPop(); }
  if (e.key === 'Escape') { editKey = null; openLimitsPop(); }
});
limitsEl.addEventListener('click', (e) => { e.stopPropagation(); limitsPop.style.display === 'block' ? (limitsPop.style.display = 'none') : openLimitsPop(); });
limitsPop.addEventListener('click', async (e) => {
  e.stopPropagation();
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const key = b.dataset.key, a = b.dataset.a;
  if (a === 'refresh') { limitsData = await deck.getLimits(true); renderLimits(); }
  else if (a === 'edit') { editKey = editKey === key ? null : key; confirmKey = null; openLimitsPop(); }
  else if (a === 'ask-remove') { confirmKey = key; editKey = null; openLimitsPop(); }
  else if (a === 'remove') { confirmKey = null; limitsData = await deck.removeAccount(key); renderLimits(); openLimitsPop(); }
});
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#limits-pop, #limits')) limitsPop.style.display = 'none'; });
deck.onLimits((l) => { limitsData = l; renderLimits(); });
setInterval(renderLimits, 30000); // Countdown weiterzählen
if (!SINGLE) deck.getLimits().then((l) => { limitsData = l; renderLimits(); });

document.getElementById('btn-help').onclick = (e) => { e.stopPropagation(); document.getElementById('help').classList.toggle('open'); };
window.addEventListener('mousedown', (e) => { if (!e.target.closest('#help, #btn-help')) document.getElementById('help').classList.remove('open'); });

document.getElementById('btn-take').onclick = openTakeover;
document.getElementById('btn-new').onclick = newTerminal;
document.getElementById('btn-balance').onclick = balance;
document.getElementById('btn-full').onclick = () => deck.toggleFullscreen();
restore();
