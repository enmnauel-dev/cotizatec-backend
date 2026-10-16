const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const rawDatabaseUrl = process.env.DATABASE_URL || '';
// Interruptor de emergencia: con PG_DISABLED=1 se desactiva PostgreSQL por
// completo (se usa el archivo/respaldo en memoria) sin borrar DATABASE_URL.
const PG_DISABLED = /^(1|true|yes|on)$/i.test(String(process.env.PG_DISABLED || ''));
const DATABASE_URL = PG_DISABLED ? '' : rawDatabaseUrl;

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => {
  if (isPgFatalErr(err)) { pgDownMark(err); return; }
  if (isPgConnErr(err)) { pgDownMark(err); return; }
  console.error('[pg] Error en cliente inactivo:', err.message);
});
pool.on('connect', () => { pgUpMark(); console.log('[pg] Conectado al pool'); });

let retryDelay = 1000;
const MAX_RETRY_DELAY = 30000;

// Cortacircuitos: si PostgreSQL falla por conexion (p. ej. el host del
// DATABASE_URL ya no existe), dejamos de intentar en cada operacion y avisamos
// UNA sola vez, en vez de inundar los logs. Se reintenta en segundo plano.
let pgDown = false;
let pgDownLogged = false;
let pgDownUntil = 0;
const PG_COOLDOWN = 60000;

function isPgConnErr(e) {
  return /ENOTFOUND|getaddrinfo|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|terminated|disconnect|pg_hba|password authentication/i.test(String(e && e.message || ''));
}

function isPgFatalErr(e) {
  // Errores "permanentes": reintentar no sirve (host inexistente, rechazo).
  return /ENOTFOUND|getaddrinfo|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|pg_hba|password authentication/i.test(String(e && e.message || ''));
}

function pgDownMark(e) {
  pgDown = true;
  pgDownUntil = Date.now() + PG_COOLDOWN;
  if (!pgDownLogged) {
    console.error('[pg] PostgreSQL no disponible: ' + (e && e.message) + '. Se usa respaldo en memoria y se reintenta en segundo plano.');
    pgDownLogged = true;
  }
}

function pgUpMark() {
  if (pgDown) console.log('[pg] PostgreSQL reconectado');
  pgDown = false;
  pgDownLogged = false;
  pgDownUntil = 0;
}

// Registro de errores de PostgreSQL que respeta el cortacircuitos: si ya
// avisamos de que la BD esta caida, no repetimos el mensaje en cada operacion.
function pgErr(tag, e) {
  if (pgDown) return;
  console.error('[pg] ' + tag + ':', e && e.message);
}

async function pgQuery(text, params) {
  // Cortacircuitos abierto: devolvemos un resultado vacio para que quien llame
  // use su respaldo (memoria/archivo) sin lanzar ni escribir en los logs.
  if (pgDown && Date.now() < pgDownUntil) return { rows: [] };
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await pool.query(text, params);
      pgUpMark();
      return r;
    } catch (e) {
      lastErr = e;
      if (!isPgConnErr(e)) throw e; // error real de SQL: que se vea
      pgDownMark(e);
      if (isPgFatalErr(e)) return { rows: [] }; // host inexistente: no reintentar
      const delay = Math.min(retryDelay, MAX_RETRY_DELAY);
      await new Promise(r => setTimeout(r, delay));
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY);
    }
  }
  pgDownMark(lastErr);
  return { rows: [] };
}

async function pgGet(key) {
  const r = await pgQuery('SELECT v FROM cotizatec_data WHERE k = $1', [key]);
  return r.rows.length ? r.rows[0].v : null;
}

// Contador monotono por clave: detecta si hubo una escritura local mientras
// loadFromPg() leia PostgreSQL, para no pisar datos frescos con una copia vieja.
const dirtySeq = {};

// Copia en memoria de los respaldos. Sirve de respaldo (valga la redundancia)
// cuando PostgreSQL falla: asi el panel web sigue mostrando datos mientras la
// app siga subiendo (cada 60s) y no se pierde silenciosamente lo recibido.
const backupCache = {};

