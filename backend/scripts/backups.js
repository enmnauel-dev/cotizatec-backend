// Administración manual de respaldos en la nube.
//
// Replica el cifrado de la app (AES-256-GCM + PBKDF2 con la clave del deviceId)
// para poder VER y RESTAURAR respaldos manualmente desde el servidor.
//
// Uso:
//   node scripts/backups.js list                       -> lista todos los respaldos
//   node scripts/backups.js view <deviceId>            -> descifra y muestra un respaldo
//   node scripts/backups.js restore <deviceId> <archivo>  -> sube un respaldo cifrado desde un archivo
//   node scripts/backups.js delete <deviceId>          -> elimina un respaldo
//
// NOTA: solo descifra respaldos cifrados con la clave del deviceId (formato
// normal de la app). El deviceId debe ser EXACTAMENTE el que usa la app.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { webcrypto } = require('node:crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CLOUD_SECRET = 'cotizatec-cloud-backup-v1';
const ENC_ITER = 120000;
const SALT_B64 = 'Y290aXphdGVjLWNsb3VkLXNhbHQ=';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function unb64(s) {
  return new Uint8Array(Buffer.from(s, 'base64').toString('binary').split('').map(function (c) { return c.charCodeAt(0); }));
}
function b64(buf) { return Buffer.from(buf).toString('base64'); }

// Usa WebCrypto (igual que la app) porque la app cifra con el tag GCM embebido.
async function cloudKey(deviceId) {
  const sub = webcrypto.subtle;
  const mat = await sub.importKey('raw', new TextEncoder().encode(CLOUD_SECRET + '::' + deviceId), 'PBKDF2', false, ['deriveKey']);
  return sub.deriveKey(
    { name: 'PBKDF2', salt: unb64(SALT_B64), iterations: ENC_ITER, hash: 'SHA-256' },
    mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// El respaldo en la nube tiene doble capa:
//   1) gzip + base64 (capa externa que produce la app antes de subir)
//   2) dentro: JSON { enc:'aes-gcm', iv, ct } cifrado con la clave del deviceId
function unwrapEnv(envStr) {
  let text = envStr;
  // Si la capa externa es gzip base64 (empieza por H4sI), descomprimir.
  if (/^[A-Za-z0-9+/]+=*$/.test(envStr.trim()) && envStr.startsWith('H4sI')) {
    try {
      const gz = Buffer.from(envStr, 'base64');
      text = zlib.gunzipSync(gz).toString('utf8');
    } catch (e) {
      throw new Error('capa gzip inválida: ' + e.message);
    }
  }
  let env;
  try { env = JSON.parse(text); } catch (e) { throw new Error('respaldo no es JSON tras descomprimir: ' + e.message); }
  return env;
}

async function decryptData(deviceId, envStr) {
  const env = unwrapEnv(envStr);
  if (!env || env.enc !== 'aes-gcm' || !env.iv || !env.ct) throw new Error('formato de respaldo no reconocido');
  const key = await cloudKey(deviceId);
  const buf = await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.ct));
  return new TextDecoder().decode(buf);
}

async function list() {
  const r = await pool.query('SELECT device_id, saved_at, size FROM cotizatec_backups ORDER BY saved_at DESC');
  if (!r.rows.length) { console.log('(no hay respaldos en la nube)'); return; }
  console.log('RESPALDOS EN LA NUBE (' + r.rows.length + '):');
  console.log('---------------------------------------------------------');
  r.rows.forEach(row => {
    const ts = row.saved_at ? new Date(Number(row.saved_at)).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '?';
    console.log('  ' + row.device_id);
    console.log('    tamaño: ' + row.size + ' caracteres · guardado: ' + ts);
  });
}

