// patch-analytics-api.js — conecta webanalytics.js al servidor (Fase 1, corregido)
const fs = require('fs');
const ARCHIVO = 'backend/server.js';
let s = fs.readFileSync(ARCHIVO, 'utf8');
const eraCRLF = s.indexOf('\r\n') >= 0;
if (eraCRLF) s = s.replace(/\r\n/g, '\n');
let fails = 0;

function patch(name, from, to) {
  const i = s.indexOf(from);
  if (i < 0) { console.log('MISS : ' + name); fails++; return; }
  if (s.indexOf(from, i + 1) >= 0) { console.log('DUP  : ' + name); fails++; return; }
  s = s.slice(0, i) + to + s.slice(i + from.length);
  console.log('OK   : ' + name);
}

patch('A: require webanalytics',
  "const webclients = require('./webclients');",
  "const webanalytics = require('./webanalytics');\nconst webclients = require('./webclients');"
);

const endpoints = [
"// ===== Analiticas / rotacion / alertas (solo owner; lectura pura) =====",
"app.get('/api/client/analytics', async (req, res) => {",
"  const auth = requireOwner(req, res);",
"  if (!auth) return;",
"  try {",
"    const data = await readClientData(auth.account.clientId);",
"    if (!data.ok || !data.state) return res.json({ ok: true, hasData: false, analytics: null, syncedAt: data.syncedAt || null });",
"    const client = store.getClient(auth.account.clientId) || {};",
"    const prefs = client.analyticsPrefs || {};",
"    let days = Number(req.query.days);",
"    if (!isFinite(days) || days <= 0) days = prefs.deadDays || 60;",
"    let low = Number(req.query.low);",
"    if (req.query.low == null || req.query.low === '' || !isFinite(low) || low < 0) low = (prefs.lowStock == null ? 3 : prefs.lowStock);",
"    const analytics = webanalytics.computeAnalytics(data.state, { deadDays: days, lowStockDefault: low, minStock: prefs.minStock || {} });",
"    res.json({ ok: true, hasData: true, analytics: analytics, prefs: prefs, syncedAt: data.syncedAt || null });",
"  } catch (e) { console.error('[client] analytics error:', e.message); res.status(500).json({ error: 'Error al calcular analiticas.' }); }",
"});",
"",
"app.get('/api/client/analytics-prefs', (req, res) => {",
"  const auth = requireOwner(req, res);",
"  if (!auth) return;",
"  const client = store.getClient(auth.account.clientId) || {};",
"  res.json({ ok: true, prefs: client.analyticsPrefs || { deadDays: 60, lowStock: 3, minStock: {} } });",
"});",
"",
"app.put('/api/client/analytics-prefs', (req, res) => {",
"  const auth = requireOwner(req, res);",
"  if (!auth) return;",
"  const client = store.getClient(auth.account.clientId);",
"  if (!client) return res.status(404).json({ error: 'Negocio no encontrado.' });",
"  const p = req.body || {};",
"  let dd = Number(p.deadDays); if (!isFinite(dd) || dd < 7) dd = 60; if (dd > 3650) dd = 3650;",
"  let ls = Number(p.lowStock); if (!isFinite(ls) || ls < 0) ls = 3; if (ls > 999) ls = 999;",
"  const ms = {};",
"  if (p.minStock && typeof p.minStock === 'object') {",
"    Object.keys(p.minStock).slice(0, 300).forEach(function (k) {",
"      const v = Number(p.minStock[k]);",
"      if (isFinite(v) && v >= 0 && v <= 999 && String(k).length <= 60) ms[String(k)] = Math.round(v);",
"    });",
"  }",
"  client.analyticsPrefs = { deadDays: Math.round(dd), lowStock: Math.round(ls), minStock: ms };",
"  client.updatedAt = Date.now();",
"  store.updateClient(client.id, { analyticsPrefs: client.analyticsPrefs, updatedAt: client.updatedAt });",
"  res.json({ ok: true, prefs: client.analyticsPrefs });",
"});",
"",
""
].join('\n');

patch('B: endpoints analytics',
  "app.post('/api/client/users', async (req, res) => {",
  endpoints + "app.post('/api/client/users', async (req, res) => {"
);

if (fails > 0) {
  console.log('ABORTADO: ' + fails + ' fallos. Archivo NO modificado.');
  process.exit(1);
}
try { new Function(s); } catch (e) { console.log('ABORTADO sintaxis: ' + e.message); process.exit(1); }
if (eraCRLF) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(ARCHIVO, s, 'utf8');
console.log('API de analiticas lista. Guardado: ' + ARCHIVO);