async function pgSet(key, val) {
  dirtySeq[key] = (dirtySeq[key] || 0) + 1;
  await pgQuery('INSERT INTO cotizatec_data (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [key, JSON.stringify(val)]);
}

let cache = null;
let cacheMtime = 0;

function ensureShape(c) {
  if (!c.devices) c.devices = {};
  if (!c.licenses) c.licenses = {};
  if (!c.blocked) c.blocked = {};
  if (!c.clients) c.clients = [];
  if (!c.backups) c.backups = {};
  if (!c.claims) c.claims = {};
  if (!c.documents) c.documents = [];
  if (!c.gps) c.gps = {};
  return c;
}

function load() {
  // Con PostgreSQL configurado, la BD es la fuente de verdad y la mantenemos en
  // memoria (loadFromPg la refresca). El archivo en disco es efimero en el
  // hosting gratuito, asi que no lo usamos para no resucitar datos viejos.
  if (DATABASE_URL) {
    if (!cache) cache = {};
    return ensureShape(cache);
  }
  let mtime = 0;
  try { mtime = fs.statSync(DATA_FILE).mtimeMs; } catch (e) { /* no file yet */ }
  if (cache && cacheMtime === mtime) return cache;
  cacheMtime = mtime;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    cache = { devices: {}, licenses: {}, blocked: {}, clients: [] };
  }
  return ensureShape(cache);
}

function save() {
  if (DATABASE_URL) return; // PostgreSQL es la fuente de verdad.
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ===== Cuentas web de clientes (usuario + contraseña) =====
function listWebAccounts() {
  const db = load();
  if (!db.webAccounts) db.webAccounts = {};
  return db.webAccounts;
}

function saveWebAccounts(accounts) {
  const db = load();
  db.webAccounts = accounts;
  save();
  if (DATABASE_URL) {
    pgSet('webAccounts', accounts).catch(function (e) { console.error('[pg] save webAccounts:', e.message); });
  }
}

function getWebAccountByUsername(username) {
  const clean = String(username || '').toLowerCase().trim();
  const accounts = listWebAccounts();
  return accounts[clean] || null;
}

function getWebAccountById(anyId) {
  const accounts = listWebAccounts();
  const list = Object.keys(accounts).map((k) => accounts[k]);
  return list.find((a) => a.userId && String(a.userId) === String(anyId)) ||
         list.find((a) => String(a.clientId) === String(anyId)) || null;
}

// Todos los usuarios web de un negocio (clientId). Cada usuario lleva
// userId, role (owner/empleado), status (activo/inactivo) y deviceId para
// preparar la futura identidad por operador.
function listWebAccountsByClient(clientId) {
  const accounts = listWebAccounts();
  return Object.keys(accounts)
    .map((k) => accounts[k])
    .filter((a) => a.clientId === clientId)
    .sort((a, b) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0) || (a.name || '').localeCompare(b.name || ''));
}

function countWebAccountsByClient(clientId) {
  const accounts = listWebAccounts();
  return Object.keys(accounts).filter((k) => accounts[k].clientId === clientId).length;
}

// ===== GPS / rastreo de flota =====
// Última posición reportada por cada operador (web account) de un negocio.
// Clave: businessId -> { username: { lat, lon, acc, speed, ts } }
function getGpsMap(clientId) {
  const db = load();
  return (db.gps && db.gps[clientId]) || {};
}

function setGpsPosition(clientId, userKey, pos) {
  const db = load();
  if (!db.gps) db.gps = {};
  if (!db.gps[clientId]) db.gps[clientId] = {};
  db.gps[clientId][String(userKey)] = pos;
  save();
  if (DATABASE_URL) {
    pgSet('gps', db.gps).catch(function (e) { console.error('[pg] save gps:', e.message); });
  }
  return pos;
}

