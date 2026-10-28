// Tests automatizados de la lógica de la app (db.js + backup.js)
// Ejecutar: node test-app/run-tests.js
const s = require('./load');

const DB = s.DB;
const Backups = s.Backups;

// ---- Utilidades para simular un dispositivo con varias "sesiones" (arranques en frío) ----
const vm = require('vm');
const path = require('path');
const fsx = require('fs');
const nodeCrypto = require('crypto').webcrypto;
const DB_SRC = fsx.readFileSync(path.join(__dirname, '..', 'js', 'db.js'), 'utf8');

function makeStorage() {
  const m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
    clear: function () { m.clear(); },
    key: function (i) { return Array.from(m.keys())[i] || null; },
    get length() { return m.size; }
  };
}

function makeIdb() {
  const store = new Map();
  const dbObj = {
    transaction: function () {
      return {
        objectStore: function () {
          return {
            get: function (key) { return { onsuccess: null, onerror: null, result: store.get(key) }; },
            put: function (val, key) { store.set(key, val); return { onsuccess: null, onerror: null, result: key }; },
            delete: function (key) { store.delete(key); return { onsuccess: null, onerror: null, result: key }; }
          };
        }
      };
    },
    close: function () {},
    createObjectStore: function () {}
  };
  return {
    open: function () {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: dbObj };
      setTimeout(function () {
        if (req.onupgradeneeded) { try { req.onupgradeneeded(); } catch (e) {} }
        if (req.onsuccess) { try { req.onsuccess(); } catch (e) {} }
      }, 0);
      return req;
    }
  };
}