async function view(deviceId) {
  const r = await pool.query('SELECT data FROM cotizatec_backups WHERE device_id = $1', [deviceId]);
  if (!r.rows.length) { console.log('No hay respaldo para ' + deviceId); return; }
  console.log('Respaldo de ' + deviceId + ' (' + r.rows[0].data.length + ' caracteres cifrados)');
  console.log('Descifrando con la clave del deviceId...');
  const json = await decryptData(deviceId, r.rows[0].data);
  let obj;
  try { obj = JSON.parse(json); } catch (e) { obj = null; }
  if (!obj) { console.log('Contenido (texto plano):'); console.log(json.slice(0, 2000)); return; }
  const d = obj && obj.format === 'cotizatec-backup' && obj.data ? obj.data : obj;
  console.log('---------------------------------------------------------');
  console.log('Formato: ' + (obj.format || 'estado plano'));
  console.log('Exportado: ' + (obj.exportedAt || '?'));
  console.log('Negocio: ' + (d.settings && d.settings.businessName || '?'));
  console.log('Clientes: ' + (d.clients || []).length);
  console.log('Catálogo: ' + (d.catalog || []).length);
  console.log('Trabajos/cotizaciones: ' + (d.jobs || []).length);
  console.log('');
  console.log('— Detalle clientes —');
  (d.clients || []).forEach(c => console.log('  ' + (c.name || '?') + (c.phone ? ' · ' + c.phone : '')));
  console.log('— Detalle catálogo —');
  (d.catalog || []).forEach(i => console.log('  ' + (i.name || '?') + ' · ' + (i.price || 0)));
  console.log('— Detalle trabajos —');
  (d.jobs || []).forEach(j => console.log('  ' + (j.code || '?') + ' · ' + (j.clientName || '') + ' · ' + (j.status || '')));
}

async function restore(deviceId, file) {
  if (!file) throw new Error('Falta la ruta del archivo de respaldo (JSON sin cifrar o cifrado).');
  const raw = fs.readFileSync(file, 'utf8');
  let env;
  try { env = unwrapEnv(raw); } catch (e) { env = null; }
  let data;
  if (env && env.enc === 'aes-gcm') {
    // Ya cifrado -> se asume que la clave coincide con deviceId. Re-comprimir como la app.
    console.log('El archivo ya viene cifrado. Se sube tal cual bajo ' + deviceId + '.');
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(env), 'utf8'));
    data = gz.toString('base64');
  } else {
    // Texto plano (buildBackup de la app) -> cifrarlo con la clave del deviceId y comprimir.
    console.log('Archivo en texto plano. Cifrando con la clave de ' + deviceId + '...');
    const iv = new Uint8Array(12);
    webcrypto.getRandomValues(iv);
    const key = await cloudKey(deviceId);
    const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(raw));
    const env2 = { enc: 'aes-gcm', v: 1, iv: b64(iv), ct: b64(ct) };
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(env2), 'utf8'));
    data = gz.toString('base64');
  }
  const savedAt = Date.now();
  await pool.query(
    'INSERT INTO cotizatec_backups (device_id, data, saved_at, size) VALUES ($1, $2, $3, $4) ON CONFLICT (device_id) DO UPDATE SET data = EXCLUDED.data, saved_at = EXCLUDED.saved_at, size = EXCLUDED.size',
    [deviceId, data, savedAt, data.length]
  );
  console.log('✅ Respaldo restaurado para ' + deviceId + ' (' + data.length + ' caracteres).');
  console.log('El usuario solo debe abrir la app con ese dispositivo y los datos aparecerán.');
}

async function del(deviceId) {
  const r = await pool.query('DELETE FROM cotizatec_backups WHERE device_id = $1', [deviceId]);
  console.log(r.rowCount ? '✅ Respaldo de ' + deviceId + ' eliminado.' : 'No había respaldo para ' + deviceId);
}

(async () => {
  const args = process.argv.slice(2);
  const cmd = (args[0] || '').toLowerCase();
  try {
    if (cmd === 'list') await list();
    else if (cmd === 'view' && args[1]) await view(args[1]);
    else if (cmd === 'restore' && args[1] && args[2]) await restore(args[1], args[2]);
    else if (cmd === 'delete' && args[1]) await del(args[1]);
    else {
      console.log('Uso:');
      console.log('  node scripts/backups.js list');
      console.log('  node scripts/backups.js view <deviceId>');
      console.log('  node scripts/backups.js restore <deviceId> <archivo>');
      console.log('  node scripts/backups.js delete <deviceId>');
    }
  } catch (e) {
    console.error('Error: ' + e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();