function setWebAccount(username, account) {
  const accounts = listWebAccounts();
  // Garantizar el userId (identidad única por usuario) y el rol por defecto.
  if (!account.userId) account.userId = 'u-' + Math.random().toString(36).slice(2, 10);
  accounts[String(username).toLowerCase().trim()] = account;
  saveWebAccounts(accounts);
  return account;
}

function setWebAccountPasswordByUserId(userId, newHash) {
  const accounts = listWebAccounts();
  const list = Object.keys(accounts);
  let hit = null;
  list.forEach((k) => {
    if (accounts[k].userId && String(accounts[k].userId) === String(userId)) { accounts[k].passHash = newHash; accounts[k].updatedAt = Date.now(); hit = accounts[k]; }
  });
  if (hit) saveWebAccounts(accounts);
  return hit;
}

function updateWebAccount(userId, updates) {
  const accounts = listWebAccounts();
  let hit = null;
  Object.keys(accounts).forEach((k) => {
    if (accounts[k].userId && String(accounts[k].userId) === String(userId)) {
      Object.keys(updates).forEach((field) => { accounts[k][field] = updates[field]; });
      accounts[k].updatedAt = Date.now();
      hit = accounts[k];
    }
  });
  if (hit) saveWebAccounts(accounts);
  return hit;
}

function registerDevice(deviceId, meta) {
  const db = load();
  if (!db.devices[deviceId]) {
    db.devices[deviceId] = {
      deviceId,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      meta: meta || {}
    };
  } else {
    db.devices[deviceId].lastSeen = Date.now();
  }
  save();
  if (DATABASE_URL) {
    pgSet('devices', db.devices).catch(function (e) { console.error('[pg] save devices:', e.message); });
  }
  return db.devices[deviceId];
}

function setLicense(deviceId, license) {
  const db = load();
  db.licenses[deviceId] = license;
  save();
  if (DATABASE_URL) {
    pgSet('licenses', db.licenses).catch(function (e) { console.error('[pg] save licenses:', e.message); });
  }
  return license;
}

function getLicense(deviceId) {
  const db = load();
  return db.licenses[deviceId] || null;
}

function removeLicense(deviceId) {
  const db = load();
  delete db.licenses[deviceId];
  save();
  if (DATABASE_URL) {
    pgSet('licenses', db.licenses).catch(function (e) { console.error('[pg] save licenses:', e.message); });
  }
}

function allLicenses() {
  return load().licenses;
}

async function loadFromPg() {
  if (!DATABASE_URL) return;
  if (!cache) load();
  try {
    const snap = Object.assign({}, dirtySeq);
    const devices = await pgGet('devices');
    const licenses = await pgGet('licenses');
    const clients = await pgGet('clients');
    const blocked = await pgGet('blocked');
    const gps = await pgGet('gps');
    const webAccounts = await pgGet('webAccounts');
    const documents = await pgGet('documents');
    // Solo aplicamos una clave si no hubo escrituras locales durante la lectura:
    // asi una licencia recien activada no se pierde por una copia desactualizada.
    const apply = (key, val) => {
      if (val == null) return;
      if ((dirtySeq[key] || 0) !== (snap[key] || 0)) return;
      cache[key] = val;
    };
    apply('devices', devices);
    apply('licenses', licenses);
    apply('clients', clients);
    apply('blocked', blocked);
    apply('gps', gps);
    apply('webAccounts', webAccounts);
    apply('documents', documents);
    if (!cache.blocked) cache.blocked = {};
  } catch (e) {
    console.error('[pg] load:', e.message);
  }
}

function gzipB64(str) {
  return zlib.gzipSync(Buffer.from(String(str), 'utf8')).toString('base64');
}

function gunzipB64(b64) {
  return zlib.gunzipSync(Buffer.from(String(b64), 'base64')).toString('utf8');
}

async function pgBackupSet(deviceId, data) {
  await pgQuery(
    'INSERT INTO cotizatec_backups (device_id, data, saved_at, size) VALUES ($1, $2, $3, $4) ON CONFLICT (device_id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at, size = EXCLUDED.size',
    [deviceId, gzipB64(data), Date.now(), String(data || '').length]
  );
}

