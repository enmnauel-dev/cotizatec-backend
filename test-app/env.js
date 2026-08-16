// Entorno mínimo de navegador para ejecutar db.js / backup.js en Node.
// No es un navegador real: simula localStorage, indexedDB, document, window.

// ---- localStorage en memoria ----
function makeStorage() {
  const m = new Map();
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
    clear: function () { m.clear(); },
    key: function (i) { return Array.from(m.keys())[i] || null; },
    get length() { return m.size; },
    _map: m
  };
}
global.localStorage = makeStorage();

// ---- indexedDB en memoria (mínimo: open + store kv + get/put/delete) ----
function makeIdb() {
  const store = new Map();
  const dbObj = {
    transaction: function () {
      return {
        objectStore: function () {
          return {
            get: function (key) {
              return { onsuccess: null, onerror: null, result: store.get(key) };
            },
            put: function (val, key) {
              store.set(key, val);
              return { onsuccess: null, onerror: null, result: key };
            },
            delete: function (key) {
              store.delete(key);
              return { onsuccess: null, onerror: null, result: key };
            }
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
global.indexedDB = makeIdb();

// ---- document / window mínimo ----
const noopEl = function () {
  return {
    value: '',
    style: {},
    appendChild: function () {},
    removeChild: function () {},
    addEventListener: function () {},
    setAttribute: function () {},
    focus: function () {},
    click: function () {},
    innerHTML: '',
    remove: function () {}
  };
};
global.document = {
  getElementById: function () { return noopEl(); },
  createElement: function () { return noopEl(); },
  body: { appendChild: function () {}, removeChild: function () {} }
};
global.window = {
  location: { hash: '' },
  crypto: require('crypto').webcrypto,
  Capacitor: undefined,
  localStorage: global.localStorage,
  indexedDB: global.indexedDB,
  addEventListener: function () {}
};
global.location = global.window.location;
global.navigator = {};
global.console = console;

if (!global.btoa) {
  global.btoa = function (s) { return Buffer.from(s, 'binary').toString('base64'); };
  global.atob = function (s) { return Buffer.from(s, 'base64').toString('binary'); };
}

// ---- Util mínimo (solo lo que db.js/backup.js necesitan en tiempo de carga) ----
global.Util = {
  isNativeEnv: function () { return false; },
  capacitorPlugin: function () { return null; },
  confirmar: function () { return true; },
  toast: function () {},
  SAVE_ICON: 'S', X_ICON: 'X', LOCK_ICON: 'L', CHECK_ICON: 'C', WA_ICON: 'W'
};

// ---- Media mínimo ----
global.Media = { recompressExisting: function () {} };

// ---- License mínimo ----
global.License = { getDeviceId: function () { return Promise.resolve('cotizatec-test-device'); } };

global.__dbg = { localStorage: global.localStorage, indexedDB: global.indexedDB };

module.exports = {};