// Un "dispositivo" = localStorage + IndexedDB + keystore biométrico persistentes.
// newSession() abre una sesión nueva (módulo DB nuevo => state = null), como al
// cerrar y reabrir la app. Comparte el almacenamiento entre sesiones.
function makeDevice() {
  const ls = makeStorage();
  const idb = makeIdb();
  const keystore = new Map();
  const bio = {
    isAvailable: function () { return Promise.resolve({ isAvailable: true }); },
    verifyIdentity: function () { return Promise.resolve(); },
    isDataSaved: function (o) { return Promise.resolve({ isSaved: keystore.has(o.key) }); },
    setData: function (o) { keystore.set(o.key, o.value); return Promise.resolve(); },
    getData: function (o) { return Promise.resolve({ value: keystore.has(o.key) ? keystore.get(o.key) : null }); },
    deleteData: function (o) { keystore.delete(o.key); return Promise.resolve(); }
  };
  function newSession() {
    const sandbox = {
      window: null, document: global.document, localStorage: ls, indexedDB: idb,
      location: { hash: '', reload: function () {} }, navigator: global.navigator,
      console: console, crypto: nodeCrypto, btoa: global.btoa, atob: global.atob,
      TextEncoder: global.TextEncoder, TextDecoder: global.TextDecoder,
      setTimeout: setTimeout, clearTimeout: clearTimeout, Promise: Promise, Date: Date,
      Math: Math, JSON: JSON, Object: Object, Array: Array, String: String,
      Number: Number, Boolean: Boolean, Error: Error, RegExp: RegExp, Buffer: Buffer,
      process: process, Util: global.Util, Media: global.Media, License: global.License,
      fetch: global.fetch, require: require
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.window.Capacitor = { Plugins: { NativeBiometric: bio } };
    vm.createContext(sandbox);
    vm.runInContext(DB_SRC, sandbox, { filename: 'db.js' });
    return sandbox;
  }
  return { ls: ls, idb: idb, keystore: keystore, newSession: newSession };
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function isEnvelopeStr(raw) {
  if (!raw) return false;
  try { const o = JSON.parse(raw); return !!(o && o.enc === 'aes-gcm' && o.iv && o.ct); } catch (e) { return false; }
}

async function waitForEnvelope(ls, key) {
  for (let i = 0; i < 150; i++) {
    if (isEnvelopeStr(ls.getItem(key))) return true;
    await sleep(20);
  }
  return false;
}

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FALLA: ' + label); }
}

function section(t) { console.log('\n' + t); }

async function main() {
  // ============ 1. BUG CATÁLOGO: itemTypes legacy (objeto) -> array ============
  section('1) normalize(): itemTypes legacy {MO,REP} se convierte a array');
  {
    const legacyState = {
      format: 'cotizatec-backup',
      version: 1,
      data: {
        settings: {
          itemTypes: { MO: 'SERVICIO', REP: 'PRODUCTO' },
          businessName: 'Taller Test',
          docTitle: 'COTIZACIÓN'
        },
        catalog: [
          { id: 'c1', name: 'Servicio instalación', price: 1500, type: 'MO' },
          { id: 'c2', name: 'Producto muestra', price: 2500, type: 'REP' }
        ],
        clients: [],
        jobs: [],
        seq: { client: 0, catalog: 2, job: 0, expense: 0, payment: 0 }
      }
    };
    const d = DB.parseBackup(JSON.stringify(legacyState));
    ok(!!d, 'parseBackup acepta el respaldo legacy');
    DB.applyBackup(d);
    ok(Array.isArray(DB.state.settings.itemTypes), 'itemTypes quedó como array');
    ok(Array.isArray(DB.state.settings.itemTypes) && DB.state.settings.itemTypes.length > 0, 'array itemTypes no vacío');
    const cat = DB.state.catalog;
    ok(cat.length === 2, 'catálogo conserva sus 2 ítems');
    ok(cat.every(function (i) { return i.type === 'SERVICIO' || i.type === 'PRODUCTO'; }), 'los tipos legacy MO/REP se mapearon a SERVICIO/PRODUCTO');
    ok(DB.state.settings.itemTypes.every(function (t) { return typeof t.label === 'string' && t.id; }), 'cada tipo tiene id y label (estructura correcta para renderizar chips)');
  }

  // ============ 2. doReset: borra los 3 almacenes ============
  section('2) doReset(): borra localStorage y deja arrancar en blanco');
  {
    // Guardar algo primero
    DB.state = {
      settings: { itemTypes: [{ id: 'SERVICIO', label: 'Servicio', icon: 'tools' }], docTitle: 'X', businessName: 'Y' },
      catalog: [{ id: 'c1', name: 'A', price: 1, type: 'SERVICIO' }],
      clients: [{ id: 'cl1', name: 'Cliente' }],
      jobs: [],
      seq: { client: 1, catalog: 1, job: 0, expense: 0, payment: 0 }
    };
    DB.save(true);
    ok(!!global.localStorage.getItem(DB.KEY), 'estado guardado en localStorage antes del reset');

    Backups.doReset();
    ok(!global.localStorage.getItem(DB.KEY), 'localStorage KEY vacío tras doReset');
    ok(!global.localStorage.getItem(DB.BAK_KEY), 'localStorage BAK vacío tras doReset');
    ok(!global.localStorage.getItem(DB.TS_KEY), 'localStorage TS vacío tras doReset');
    ok(!global.localStorage.getItem(DB.ENC_META), 'localStorage ENC_META vacío tras doReset');
  }

  // ============ 3. Cifrado del respaldo manual con contraseña ============
  section('3) encryptBackupJson / decryptBackupJson');
  {
    const json = JSON.stringify({ data: 'hola', n: 42, arr: [1, 2, 3] });
    const enc = await DB.encryptBackupJson(json, 'clave123');
    ok(typeof enc === 'string', 'encryptBackupJson devuelve texto');
    const parsed = JSON.parse(enc);
    ok(parsed.format === 'cotizatec-backup-enc', 'formato es cotizatec-backup-enc');
    ok(parsed.salt && parsed.iv && parsed.ct, 'tiene salt, iv y ct');
    const dec = await DB.decryptBackupJson(enc, 'clave123');
    ok(dec === json, 'descifra y recupera el JSON original');
    let badPass = false;
    try { await DB.decryptBackupJson(enc, 'clave-incorrecta'); } catch (e) { badPass = (e && e.message === 'bad-pass'); }
    ok(badPass, 'contraseña incorrecta lanza bad-pass');
  }

  // ============ 4. Ciclo completo backup manual ============
  section('4) buildBackup -> encrypt -> decrypt -> parseBackup');
  {
    const json = DB.buildBackup();
    ok(typeof json === 'string' && json.length > 50, 'buildBackup genera JSON');
    const enc = await DB.encryptBackupJson(json, 'mi-clave');
    const dec = await DB.decryptBackupJson(enc, 'mi-clave');
    const d = DB.parseBackup(dec);
    ok(!!d, 'el respaldo cifrado/descifrado se parsea correctamente');
    ok(Array.isArray(d.catalog) && Array.isArray(d.clients) && Array.isArray(d.jobs), 'estructura del backup válida');
  }

  // ============ 5. Licencia: no degradar una licencia de pago a prueba ============
  section('5) License.isBetterLicense(): conserva la licencia de pago local');
  {
    const L = s.License;
    const day = 86400000;
    const now = Date.now();
    const paidLocal = { trial: false, expiresAt: now + 20 * day, graceUntil: now + 35 * day };
    const trialServer = { trial: true, expiresAt: now + 15 * day, graceUntil: now + 15 * day };
    ok(L.isBetterLicense(paidLocal, trialServer), 'pago local gana ante prueba del servidor');
    ok(!L.isBetterLicense(trialServer, paidLocal), 'prueba local no gana ante pago del servidor');

    const olderPaid = { trial: false, expiresAt: now + 5 * day, graceUntil: now + 20 * day };
    const newerPaid = { trial: false, expiresAt: now + 25 * day, graceUntil: now + 40 * day };
    ok(L.isBetterLicense(newerPaid, olderPaid), 'la licencia que vence mas tarde gana');
    ok(!L.isBetterLicense(olderPaid, newerPaid), 'la licencia que vence antes no gana');

    const expiredLocal = { trial: false, expiresAt: now - 10 * day, graceUntil: now - 1 * day };
    ok(!L.isBetterLicense(expiredLocal, trialServer), 'licencia vencida no gana ante una prueba valida');
  }

  // ============ 6. Modo vendedor: PIN del dueño ============
  section('6) Modo vendedor: PIN del dueño (staffMode/staffPin)');
  {
    DB.setStaffMode(false);
    DB.clearStaffPin();
    ok(DB.isStaffMode() === false, 'arranca en modo dueño');
    ok(DB.hasStaffPin() === false, 'sin PIN al inicio');

    await DB.setStaffPin('1234');
    ok(DB.hasStaffPin() === true, 'hasStaffPin true tras setStaffPin');
    ok(String(DB.state.settings.staffPin).indexOf('1234') === -1, 'el PIN no se guarda en claro');
    ok(/:/.test(String(DB.state.settings.staffPin)), 'staffPin tiene formato salt:hash');

    ok((await DB.verifyStaffPin('1234')) === true, 'PIN correcto verifica');
    ok((await DB.verifyStaffPin('9999')) === false, 'PIN incorrecto no verifica');

    DB.setStaffMode(true);
    ok(DB.isStaffMode() === true, 'setStaffMode(true) activa el modo vendedor');

    DB.setStaffMode(false);
    ok(DB.isStaffMode() === false, 'setStaffMode(false) vuelve al modo dueño');

    DB.clearStaffPin();
    ok(DB.hasStaffPin() === false, 'clearStaffPin elimina el PIN');
    ok((await DB.verifyStaffPin('1234')) === false, 'sin PIN, verify falla (no desbloquea)');
  }

  // ============ 7. REGRESIÓN: arranque en frío + desbloqueo por huella ============
  // Bug: decryptAndLoad() llamaba a normalize(s) antes de asignar state = s; en un
  // arranque en frío state es null y rebuildIndex() lanzaba
  // "Cannot read properties of null (reading 'clients')" => unlockFingerprint
  // devolvía {ok:false, reason:'error'} y la app quedaba bloqueada.
  section('7) Arranque en frío: desbloqueo por huella descifra sin crash');
  {
    const dev = makeDevice();

    // --- Sesión 1: activar protección con huella y guardar el estado cifrado ---
    const sb1 = dev.newSession();
    const DB1 = sb1.DB;
    DB1.state = {
      settings: { itemTypes: [{ id: 'SERVICIO', label: 'Servicio', icon: 'tools' }], docTitle: 'X', businessName: 'Y' },
      catalog: [{ id: 'c1', name: 'A', price: 1, type: 'SERVICIO' }],
      clients: [{ id: 'cl1', name: 'Cliente Uno' }],
      jobs: [],
      seq: { client: 1, catalog: 1, job: 0, expense: 0, payment: 0 }
    };
    const activated = await DB1.setEncryption('');
    ok(activated === true, 'setEncryption("") activa la protección con huella');
    ok(DB1.hasFingerprint() === true, 'hasFingerprint() true tras activar');
    ok(DB1.needsUnlock() === false, 'sesión 1 sigue desbloqueada (clave en memoria)');
    const wroteEnv = await waitForEnvelope(dev.ls, DB1.KEY);
    ok(wroteEnv && isEnvelopeStr(dev.ls.getItem(DB1.KEY)), 'el estado cifrado (envelope) quedó escrito en localStorage');
    ok(dev.keystore.size > 0, 'la clave maestra quedó guardada en el keystore (huella)');

    // --- Sesión 2: ARRANQUE EN FRÍO (mismo dispositivo, módulo DB nuevo => state = null) ---
    const sb2 = dev.newSession();
    const DB2 = sb2.DB;
    DB2.load();
    ok(DB2.needsUnlock() === true, 'arranque en frío: needsUnlock() true');
    ok(DB2.state === null, 'arranque en frío: state es null antes de desbloquear (condición del bug)');

    const res = await DB2.unlockFingerprint();
    ok(res && res.ok === true, 'arranque en frío: unlockFingerprint() => {ok:true} (antes: reason=error)');
    ok(DB2.needsUnlock() === false, 'arranque en frío: needsUnlock() false tras desbloquear');
    ok(DB2.state && Array.isArray(DB2.state.clients) && DB2.state.clients.length === 1,
      'arranque en frío: se descifraron y cargaron los datos (clients)');
    ok(DB2.find('clients', 'cl1') && DB2.find('clients', 'cl1').name === 'Cliente Uno',
      'arranque en frío: el índice se reconstruyó (find por id funciona)');
  }

  // ============ 8. Conduce de entrega: correlativo y stock ============
  section('8) Conduce de entrega: correlativo, items y stock');
  {
    DB.state = {
      settings: { itemTypes: [{ id: 'PRODUCTO', label: 'Producto', icon: 'box' }], docTitle: 'X', businessName: 'Taller', conducePrefix: 'CON' },
      catalog: [{ id: 'c50', name: 'Tornillo 2"', price: 50, cost: 20, type: 'PRODUCTO', stock: 5 }],
      clients: [{ id: 'cl9', name: 'Cliente Conduce', phone: '809-000', address: 'Calle 1' }],
      jobs: [],
      conduces: [],
      seq: { client: 1, catalog: 1, job: 0, expense: 0, payment: 0, conduce: 0 }
    };
    DB.save(true); DB.load();

    const job8 = { id: 'j9001', code: 'COT-9001', clientId: 'cl9', clientName: 'Cliente Conduce', clientPhone: '809-000', items: [{ desc: 'Tornillo 2"', qty: 2, price: 50, cost: 20, type: 'PRODUCTO', catalogId: 'c50', catalogQty: 1 }] };
    const c8 = DB.newConduce(job8);
    ok(c8.status === 'PENDIENTE', 'newConduce arranca en estado PENDIENTE');
    ok(c8.items.length === 1 && c8.clientName === 'Cliente Conduce', 'newConduce copia items y cliente');
    ok(c8.clientAddress === 'Calle 1', 'newConduce copia la direccion del cliente');

    const check8 = DB.conduceStockCheck(c8);
    ok(check8.length === 1 && check8[0].ok === true, 'stock suficiente: check8 ok');

    DB.saveConduce(c8);
    ok(/^CON-\d{6}$/.test(c8.code), 'saveConduce asigna correlativo CON-000001');

    const c9 = DB.newConduce(job8);
    DB.saveConduce(c9);
    ok(c9.code !== c8.code, 'correlativo se incrementa entre conduces');

    const applied = DB.conduceApplyStock(c8);
    ok(applied.ok === true && applied.applied === 1, 'conduceApplyStock descuenta cuando hay stock');
    ok(DB.find('catalog', 'c50').stock === 3, 'stock descontado: 5 - 2 = 3');

    const restored = DB.conduceRestoreStock(c8);
    ok(restored === true && DB.find('catalog', 'c50').stock === 5, 'conduceRestoreStock devuelve el stock al anular');

    // Conduce con stock insuficiente: no descuenta y reporta missing.
    const jobShort = { id: 'j9002', code: 'COT-9002', clientId: 'cl9', clientName: 'Cliente Conduce', items: [{ desc: 'Tornillo 2"', qty: 10, price: 50, cost: 20, type: 'PRODUCTO', catalogId: 'c50', catalogQty: 1 }] };
    const cShort = DB.newConduce(jobShort);
    const appliedShort = DB.conduceApplyStock(cShort);
    ok(appliedShort.ok === false && appliedShort.missing.length === 1, 'stock insuficiente: conduceApplyStock reporta missing');
    ok(DB.find('catalog', 'c50').stock === 5, 'stock insuficiente: no se desconta (sigue en 5)');
  }
  summary();
}

function summary() {
  console.log('\n==================================');
  console.log('RESULTADO: ' + passed + ' pasaron, ' + failed + ' fallaron');
  console.log('==================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('\n⏰ ERROR NO ESPERADO: ' + (e && e.stack || e));
  process.exit(1);
});