async function pgBackupGet(deviceId) {
  const r = await pgQuery('SELECT data, saved_at, size FROM cotizatec_backups WHERE device_id = $1', [deviceId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { savedAt: Number(row.saved_at), size: Number(row.size), data: gunzipB64(row.data) };
}

async function pgBackupDelete(deviceId) {
  await pgQuery('DELETE FROM cotizatec_backups WHERE device_id = $1', [deviceId]);
}

// Migra backups guardados como una sola fila JSONB en cotizatec_data hacia la
// tabla separada cotizatec_backups (una fila por dispositivo).
async function migrateLegacyBackups() {
  if (!DATABASE_URL) return;
  try {
    const old = await pgGet('backups');
    if (!old || typeof old !== 'object') return;
    const keys = Object.keys(old);
    for (const k of keys) {
      const rec = old[k];
      if (rec && typeof rec.data === 'string') {
        await pgBackupSet(k, rec.data);
      }
    }
    if (keys.length) {
      await pgQuery('DELETE FROM cotizatec_data WHERE k = $1', ['backups']);
      console.log('[pg] migrados ' + keys.length + ' backups a tabla separada');
    }
  } catch (e) {
    console.error('[pg] migrate backups:', e.message);
  }
}

// Crea las tablas si no existen. Esto evita que las escrituras fallen en
// silencio (p. ej. si la base de datos se creo sin la tabla de respaldos),
// que era justo lo que provocaba que el panel web mostrara todo en ceros.
async function ensureSchema() {
  if (!DATABASE_URL) return;
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS cotizatec_data (k TEXT PRIMARY KEY, v JSONB)');
    await pool.query('CREATE TABLE IF NOT EXISTS cotizatec_backups (device_id TEXT PRIMARY KEY, data TEXT, saved_at BIGINT, size INTEGER)');
    pgUpMark();
    console.log('[pg] esquema verificado');
  } catch (e) {
    if (isPgConnErr(e)) pgDownMark(e); else console.error('[pg] ensureSchema:', e.message);
  }
}

// Diagnostico: informa si PostgreSQL esta configurado y responde. Usa el pool
// directamente (omite el cortacircuitos) para poder detectar la reconexion, y
// no escribe en los logs para no generar ruido.
async function pgHealth() {
  if (!DATABASE_URL) return { configured: false, ok: false };
  try {
    await pool.query('SELECT 1');
    pgUpMark();
    return { configured: true, ok: true };
  } catch (e) {
    if (isPgConnErr(e)) pgDownMark(e);
    return { configured: true, ok: false, error: e.message };
  }
}

async function init() {
  if (!DATABASE_URL) return;
  load();
  await ensureSchema();
  await loadFromPg().catch((e) => pgErr('load', e));
  await migrateLegacyBackups().catch((e) => pgErr('migrate', e));
  schedulePgRefresh();
}

let pgRefreshBusy = false;
let pgRefreshInterval = 5000;

function schedulePgRefresh() {
  setTimeout(async () => {
    if (pgRefreshBusy) {
      schedulePgRefresh();
      return;
    }
    pgRefreshBusy = true;
    try {
      if (pgDown) {
        // La BD esta caida: no cargamos (evita ruido) y solo sondeamos para
        // detectar cuando vuelva. pgHealth() no escribe en los logs.
        const h = await pgHealth();
        if (h.ok) {
          await ensureSchema();
          await loadFromPg();
        }
      } else {
        await loadFromPg();
        pgRefreshInterval = 5000;
      }
    } catch (e) {
      pgErr('refresh', e);
      pgRefreshInterval = Math.min(pgRefreshInterval * 2, 60000);
    }
    pgRefreshBusy = false;
    schedulePgRefresh();
  }, pgDown ? 60000 : pgRefreshInterval);
}

function deviceCount() {
  return Object.keys(load().devices).length;
}

function licenseCount() {
  return Object.keys(load().licenses).length;
}

function allDevices() {
  return load().devices;
}

function removeDevice(deviceId) {
  const db = load();
  const had = !!db.devices[deviceId];
  delete db.devices[deviceId];
  delete db.licenses[deviceId];
  delete db.blocked[deviceId];
  db.clients = (db.clients || []).map((c) => {
    c.devices = (c.devices || []).filter((d) => d.deviceId !== deviceId);
    return c;
  });
  if (db.backups) delete db.backups[deviceId];
  delete backupCache[deviceId];
  if (DATABASE_URL) {
    pgBackupDelete(deviceId).catch(function (e) { console.error('[pg] delete backup:', e.message); });
  }
  if (had) {
    save();
    if (DATABASE_URL) {
      pgSet('devices', db.devices).catch(function (e) { console.error('[pg] save devices:', e.message); });
      pgSet('licenses', db.licenses).catch(function (e) { console.error('[pg] save licenses:', e.message); });
      pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
      pgSet('blocked', db.blocked).catch(function (e) { console.error('[pg] save blocked:', e.message); });
    }
  }
  return had;
}

function blockDevice(deviceId) {
  const db = load();
  db.blocked[deviceId] = Date.now();
  delete db.licenses[deviceId];
  save();
  if (DATABASE_URL) {
    pgSet('blocked', db.blocked).catch(function (e) { console.error('[pg] save blocked:', e.message); });
    pgSet('licenses', db.licenses).catch(function (e) { console.error('[pg] save licenses:', e.message); });
  }
}

function unblockDevice(deviceId) {
  const db = load();
  const had = !!db.blocked[deviceId];
  delete db.blocked[deviceId];
  if (had) {
    save();
    if (DATABASE_URL) {
      pgSet('blocked', db.blocked).catch(function (e) { console.error('[pg] save blocked:', e.message); });
    }
  }
  return had;
}

function isBlocked(deviceId) {
  return !!((load().blocked || {})[deviceId]);
}

function blockedCount() {
  return Object.keys(load().blocked || {}).length;
}

function clientId() {
  return 'cl-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function listClients() {
  return load().clients || [];
}

function getClient(clientKey) {
  const db = load();
  if (!db.clients) return null;
  return db.clients.find((c) => c.id === clientKey) || null;
}

function createClient(data) {
  const db = load();
  if (!db.clients) db.clients = [];
  const client = {
    id: clientId(),
    name: String(data.name || '').trim(),
    phone: String(data.phone || '').trim(),
    plan: String(data.plan || 'Básico').trim(),
    modules: Array.isArray(data.modules) && data.modules.length
      ? data.modules.slice()
      : ['cotizaciones', 'clientes', 'ventas', 'reportes'],
    planLimit: data.planLimit != null ? parseInt(data.planLimit, 10) : null,
    createdAt: Date.now(),
    devices: []
  };
  db.clients.push(client);
  save();
  if (DATABASE_URL) {
    pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
  }
  return client;
}

function updateClient(clientKey, patch) {
  const db = load();
  const c = getClient(clientKey);
  if (!c) return null;
  if (typeof patch.name === 'string') c.name = patch.name.trim();
  if (typeof patch.phone === 'string') c.phone = patch.phone.trim();
  if (typeof patch.plan === 'string') c.plan = String(patch.plan).trim();
  if (Array.isArray(patch.modules)) c.modules = patch.modules.slice();
  if (patch.planLimit !== undefined) c.planLimit = patch.planLimit != null ? parseInt(patch.planLimit, 10) : null;
  save();
  if (DATABASE_URL) {
    pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
  }
  return c;
}

function removeClient(clientKey) {
  const db = load();
  if (!db.clients) return false;
  const before = db.clients.length;
  db.clients = db.clients.filter((c) => c.id !== clientKey);
  save();
  if (DATABASE_URL) {
    pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
  }
  return db.clients.length !== before;
}

// ¿El deviceId ya está vinculado a OTRO cliente (distinto de clientKey)?
function deviceInOtherClient(clientKey, deviceId) {
  const db = load();
  const clean = String(deviceId || '').trim();
  if (!clean) return null;
  const found = (db.clients || []).find((c) => c.id !== clientKey && (c.devices || []).some((d) => d.deviceId === clean));
  return found || null;
}

// ¿A qué cliente pertenece un deviceId? (null si no está vinculado)
function getClientByDeviceId(deviceId) {
  const db = load();
  const clean = String(deviceId || '').trim();
  if (!clean) return null;
  return (db.clients || []).find((c) => (c.devices || []).some((d) => d.deviceId === clean)) || null;
}

function addDeviceToClient(clientKey, deviceId, alias) {
  const db = load();
  const c = getClient(clientKey);
  if (!c) return null;
  const clean = String(deviceId || '').trim();
  if (!clean) return null;
  const existing = c.devices.find((d) => d.deviceId === clean);
  if (existing) {
    if (alias) existing.alias = String(alias).trim();
    save();
    return c;
  }
  c.devices.push({ deviceId: clean, alias: String(alias || '').trim() || null });
  save();
  if (DATABASE_URL) {
    pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
  }
  return c;
}

function removeDeviceFromClient(clientKey, deviceId) {
  const db = load();
  const c = getClient(clientKey);
  if (!c) return null;
  c.devices = c.devices.filter((d) => d.deviceId !== deviceId);
  save();
  if (DATABASE_URL) {
    pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
  }
  return c;
}

async function setBackup(deviceId, data) {
  const rec = {
    savedAt: Date.now(),
    size: String(data || '').length,
    data: data
  };
  if (DATABASE_URL) {
    try {
      await pgBackupSet(deviceId, data);
    } catch (e) {
      console.error('[pg] save backup (se conserva en memoria):', e.message);
    }
    // Guardamos SIEMPRE una copia en memoria como respaldo.
    backupCache[deviceId] = rec;
    return rec;
  }
  const db = load();
  if (!db.backups) db.backups = {};
  db.backups[deviceId] = rec;
  save();
  return rec;
}

async function getBackup(deviceId) {
  if (DATABASE_URL) {
    try {
      const rec = await pgBackupGet(deviceId);
      if (rec) return rec;
    } catch (e) {
      console.error('[pg] load backup:', e.message);
    }
    // Si PostgreSQL no tiene (o fallo), usamos la copia en memoria.
    return backupCache[deviceId] || null;
  }
  return (load().backups || {})[deviceId] || null;
}

// ===== Migración entre dispositivos (por "reclamo") =====
// El respaldo está cifrado con una clave derivada del deviceId viejo, por lo
// que NO se puede mover el blob al deviceId nuevo (el nuevo no podría
// descifrarlo). En su lugar se guarda un "reclamo": nuevoId -> viejoId.
// El equipo nuevo descarga el respaldo bajo el ID viejo, lo descifra con la
// clave del viejo, lo re-cifra con su propia clave y lo vuelve a subir.

async function pgClaimSet(newId, oldId) {
  await pgQuery('INSERT INTO cotizatec_data (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', ['claim:' + newId, JSON.stringify({ old: oldId })]);
}

async function pgClaimGet(newId) {
  const r = await pgQuery('SELECT v FROM cotizatec_data WHERE k = $1', ['claim:' + newId]);
  return r.rows.length ? (r.rows[0].v && r.rows[0].v.old) || null : null;
}

async function pgClaimDelete(newId) {
  await pgQuery('DELETE FROM cotizatec_data WHERE k = $1', ['claim:' + newId]);
}

async function setClaim(newId, oldId) {
  if (DATABASE_URL) {
    try { await pgClaimSet(newId, oldId); } catch (e) { console.error('[pg] set claim:', e.message); }
    return;
  }
  const db = load();
  if (!db.claims) db.claims = {};
  db.claims[newId] = oldId;
  save();
}

async function getClaim(newId) {
  if (DATABASE_URL) {
    try { return await pgClaimGet(newId); } catch (e) { console.error('[pg] get claim:', e.message); return null; }
  }
  return (load().claims || {})[newId] || null;
}

async function clearClaim(newId) {
  if (DATABASE_URL) {
    try { await pgClaimDelete(newId); } catch (e) { console.error('[pg] clear claim:', e.message); }
    return;
  }
  const db = load();
  if (db.claims) delete db.claims[newId];
  save();
}

// ===== Documentos generados desde el portal web (por negocio) =====
function listDocumentsByClient(clientId) {
  const db = load();
  if (!db.documents) db.documents = [];
  return db.documents.filter((d) => String(d.businessId) === String(clientId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getDocument(docId) {
  const db = load();
  return (db.documents || []).find((d) => String(d.id) === String(docId)) || null;
}

function addDocument(doc) {
  const db = load();
  if (!db.documents) db.documents = [];
  db.documents.push(doc);
  save();
  if (DATABASE_URL) {
    pgSet('documents', db.documents).catch(function (e) { console.error('[pg] save documents:', e.message); });
  }
  return doc;
}

function removeDocument(docId) {
  const db = load();
  const before = db.documents ? db.documents.length : 0;
  db.documents = (db.documents || []).filter((d) => String(d.id) !== String(docId));
  if (db.documents.length !== before) {
    save();
    if (DATABASE_URL) {
      pgSet('documents', db.documents).catch(function (e) { console.error('[pg] save documents:', e.message); });
    }
  }
}

// Registra el reclamo de migración y mueve la licencia (solo si es real, no
// trial). El respaldo queda intacto bajo el ID viejo. Devuelve { backupExists }.
async function migrateDevice(fromId, toId) {
  if (String(fromId) === String(toId)) return { backupExists: false };
  const src = await getBackup(fromId);
  const backupExists = !!src;
  const oldLic = getLicense(fromId);
  if (oldLic && !oldLic.trial) {
    setLicense(toId, oldLic);
    removeLicense(fromId);
  }
  await setClaim(toId, fromId);
  return { backupExists, licenseMoved: !!(oldLic && !oldLic.trial) };
}

// Tras restaurar el respaldo en el equipo nuevo (re-cifrado con su propia
// clave), se elimina el respaldo del equipo viejo y el reclamo. La licencia ya
// se movió en migrateDevice. Devuelve true si se limpió algo.
async function resolveMigration(toId) {
  const oldId = await getClaim(toId);
  if (!oldId) return false;
  delete backupCache[oldId];
  if (DATABASE_URL) {
    await pgBackupDelete(oldId).catch(function (e) { console.error('[pg] delete migrated backup:', e.message); });
  } else {
    const db = load();
    if (db.backups) delete db.backups[oldId];
    save();
  }
  await clearClaim(toId);
  return true;
}

module.exports = {
  init,
  registerDevice,
  setLicense,
  getLicense,
  removeLicense,
  allLicenses,
  deviceCount,
  licenseCount,
  listClients,
  listWebAccounts,
  getWebAccountByUsername,
  getWebAccountById,
  setWebAccount,
  listWebAccountsByClient,
  countWebAccountsByClient,
  setWebAccountPasswordByUserId,
  updateWebAccount,
  getClient,
  createClient,
  updateClient,
  removeClient,
  addDeviceToClient,
  removeDeviceFromClient,
  deviceInOtherClient,
  getClientByDeviceId,
  allDevices,
  removeDevice,
  blockDevice,
  unblockDevice,
  isBlocked,
  blockedCount,
  setBackup,
  getBackup,
  ensureSchema,
  pgHealth,
  migrateDevice,
  resolveMigration,
  getClaim,
  setClaim,
  clearClaim,
  listDocumentsByClient,
  getDocument,
  addDocument,
  removeDocument,
  getGpsMap,
  setGpsPosition
};