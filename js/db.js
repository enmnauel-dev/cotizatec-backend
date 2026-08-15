var DB = (function () {
  const KEY = 'cotizatec_db_v1';

  const DEFAULT_SETTINGS = {
    businessName: 'Mi Taller / Técnico',
    phone: '',
    address: '',
    logo: null,
    signature: null,
    itbis: 18,
    currency: 'RD$',
    quotePrefix: 'COT',
    validityDays: 15,
    watermark: 'Creado con CotizaTec',
    watermarkEnabled: true,
    resetPassword: '',
    lockOnStart: false,
    relockOnResume: false,
    docTitle: 'COTIZACIÓN',
    itemTypes: [
      { id: 'SERVICIO', label: 'Servicio', icon: 'tools' },
      { id: 'PRODUCTO', label: 'Producto', icon: 'box' }
    ]
  };

  const SEED_CATALOG = [
    { type: 'SERVICIO', name: 'Servicio de instalación', price: 1500 },
    { type: 'SERVICIO', name: 'Servicio de mantenimiento', price: 800 },
    { type: 'SERVICIO', name: 'Diagnóstico y asesoría', price: 500 },
    { type: 'PRODUCTO', name: 'Producto de muestra A', price: 2500 },
    { type: 'PRODUCTO', name: 'Producto de muestra B', price: 1800 },
    { type: 'PRODUCTO', name: 'Material / accesorio estándar', price: 400 }
  ];

  const STATUS = [
    { id: 'COTIZADO', label: 'Cotizado', color: '#f59e0b' },
    { id: 'APROBADO', label: 'Aprobado', color: '#3b82f6' },
    { id: 'EN_PROCESO', label: 'En Proceso', color: '#8b5cf6' },
    { id: 'COMPLETADO', label: 'Completado', color: '#10b981' },
    { id: 'COBRADO', label: 'Cobrado', color: '#059669' }
  ];

  function blankState() {
    return {
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      clients: [],
      catalog: JSON.parse(JSON.stringify(SEED_CATALOG)).map(a => ({ id: 'c' + (++_seq.catalog), ...a })),
      jobs: [],
      seq: { client: 0, catalog: 0, job: 0, expense: 0, payment: 0 }
    };
  }

  const _seq = { client: 0, catalog: 0, job: 0, expense: 0, payment: 0 };
  let state = null;

  const BAK_KEY = 'cotizatec_db_bak_v1';
  const TS_KEY = 'cotizatec_db_ts_v1';
  const IDB_NAME = 'cotizatec_idb_v1';
  const IDB_STORE = 'kv';

  let _localSource = false;
  let _idbPromise = null;
  let _saveHooks = [];

  // ===== Cifrado en reposo (AES-256-GCM) =====
  // Clave maestra (MK) aleatoria de 256 bits. Se guarda en el keystore del
  // dispositivo protegida por biometría (huella = método principal) y, si el
  // usuario lo desea, envuelta con una contraseña de respaldo (PBKDF2+AES-GCM).
  // Sin protección el comportamiento es idéntico al original (JSON plano).
  const ENC_ITER = 120000;
  const ENC_META = 'cotizatec_enc_v1'; // { v:2, wrap:{salt,iv,ct}|null } — MK envuelta con la contraseña
  const MK_KEY = 'cotizatec_mk';       // clave del keystore para la clave maestra
  let _encKey = null;          // CryptoKey AES-GCM (derivada de la MK)
  let _mkRaw = null;           // bytes de la clave maestra mientras está desbloqueada
  let _mkStored = false;       // ¿la MK ya está guardada en el keystore?
  let _envelope = null;        // blob cifrado pendiente de descifrar en el arranque
  let _encPendingJson = null;  // estado en texto pendiente de cifrar (latest-wins)
  let _encChain = Promise.resolve();

  function subtle() {
    try { return (window.crypto || {}).subtle || null; } catch (e) { return null; }
  }

  function b64FromBuf(buf) {
    const b = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    try { return btoa(bin); } catch (e) { return null; }
  }

  function bufFromB64(s) {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  function parseEnvelope(str) {
    try {
      const o = JSON.parse(str);
      return (o && o.enc === 'aes-gcm' && o.iv && o.ct) ? o : null;
    } catch (e) { return null; }
  }

  function readEncMeta() {
    try { return JSON.parse(localStorage.getItem(ENC_META) || 'null'); } catch (e) { return null; }
  }

  function writeEncMeta(obj) {
    localStorage.setItem(ENC_META, JSON.stringify(obj));
  }

  function bioPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeBiometric) || null;
  }

  // Bytes de la clave maestra para poder importarla como AES-GCM.
  function importMk(raw) {
    return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  // Genera una clave maestra aleatoria de 256 bits.
  function genMk() {
    const raw = new Uint8Array(32);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(raw);
    return raw;
  }

  // Guarda la MK en el keystore del dispositivo. Se usa verifyIdentity() (prompt
  // biométrico sin CryptoObject) para confirmar la huella del usuario antes de
  // almacenar. El valor se guarda SIN accessControl: la clave NativeBiometricData_*
  // no exige autenticación biométrica al cifrar (la clase 2/débil del Redmi A5
  // falla con accessControl: KEY_USER_NOT_AUTHENTICATED). El desbloqueo por huella
  // se protege con verifyIdentity() al leer.
  function mkKeystoreSet(mkB64) {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve(false);
    return bio.isAvailable({ useFallback: false }).then(function (r) {
      if (!(r && r.isAvailable)) return false;
      return bio.verifyIdentity({
        reason: 'Para confirmar el desbloqueo con huella',
        title: 'Activar protección con huella',
        subtitle: 'Usa tu huella para continuar',
        negativeButtonText: 'Cancelar'
      }).then(function () {
        return bio.setData({ key: MK_KEY, value: mkB64 })
          .then(function () { return true; })
          .catch(function () { return false; });
      }).catch(function () { return false; });
    }).catch(function () { return false; });
  }

  function mkKeystoreGet() {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve(null);
    return bio.getData({ key: MK_KEY })
      .then(function (res) { return (res && res.value) || null; })
      .catch(function () { return null; });
  }

  // Muestra el prompt biométrico simple (sin CryptoObject) para verificar la
  // identidad. Devuelve true si el usuario se autentica con su huella.
  function bioVerify() {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve(false);
    return bio.verifyIdentity({
      reason: 'Para desbloquear CotizaTec',
      title: 'Desbloquear CotizaTec',
      subtitle: 'Usa tu huella para continuar',
      negativeButtonText: 'Cancelar'
    }).then(function () { return true; }).catch(function () { return false; });
  }

  function mkKeystoreDel() {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve();
    return bio.deleteData({ key: MK_KEY }).then(function () {}).catch(function () {});
  }

  function mkKeystoreExists() {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve(false);
    return bio.isDataSaved({ key: MK_KEY }).then(function (r) { return !!(r && r.isSaved); }).catch(function () { return false; });
  }

  function deriveKey(password, saltB64) {
    const sub = subtle();
    if (!sub || !password) return Promise.reject(new Error('no-subtle'));
    return sub.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveKey'])
      .then(function (mat) {
        return sub.deriveKey(
          { name: 'PBKDF2', salt: bufFromB64(saltB64), iterations: ENC_ITER, hash: 'SHA-256' },
          mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  function encryptState(jsonStr, key) {
    const iv = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(iv);
    return subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(jsonStr))
      .then(function (ct) {
        return { enc: 'aes-gcm', v: 1, iv: b64FromBuf(iv), ct: b64FromBuf(ct) };
      });
  }

  function decryptState(env, key) {
    return subtle().decrypt({ name: 'AES-GCM', iv: bufFromB64(env.iv) }, key, bufFromB64(env.ct))
      .then(function (buf) { return new TextDecoder().decode(buf); });
  }

  // Envuelve la clave maestra con la contraseña de respaldo.
  function wrapMk(password, mkRaw) {
    const salt = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(salt);
    return deriveKey(password, b64FromBuf(salt)).then(function (k) {
      const iv = new Uint8Array(12);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(iv);
      return subtle().encrypt({ name: 'AES-GCM', iv: iv }, k, mkRaw)
        .then(function (ct) {
          return { salt: b64FromBuf(salt), iv: b64FromBuf(iv), ct: b64FromBuf(ct) };
        });
    });
  }

  // Recupera la clave maestra desde la contraseña de respaldo.
  function unwrapMk(password, wrap) {
    return deriveKey(password, wrap.salt).then(function (k) {
      return subtle().decrypt({ name: 'AES-GCM', iv: bufFromB64(wrap.iv) }, k, bufFromB64(wrap.ct))
        .then(function (buf) { return new Uint8Array(buf); });
    });
  }

  // Recupera la clave maestra desde el keystore (huella).
  function mkFromKeystore() {
    return mkKeystoreGet().then(function (mkB64) {
      if (!mkB64) return null;
      return bufFromB64(mkB64);
    });
  }

  // Escribe el estado cifrado en TODAS las capas (KEY, BAK, IDB, FS). Latest-wins:
  // encola el JSON más reciente y encadena para no sobreescribir en desorden.
  function _doEncSave() {
    const json = _encPendingJson; _encPendingJson = null;
    if (json == null || !_encKey) return Promise.resolve();
    return encryptState(json, _encKey).then(function (env) {
      const envStr = JSON.stringify(env);
      const prev = localStorage.getItem(KEY);
      if (prev && prev !== envStr) localStorage.setItem(BAK_KEY, prev);
      localStorage.setItem(KEY, envStr);
      localStorage.setItem(TS_KEY, String(Date.now()));
      mirrorWrite(envStr);
      fsWriteStr(envStr);
      if (_encPendingJson) return _doEncSave();
    }).catch(function (e) { console.error('CotizaTec: fallo cifrado guardado', e); });
  }

  function scheduleEncSave() {
    _encPendingJson = JSON.stringify(state);
    _encChain = _encChain.then(function () { return _doEncSave(); }).catch(function () {});
  }

  // ===== Archivo nativo =====
  const FS_KEY = 'cotizatec_state.json';
  let _fsTimer = null;
  let _fsPendingStr = null;

  function fsPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null;
  }

  function fsB64(str) {
    try { return 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(str))); }
    catch (e) { return null; }
  }

  function fsDecode(b64) {
    try {
      let s = String(b64 || '');
      const i = s.indexOf(',');
      if (i >= 0 && /^data:/.test(s)) s = s.slice(i + 1);
      return decodeURIComponent(escape(atob(s)));
    } catch (e) { return null; }
  }

  // Escribe una cadena arbitraria (JSON plano o blob cifrado) al archivo nativo.
  function fsWriteStr(str) {
    _fsTimer = null;
    const FS = fsPlugin();
    if (!FS || !Util || !Util.isNativeEnv || !Util.isNativeEnv()) return;
    const data = fsB64(str);
    if (!data) return;
    FS.writeFile({ path: FS_KEY, directory: 'DATA', data: data, recursive: false })
      .then(function () {})
      .catch(function (e) { console.warn('CotizaTec: fallo respaldo nativo', e && e.message); });
  }

  // Agendado: agrupa múltiples guardados consecutivos en una sola escritura.
  function fsWriteDebounced() {
    if (_fsTimer) clearTimeout(_fsTimer);
    _fsTimer = setTimeout(function () {
      // En modo cifrado el archivo lo escribe el pipeline de cifrado (_doEncSave).
      if (_encKey) return;
      fsWriteStr(JSON.stringify(state));
    }, 1500);
  }

  // Descarga pendiente inmediata (flujo en curso).
  function fsFlush() {
    if (_encKey) { scheduleEncSave(); return; }
    if (_fsTimer) { clearTimeout(_fsTimer); fsWriteStr(JSON.stringify(state)); }
  }

  function isValidState(s) {
    return !!(s && typeof s === 'object' &&
      Array.isArray(s.clients) && Array.isArray(s.catalog) && Array.isArray(s.jobs) &&
      s.settings && typeof s.settings === 'object');
  }

  function normalize(s) {
    if (!s.settings) s.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!s.seq) s.seq = { client: 0, catalog: 0, job: 0, expense: 0, payment: 0 };
    if (!s.catalog) s.catalog = [];
    if (!s.clients) s.clients = [];
    if (!s.jobs) s.jobs = [];
    if (!s.settings.itemTypes) s.settings.itemTypes = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.itemTypes));
    if (!s.settings.docTitle) s.settings.docTitle = DEFAULT_SETTINGS.docTitle;
    const LEGACY_TYPES = { MO: 'SERVICIO', REP: 'PRODUCTO' };
    (s.catalog || []).forEach(function (i) {
      if (i && LEGACY_TYPES[i.type]) i.type = LEGACY_TYPES[i.type];
    });
    (s.jobs || []).forEach(function (j) {
      (j.items || []).forEach(function (it) {
        if (it && LEGACY_TYPES[it.type]) it.type = LEGACY_TYPES[it.type];
      });
    });
    const t = s.seq;
    _seq.client = t.client || 0; _seq.catalog = t.catalog || 0; _seq.job = t.job || 0;
    _seq.expense = t.expense || 0; _seq.payment = t.payment || 0;
    return s;
  }

  // Espejo asíncrono en IndexedDB: nunca bloquea el guardado principal.
  function idbOpen() {
    if (_idbPromise) return _idbPromise;
    _idbPromise = new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('no-idb')); return; }
      let req;
      try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        const d = req.result;
        if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('idb-open')); };
    });
    _idbPromise.catch(function () { _idbPromise = null; });
    return _idbPromise;
  }

  function mirrorWrite(jsonStr) {
    idbOpen().then(function (db) {
      try {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ value: jsonStr, ts: Date.now() }, 'state');
      } catch (e) {}
    }).catch(function () {});
  }

  function readMirror() {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        try {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get('state');
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { reject(req.error || new Error('idb-get')); };
        } catch (e) { reject(e); }
      });
    });
  }

  // Guardado seguro: respaldo del estado anterior antes de sobreescribir la clave principal.
  function save(skipMirror) {
    state.seq = { client: _seq.client, catalog: _seq.catalog, job: _seq.job, expense: _seq.expense, payment: _seq.payment };
    if (_encKey) { scheduleEncSave(); notifySave(); return; }
    try {
      const jsonStr = JSON.stringify(state);
      if (!skipMirror) mirrorWrite(jsonStr);
      if (!skipMirror) fsWriteDebounced();
      const current = localStorage.getItem(KEY);
      if (current && current !== jsonStr) localStorage.setItem(BAK_KEY, current);
      localStorage.setItem(KEY, jsonStr);
      localStorage.setItem(TS_KEY, String(Date.now()));
    } catch (e) {
      console.error('CotizaTec: error al guardar en localStorage', e);
    }
    notifySave();
  }

  function onSave(fn) {
    if (typeof fn === 'function') _saveHooks.push(fn);
  }

  function notifySave() {
    for (let i = 0; i < _saveHooks.length; i++) {
      try { _saveHooks[i](); } catch (e) {}
    }
  }

  // Lectura con autorrecuperación: si la principal está corrupta o mal formada,
  // se restaura el respaldo local; solo si ambos fallan se arranca en blanco.
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) {}
    if (raw) {
      const env = parseEnvelope(raw);
      if (env) { _envelope = env; _localSource = false; return null; }
      try {
        state = JSON.parse(raw);
        if (isValidState(state)) { normalize(state); _localSource = true; return state; }
      } catch (e) {}
      console.warn('CotizaTec: datos principales inválidos, autorrecuperación desde respaldo local...');
      try {
        const bak = localStorage.getItem(BAK_KEY);
        if (bak) {
          const bakEnv = parseEnvelope(bak);
          if (bakEnv) { _envelope = bakEnv; _localSource = false; return null; }
          const restored = JSON.parse(bak);
          if (isValidState(restored)) {
            normalize(restored);
            state = restored;
            localStorage.setItem(KEY, bak);
            _localSource = true;
            return state;
          }
        }
      } catch (e) {}
    }
    state = blankState();
    save(true);
    return state;
  }

  // Vuelve a bloquear tras estar desbloqueado: recarga el envelope cifrado desde
  // el almacenamiento para volver a exigir la credencial. Sin esto, al relockear
  // (p. ej. al volver de segundo plano) _envelope es null y unlock/unlockFingerprint
  // fallan siempre aunque la contraseña/huella sea correcta.
  // Espera primero la cadena de guardado cifrado: si la protección se acaba de
  // activar, el envelope aún no está en localStorage hasta que _encChain termine.
  function relock() {
    return _encChain.catch(function () {}).then(function () {
      let raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) {}
      const env = raw ? parseEnvelope(raw) : null;
      if (!env) return false;
      _envelope = env;
      _encKey = null;
      _mkRaw = null;
      _mkStored = false;
      return true;
    });
  }

  function next(key) {
    _seq[key] += 1;
    return _seq[key];
  }

  function incr(key) {
    const v = next(key);
    state.seq[key] = v;
    save();
    return v;
  }

  load();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function money(n, cur) {
    const c = (cur || (state && state.settings.currency) || 'RD$');
    const v = Number(n || 0);
    const t = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return c + ' ' + t;
  }

  function date(iso, withHour) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const base = dd + '/' + mm + '/' + yyyy;
    if (withHour) {
      const hh = String(d.getHours()).padStart(2, '0');
      const mi = String(d.getMinutes()).padStart(2, '0');
      return base + ' ' + hh + ':' + mi;
    }
    return base;
  }

  function push(list, obj) {
    state[list].push(obj);
    save();
    return obj;
  }

  function find(list, id) {
    return state[list].find(x => String(x.id) === String(id));
  }

  function update(list, id, patch) {
    const it = find(list, id);
    if (it) { Object.assign(it, patch); save(); }
    return it;
  }

  function remove(list, id) {
    state[list] = state[list].filter(x => String(x.id) !== String(id));
    save();
  }

  function jobTotals(j) {
    const subtotal = (j.items || []).reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(j.discount) || 0;
    const taxable = Math.max(0, subtotal - discount);
    const itbis = Number(j.itbis) || 0;
    const tax = itbis > 0 ? taxable * itbis / 100 : 0;
    const total = taxable + tax;
    const cost = (j.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const collected = (j.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
    const balance = Math.max(0, total - collected);
    const margin = total - cost;
    return { subtotal, discount, itbis, tax, total, cost, collected, balance, margin };
  }

  function newJob(client) {
    return {
      id: undefined,
      number: undefined,
      code: undefined,
      clientId: client ? client.id : null,
      clientName: client ? client.name : '',
      clientPhone: client ? client.phone : '',
      date: new Date().toISOString(),
      items: [],
      discount: 0,
      itbis: Number(state.settings.itbis) || 0,
      notes: '',
      status: 'COTIZADO',
      expenses: [],
      payments: []
    };
  }

  function saveJob(job) {
    const existingIndex = state.jobs.findIndex(x => String(x.id) === String(job.id));
    if (existingIndex >= 0) {
      state.jobs[existingIndex] = job;
    } else {
      state.jobs.unshift(job);
    }
    save();
  }

  function captureClient(job) {
    const c = find('clients', job.clientId);
    if (c) {
      job.clientName = c.name;
      job.clientPhone = c.phone;
    }
    save();
  }

  function statusLabel(id) {
    const s = STATUS.find(x => x.id === id);
    return s ? s.label : id;
  }

  function statusColor(id) {
    const s = STATUS.find(x => x.id === id);
    return s ? s.color : '#6b7280';
  }

  function buildBackup() {
    return JSON.stringify({
      format: 'cotizatec-backup',
      version: 1,
      app: 'CotizaTec',
      exportedAt: new Date().toISOString(),
      data: state
    }, null, 2);
  }

  function parseBackup(text) {
    let str = String(text == null ? '' : text);
    str = str.replace(/^\uFEFF/, '').trim();
    if (!str) return null;
    let obj;
    try { obj = JSON.parse(str); } catch (e) { return null; }
    const d = obj && obj.format === 'cotizatec-backup' && obj.data ? obj.data : obj;
    if (!d || typeof d !== 'object') return null;
    if (!Array.isArray(d.catalog) || !Array.isArray(d.clients) || !Array.isArray(d.jobs)) return null;
    if (!d.settings || typeof d.settings !== 'object') return null;
    return d;
  }

  function backupError(text) {
    const str = String(text == null ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!str) return 'El archivo está vacío';
    let obj;
    try { obj = JSON.parse(str); } catch (e) { return 'El archivo no contiene JSON válido'; }
    const d = obj && obj.format === 'cotizatec-backup' && obj.data ? obj.data : obj;
    if (!d || typeof d !== 'object') return 'El archivo no tiene la estructura de CotizaTec';
    if (!Array.isArray(d.catalog) || !Array.isArray(d.clients) || !Array.isArray(d.jobs)) return 'Faltan datos: no se encontraron clientes, catálogo o trabajos';
    if (!d.settings || typeof d.settings !== 'object') return 'Faltan los ajustes en el respaldo';
    return null;
  }

  function applyBackup(d) {
    const merged = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    Object.keys(merged).forEach(function (k) {
      if (d.settings[k] !== undefined) merged[k] = d.settings[k];
    });
    d.settings = merged;
    if (!d.seq) d.seq = { client: 0, catalog: 0, job: 0, expense: 0, payment: 0 };
    normalize(d);
    state = d;
    _seq.client = d.seq.client || 0;
    _seq.catalog = d.seq.catalog || 0;
    _seq.job = d.seq.job || 0;
    _seq.expense = d.seq.expense || 0;
    _seq.payment = d.seq.payment || 0;
    save();
    return state;
  }

  function startedFromLocal() {
    return _localSource;
  }

  // Recuperación desde el espejo IndexedDB: se usa cuando localStorage quedó
  // vacío (evictado) o se quedó detrás por fallos de cuota. Devuelve true si adoptó.
  function restoreFromIdb() {
    return readMirror().then(function (row) {
      if (!row || !row.value) return false;
      const env = parseEnvelope(row.value);
      if (env) { _envelope = env; _localSource = false; return true; }
      let s;
      try { s = JSON.parse(row.value); } catch (e) { return false; }
      if (!isValidState(s)) return false;
      let localTs = 0;
      try { localTs = Number(localStorage.getItem(TS_KEY)) || 0; } catch (e) {}
      if (_localSource && (!row.ts || row.ts <= localTs)) return false;
      normalize(s);
      state = s;
      localStorage.setItem(KEY, row.value);
      localStorage.setItem(BAK_KEY, row.value);
      localStorage.setItem(TS_KEY, String(row.ts || Date.now()));
      return true;
    }).catch(function () { return false; });
  }

  function itemType(typeId) {
    const defs = (state && state.settings && Array.isArray(state.settings.itemTypes)) ? state.settings.itemTypes : DEFAULT_SETTINGS.itemTypes;
    return defs.find(function (t) { return t.id === typeId; }) || { id: String(typeId), label: String(typeId), icon: 'box' };
  }

  // Recuperación desde el archivo nativo (Filesystem, directorio DATA). Es el
  // último recurso, usado solo cuando localStorage e IndexedDB fallaron (ambos
  // evictables por el WebView). Devuelve true si adoptó.
  function restoreFromFs() {
    const FS = fsPlugin();
    if (!FS || !Util || !Util.isNativeEnv || !Util.isNativeEnv()) return Promise.resolve(false);
    if (_localSource) return Promise.resolve(false);
    return FS.readFile({ path: FS_KEY, directory: 'DATA' })
      .then(function (res) {
        const jsonStr = fsDecode(res && res.data);
        if (!jsonStr) return false;
        const env = parseEnvelope(jsonStr);
        if (env) { _envelope = env; _localSource = false; return true; }
        const s = JSON.parse(jsonStr);
        if (!isValidState(s)) return false;
        normalize(s);
        state = s;
        _seq.client = s.seq.client || 0; _seq.catalog = s.seq.catalog || 0;
        _seq.job = s.seq.job || 0; _seq.expense = s.seq.expense || 0; _seq.payment = s.seq.payment || 0;
        try {
          localStorage.setItem(KEY, jsonStr);
          localStorage.setItem(BAK_KEY, jsonStr);
          localStorage.setItem(TS_KEY, String(Date.now()));
        } catch (e) {}
        return true;
      })
      .catch(function () { return false; });
  }

  // ===== API de cifrado =====

  // ¿Hay datos cifrados pendientes de descifrar en el arranque?
  function needsUnlock() {
    return !!_envelope;
  }

  // ¿La app está protegida (cifrado activo o pendiente de descifrar)?
  function isProtected() {
    return !!( _envelope || _encKey );
  }

  // ¿El guardado activo está cifrado (clave maestra cargada)?
  function isEncrypted() {
    return !!_encKey;
  }

  // ¿Hay una contraseña de respaldo configurada?
  function hasBackupPassword() {
    const meta = readEncMeta();
    return !!(meta && meta.wrap);
  }

  // ¿La clave maestra está en el keystore (esquema v2, desbloqueo por huella)?
  function hasFingerprint() {
    const meta = readEncMeta();
    return !!(meta && meta.v === 2);
  }

  // ¿Se puede desbloquear con una contraseña? (wrap actual o esquema legado v1)
  function canUnlockByPassword() {
    const meta = readEncMeta();
    if (!meta) return false;
    return !!(meta.wrap || meta.salt);
  }

  // ¿Hay biometría disponible en el dispositivo?
  function bioAvailable() {
    const bio = bioPlugin();
    if (!bio) return Promise.resolve(false);
    return bio.isAvailable({ useFallback: false })
      .then(function (r) { return !!(r && r.isAvailable); })
      .catch(function () { return false; });
  }

  function decryptAndLoad(key, skipSave) {
    return decryptState(_envelope, key).then(function (jsonStr) {
      let s;
      try { s = JSON.parse(jsonStr); } catch (e) { return false; }
      if (!isValidState(s)) return false;
      normalize(s);
      state = s;
      _seq.client = s.seq.client || 0; _seq.catalog = s.seq.catalog || 0;
      _seq.job = s.seq.job || 0; _seq.expense = s.seq.expense || 0; _seq.payment = s.seq.payment || 0;
      _encKey = key;
      _envelope = null;
      _localSource = true;
      if (!skipSave) save(true);
      return true;
    });
  }

  // Desbloquea con la huella. Primero verifica la identidad biométrica (prompt
  // simple sin CryptoObject, compatible con la biometría débil del Redmi A5) y
  // luego lee la clave maestra desde el keystore. Devuelve true si OK.
  function unlockFingerprint() {
    if (!_envelope) return Promise.resolve(false);
    return bioVerify().then(function (verified) {
      if (!verified) return false;
      return mkFromKeystore().then(function (mkRaw) {
        if (!mkRaw) return false;
        return importMk(mkRaw).then(function (key) {
          return decryptAndLoad(key).then(function (ok) {
            if (!ok) return false;
            _mkRaw = mkRaw;
            return true;
          });
        });
      });
    }).catch(function () { return false; });
  }

  // Desbloquea con la contraseña (respaldo o esquema legado v1). Devuelve true si OK.
  // En el esquema v1 (cifrado directo con la contraseña) descifra y carga sin
  // migrar todavía: la clave v1 se mantiene para re-guardar. La migración al
  // esquema de clave maestra ocurre al activar la protección (huella/contraseña),
  // momento en que el usuario puede autenticarse con biometría.
  function unlock(password) {
    if (!_envelope) return Promise.resolve(false);
    const meta = readEncMeta();
    if (!meta) return Promise.resolve(false);
    if (meta.wrap) {
      return unwrapMk(password, meta.wrap).then(function (mkRaw) {
        if (!mkRaw) return false;
        return importMk(mkRaw).then(function (key) {
          return decryptAndLoad(key).then(function (ok) {
            if (!ok) return false;
            _mkRaw = mkRaw;
            return true;
          });
        });
      }).catch(function () { return false; });
    }
    // Esquema legado v1: cifrado directo con la contraseña.
    if (!meta.salt) return Promise.resolve(false);
    return deriveKey(password, meta.salt).then(function (key) {
      return decryptAndLoad(key, true).then(function (ok) {
        if (!ok) return false;
        _mkRaw = null; // aún no hay clave maestra; sigue en esquema v1
        _mkStored = false;
        return true;
      });
    }).catch(function () { return false; });
  }

  // Activa o cambia la protección. La clave maestra se guarda en el keystore
  // (huella = método principal) y, opcionalmente, se envuelve con una contraseña
  // de respaldo. Sin biometría ni contraseña no se puede proteger.
  function setEncryption(password) {
    if (!subtle()) return Promise.resolve(false);
    const mkRaw = _mkRaw || genMk();
    const mkB64 = b64FromBuf(mkRaw);
    const needStore = !_mkStored;
    const storeP = needStore ? mkKeystoreSet(mkB64) : mkKeystoreExists();
    return storeP.then(function (keystoreOk) {
      const doWrap = password ? wrapMk(password, mkRaw) : Promise.resolve(null);
      return doWrap.then(function (wrap) {
        if (!keystoreOk && !wrap) return false; // sin huella ni contraseña: no se puede desbloquear
        if (keystoreOk) _mkStored = true;
        writeEncMeta({ v: 2, wrap: wrap });
        return importMk(mkRaw).then(function (key) {
          _encKey = key;
          _mkRaw = mkRaw;
          _envelope = null;
          scheduleEncSave();
          return true;
        });
      });
    }).catch(function () { return false; });
  }

  // Quita la contraseña de respaldo (deja solo la huella). Solo posible si la
  // clave maestra está guardada en el keystore.
  function removePassword() {
    const meta = readEncMeta();
    if (!meta || !meta.wrap) return Promise.resolve(true);
    return mkKeystoreExists().then(function (stored) {
      if (!stored) return false;
      meta.wrap = null;
      writeEncMeta(meta);
      return true;
    });
  }

  // Desactiva el cifrado y vuelve a guardar en plano.
  function disableEncryption() {
    _envelope = null;
    _encKey = null;
    _mkRaw = null;
    _mkStored = false;
    _encPendingJson = null;
    const delP = mkKeystoreDel();
    const jsonStr = JSON.stringify(state);
    return _encChain.catch(function () {}).then(function () {
      try { localStorage.removeItem(ENC_META); } catch (e) {}
      try {
        localStorage.setItem(KEY, jsonStr);
        localStorage.setItem(TS_KEY, String(Date.now()));
      } catch (e) {}
      mirrorWrite(jsonStr);
      fsWriteStr(jsonStr);
      _encChain = Promise.resolve();
      return delP.then(function () { return true; });
    });
  }

  function boot() {
    return Promise.resolve().then(function () {
      if (_envelope) return 'locked';
      if (_localSource) return 'ready';
      return restoreFromIdb().then(function (ok) {
        if (ok) return (_envelope ? 'locked' : 'ready');
        return restoreFromFs().then(function (ok2) {
          if (ok2) return (_envelope ? 'locked' : 'ready');
          return 'blank';
        });
      });
    });
  }

  const api = {};
  Object.defineProperty(api, 'state', { get: function () { return state; }, enumerable: true });
  Object.assign(api, {
    load, save, incr, esc, money, date, push, find, update, remove,
    jobTotals, newJob, saveJob, captureClient,
    statusLabel, statusColor, STATUS, KEY, BAK_KEY, TS_KEY,
    buildBackup, parseBackup, applyBackup, backupError,
    startedFromLocal, restoreFromIdb, restoreFromFs, fsFlush, itemType,
    needsUnlock, isEncrypted, isProtected, hasBackupPassword, hasFingerprint, canUnlockByPassword, bioAvailable,
    unlock, unlockFingerprint, setEncryption, removePassword, disableEncryption, relock, boot,
    onSave
  });
  return api;
})();