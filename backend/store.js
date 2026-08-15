const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DATABASE_URL = process.env.DATABASE_URL || '';

let pg = null;
let pool = null;

async function pgQuery(text, params) {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS cotizatec_data (k text PRIMARY KEY, v jsonb NOT NULL)');
  }
  return pool.query(text, params);
}

async function pgGet(key) {
  const r = await pgQuery('SELECT v FROM cotizatec_data WHERE k = $1', [key]);
  return r.rows.length ? r.rows[0].v : null;
}

async function pgSet(key, val) {
  await pgQuery('INSERT INTO cotizatec_data (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [key, JSON.stringify(val)]);
}

let cache = null;
let cacheMtime = 0;

function load() {
  let mtime = 0;
  try { mtime = fs.statSync(DATA_FILE).mtimeMs; } catch (e) { /* no file yet */ }
  if (cache && cacheMtime === mtime) return cache;
  cacheMtime = mtime;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    cache = { devices: {}, licenses: {}, clients: [] };
  }
  return cache;
}

function save() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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
  try {
    const devices = await pgGet('devices');
    const licenses = await pgGet('licenses');
    const clients = await pgGet('clients');
    if (devices) cache.devices = devices;
    if (licenses) cache.licenses = licenses;
    if (clients) cache.clients = clients;
  } catch (e) {
    console.error('[pg] load:', e.message);
  }
}

async function init() {
  if (!DATABASE_URL) return;
  load();
  await loadFromPg();
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
  db.clients = (db.clients || []).map((c) => {
    c.devices = (c.devices || []).filter((d) => d.deviceId !== deviceId);
    return c;
  });
  if (had) {
    save();
    if (DATABASE_URL) {
      pgSet('devices', db.devices).catch(function (e) { console.error('[pg] save devices:', e.message); });
      pgSet('licenses', db.licenses).catch(function (e) { console.error('[pg] save licenses:', e.message); });
      pgSet('clients', db.clients).catch(function (e) { console.error('[pg] save clients:', e.message); });
    }
  }
  return had;
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
  getClient,
  createClient,
  updateClient,
  removeClient,
  addDeviceToClient,
  removeDeviceFromClient,
  allDevices,
  removeDevice
};