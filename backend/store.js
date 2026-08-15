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
    cache = { devices: {}, licenses: {} };
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
    if (devices) cache.devices = devices;
    if (licenses) cache.licenses = licenses;
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

module.exports = {
  init,
  registerDevice,
  setLicense,
  getLicense,
  removeLicense,
  allLicenses,
  deviceCount,
  licenseCount
};