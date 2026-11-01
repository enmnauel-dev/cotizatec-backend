// patch-fase3-backend.js — Fase 3 backend: guardias de permiso + rate limit de login
// (no rompe compatibilidad con la app actual; no requiere APK nuevo)
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

// A) limitador en memoria (anti fuerza bruta / abuso)
patch('A: helper rateLimited',
"function requireClient(req, res) {",
`// ===== Limitador de intentos en memoria (anti fuerza bruta) =====
// Render corre una sola instancia, asi que un Map basta; se limpia solo.
const _rl = new Map();
function rateLimited(req, res, bucket, max, windowMs) {
  const ip = String((req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '?');
  const key = bucket + '|' + ip;
  const now = Date.now();
  const rec = _rl.get(key);
  if (!rec || now > rec.reset) { _rl.set(key, { n: 1, reset: now + windowMs }); return false; }
  rec.n++;
  if (rec.n > max) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((rec.reset - now) / 1000))));
    return true;
  }
  return false;
}
setInterval(function () { const t = Date.now(); _rl.forEach(function (v, k) { if (t > v.reset) _rl.delete(k); }); }, 10 * 60 * 1000).unref();

function requireClient(req, res) {`);

// B) login: max 8 intentos por usuario+IP cada 15 minutos
patch('B: limiter en login',
"app.post('/api/client/login', async (req, res) => {\n  try {\n    const username = String(req.body.username || '').trim();",
"app.post('/api/client/login', async (req, res) => {\n  try {\n    const username = String(req.body.username || '').trim();\n    if (rateLimited(req, res, 'login:' + username.toLowerCase(), 8, 15 * 60 * 1000)) {\n      return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.', code: 'RATE_LIMITED' });\n    }");

// C) guardia server-side: conduces rechazados si el dueno tiene el permiso OFF
patch('C: guardia conduces',
"app.post('/api/device/:deviceId/conduces', (req, res) => {",
`app.post('/api/device/:deviceId/conduces', (req, res) => {
  // Defensa en profundidad: aunque el telefono deba respetar el permiso (app),
  // el servidor rechaza subidas de conduces si el dueno lo tiene desactivado.
  const _cliC = store.getClientByDeviceId(String(req.params.deviceId || '').trim());
  if (_cliC && _cliC.operatorPermissions && _cliC.operatorPermissions.canCreateConduce === false) {
    console.log('[device] conduces rechazados por permiso OFF: ' + req.params.deviceId);
    return res.status(403).json({ error: 'El dueño tiene desactivado el permiso de crear conduces.', code: 'PERM_DENIED' });
  }`);

// D) guardia analogica: entradas de inventario si canRegisterStockEntry OFF
patch('D: guardia stock-entries',
"app.post('/api/device/:deviceId/stock-entries', (req, res) => {",
`app.post('/api/device/:deviceId/stock-entries', (req, res) => {
  const _cliS = store.getClientByDeviceId(String(req.params.deviceId || '').trim());
  if (_cliS && _cliS.operatorPermissions && _cliS.operatorPermissions.canRegisterStockEntry === false) {
    console.log('[device] stock-entries rechazadas por permiso OFF: ' + req.params.deviceId);
    return res.status(403).json({ error: 'El dueño tiene desactivado el permiso de registrar entradas de inventario.', code: 'PERM_DENIED' });
  }`);

// E) mojibake que quedaba en el mensaje de error de login
patch('E: fix mojibake login',
"res.status(500).json({ error: 'Error al iniciar sesiÃ³n.' });",
"res.status(500).json({ error: 'Error al iniciar sesión.' });");

if (fails > 0) {
  console.log('ABORTADO: ' + fails + ' fallos. Archivo NO modificado.');
  process.exit(1);
}
try { new Function(s); } catch (e) { console.log('ABORTADO sintaxis: ' + e.message); process.exit(1); }
if (eraCRLF) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(ARCHIVO, s, 'utf8');
console.log('Fase 3 backend aplicada. Guardado: ' + ARCHIVO);
