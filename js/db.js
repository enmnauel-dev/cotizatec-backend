var DB = (function () {
  const KEY = 'cotizatec_db_v1';

  const DEFAULT_SETTINGS = {
    businessName: 'Mi Taller / Técnico',
    phone: '',
    supportPhone: '',
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
    printerAddress: '',
    printerName: '',
    printerCols: 32,
    staffMode: false,
    staffPin: '',
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

  // Estados del conduce de entrega.
  const CONDUCE_STATUS = [
    { id: 'PENDIENTE', label: 'Pendiente', color: '#f59e0b' },
    { id: 'ENTREGADO', label: 'Entregado', color: '#10b981' },
    { id: 'ANULADO', label: 'Anulado', color: '#ef4444' }
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
      conduces: [],
      seq: { client: 0, catalog: 0, job: 0, expense: 0, payment: 0, conduce: 0 }
    };
  }

  const _seq = { client: 0, catalog: 0, job: 0, expense: 0, payment: 0, conduce: 0 };
  let state = null;
  let _idIndex = {};

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
     console.log('[CotizaTec] mkKeystoreGet: bio=' + !!bio);
     if (!bio) return Promise.resolve(null);
     return bio.getData({ key: MK_KEY })
       .then(function (res) { 
         console.log('[CotizaTec] mkKeystoreGet: res=' + JSON.stringify(res));
         return (res && res.value) || null; 
       })
       .catch(function (e) { console.error('[CotizaTec] mkKeystoreGet error:', e); return null; });
   }

   function bioVerify() {
     const bio = bioPlugin();
     console.log('[CotizaTec] bioVerify: bio=' + !!bio);
     if (!bio) return Promise.resolve({ verified: false, code: 99 });
     return bio.verifyIdentity({
       reason: 'Para desbloquear CotizaTec',
       title: 'Desbloquear CotizaTec',
       subtitle: 'Usa tu huella para continuar',
       negativeButtonText: 'Cancelar'
     }).then(function () { return { verified: true, code: 0 }; }).catch(function (e) {
       console.error('[CotizaTec] bioVerify error:', e);
       return { verified: false, code: (e && e.code) || 0 };
     });
   }

   // Códigos que NO deben reintentarse: user cancel (16/-11), negocio cancel,
   // lockout (4/2), hw no disponible (1). El resto (timeout/error genérico)
   // permite un reintento porque suelen ser fallos transitorios del prompt.
   function bioVerifyWithRetry(attempt) {
     attempt = attempt || 0;
     return bioVerify().then(function (r) {
       if (r.verified) return r;
       var nonRetry = r.code === 1 || r.code === 2 || r.code === 4 || r.code === 16;
       if (attempt < 1 && !nonRetry) {
         console.log('[CotizaTec] bioVerify: reintentando tras fallo transitorio code=' + r.code);
         return new Promise(function (res) { setTimeout(function () { res(bioVerifyWithRetry(attempt + 1)); }, 600); });
       }
       return r;
     });
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

  // Cifra el JSON del respaldo manual con una contraseña elegida por el usuario.
  function encryptBackupJson(jsonStr, password) {
    const salt = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(salt);
    return deriveKey(password, b64FromBuf(salt)).then(function (k) {
      const iv = new Uint8Array(12);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(iv);
      return subtle().encrypt({ name: 'AES-GCM', iv: iv }, k, new TextEncoder().encode(jsonStr))
        .then(function (ct) {
          return JSON.stringify({
            format: 'cotizatec-backup-enc',
            version: 1,
            app: 'CotizaTec',
            kdf: 'PBKDF2-SHA256',
            iter: ENC_ITER,
            salt: b64FromBuf(salt),
            iv: b64FromBuf(iv),
            ct: b64FromBuf(ct)
          }, null, 2);
        });
    });
  }

  // Descifra el respaldo manual. Devuelve el JSON plano o lanza Error con
  // código 'bad-pass' si la contraseña no es la correcta.
  function decryptBackupJson(encStr, password) {
    let o;
    try { o = JSON.parse(encStr); } catch (e) { return Promise.reject(new Error('bad-json')); }
    if (!o || o.format !== 'cotizatec-backup-enc' || !o.salt || !o.iv || !o.ct) return Promise.reject(new Error('bad-format'));
    return deriveKey(password, o.salt).then(function (k) {
      return subtle().decrypt({ name: 'AES-GCM', iv: bufFromB64(o.iv) }, k, bufFromB64(o.ct))
        .then(function (buf) { return new TextDecoder().decode(buf); })
        .catch(function () { throw new Error('bad-pass'); });
    });
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
    if (!(s && typeof s === 'object' &&
      Array.isArray(s.clients) && Array.isArray(s.catalog) && Array.isArray(s.jobs) &&
      s.settings && typeof s.settings === 'object')) return false;
    for (var i = 0; i < s.clients.length; i++) {
      if (!s.clients[i] || typeof s.clients[i] !== 'object' || !s.clients[i].id) return false;
    }
    for (var i = 0; i < s.catalog.length; i++) {
      if (!s.catalog[i] || typeof s.catalog[i] !== 'object' || !s.catalog[i].id) return false;
    }
    for (var i = 0; i < s.jobs.length; i++) {
      if (!s.jobs[i] || typeof s.jobs[i] !== 'object') return false;
    }
    return true;
  }

  function normalize(s) {
    if (!s.settings) s.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    if (!s.seq) s.seq = { client: 0, catalog: 0, job: 0, expense: 0, payment: 0 };
    if (!s.catalog) s.catalog = [];
    if (!s.clients) s.clients = [];
    if (!s.jobs) s.jobs = [];
    if (!s.conduces) s.conduces = [];
    if (!s.auditLog) s.auditLog = [];
    if (!s.stockEntries) s.stockEntries = [];
    if (!Array.isArray(s.settings.itemTypes)) s.settings.itemTypes = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.itemTypes));
    if (!s.settings.docTitle) s.settings.docTitle = DEFAULT_SETTINGS.docTitle;
    if (typeof s.settings.staffMode !== 'boolean') s.settings.staffMode = false;
    if (typeof s.settings.staffPin !== 'string') s.settings.staffPin = '';
    if (!s.settings.conducePrefix) s.settings.conducePrefix = 'CON';
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
    _seq.expense = t.expense || 0; _seq.payment = t.payment || 0; _seq.conduce = t.conduce || 0;
    state = s;
    rebuildIndex(s);
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
    state.seq = { client: _seq.client, catalog: _seq.catalog, job: _seq.job, expense: _seq.expense, payment: _seq.payment, conduce: _seq.conduce };
    if (_encKey) { scheduleEncSave(); notifySave(); return; }
    try {
      var jsonStr = JSON.stringify(state);
      if (!skipMirror) mirrorWrite(jsonStr);
      if (!skipMirror) fsWriteDebounced();
      var current = localStorage.getItem(KEY);
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
      let env = null;
      try { const raw = localStorage.getItem(KEY); if (raw) env = parseEnvelope(raw); } catch (e) {}
      if (env) return env;
      // Respaldo 1: espejo IndexedDB (localStorage pudo ser evacuado por el WebView).
      return readMirror().then(function (row) {
        if (row && row.value) { const e2 = parseEnvelope(row.value); if (e2) return e2; }
        // Respaldo 2: archivo nativo (DATA).
        const FS = fsPlugin();
        if (FS && typeof Util !== 'undefined' && Util.isNativeEnv && Util.isNativeEnv()) {
          return FS.readFile({ path: FS_KEY, directory: 'DATA' })
            .then(function (res) { const s = fsDecode(res && res.data); const e3 = s ? parseEnvelope(s) : null; return e3 || null; })
            .catch(function () { return null; });
        }
        return null;
      }).catch(function () { return null; });
    }).then(function (env) {
      if (env) { _envelope = env; _encKey = null; _mkRaw = null; _mkStored = false; return true; }
      // Último recurso: no se encontró envelope en ninguna capa. Si aún tenemos la
      // clave en memoria, re-ciframos el estado actual para poder bloquear de verdad.
      if (_encKey && state) {
        return encryptState(JSON.stringify(state), _encKey).then(function (e) {
          _envelope = e; _encKey = null; _mkRaw = null; _mkStored = false; return true;
        }).catch(function () { return false; });
      }
      return false;
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

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
    if (obj && obj.id) _idIndex[obj.id] = obj;
    save();
    return obj;
  }

  function find(list, id) {
    var sid = String(id);
    if (_idIndex[sid] && state[list].indexOf(_idIndex[sid]) >= 0) return _idIndex[sid];
    var found = state[list].find(x => String(x.id) === sid);
    if (found) _idIndex[sid] = found;
    return found;
  }

  function rebuildIndex(src) {
    src = src || state || {};
    _idIndex = {};
    ['clients', 'catalog', 'jobs', 'conduces'].forEach(function (list) {
      (src[list] || []).forEach(function (item) {
        if (item && item.id) _idIndex[String(item.id)] = item;
      });
    });
  }

  function update(list, id, patch) {
    const it = find(list, id);
    if (it) { Object.assign(it, patch); save(); }
    return it;
  }

  function remove(list, id) {
    state[list] = state[list].filter(x => String(x.id) !== String(id));
    delete _idIndex[String(id)];
    save();
  }

  function jobTotals(j) {
    const subtotal = (j.items || []).reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
    const discount = Number(j.discount) || 0;
    const taxable = Math.max(0, subtotal - discount);
    const itbis = Number(j.itbis) || 0;
    const tax = itbis > 0 ? taxable * itbis / 100 : 0;
    const total = taxable + tax;
    const itemsCost = (j.items || []).reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.cost) || 0), 0);
    const expenses = (j.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0);
    const cost = itemsCost + expenses;
    const collected = (j.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
    const balance = Math.max(0, total - collected);
    const margin = total - cost;
    return { subtotal, discount, itbis, tax, total, itemsCost, expenses, cost, collected, balance, margin };
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

  // ===== Conduces de entrega =====
  function conduceStatusLabel(id) {
    const s = CONDUCE_STATUS.find(x => x.id === id);
    return s ? s.label : id;
  }

  function conduceStatusColor(id) {
    const s = CONDUCE_STATUS.find(x => x.id === id);
    return s ? s.color : '#6b7280';
  }

  // Crea (sin guardar) un conduce a partir de un trabajo/cotizacion.
  function newConduce(job) {
    const c = (job && job.clientId) ? find('clients', job.clientId) : null;
    const items = ((job && job.items) || []).map(function (it) {
      return {
        desc: it.desc || '',
        qty: Number(it.qty) || 0,
        price: Number(it.price) || 0,
        type: it.type || 'PRODUCTO',
        unit: it.unit || '',
        catalogId: it.catalogId || null,
        catalogQty: Number(it.catalogQty) || 1
      };
    });
    return {
      id: uid(),
      code: '',
      jobId: (job && job.id) || null,
      jobCode: (job && job.code) || '',
      clientId: (job && job.clientId) || null,
      clientName: (c && c.name) || (job && job.clientName) || '',
      clientPhone: (c && c.phone) || (job && job.clientPhone) || '',
      clientAddress: (c && c.address) || '',
      date: new Date().toISOString(),
      items: items,
      status: 'PENDIENTE',
      notes: '',
      deliveredBy: '',
      receivedBy: '',
      stockApplied: false
    };
  }

  // Correlativo: CON-000001, CON-000002, ...
  function nextConduceNumber() {
    const prefix = (state && state.settings && state.settings.conducePrefix) || 'CON';
    const n = incr('conduce');
    return prefix + '-' + String(n).padStart(6, '0');
  }

  function saveConduce(c) {
    if (!c.code) c.code = nextConduceNumber();
    const i = state.conduces.findIndex(x => String(x.id) === String(c.id));
    if (i >= 0) state.conduces[i] = c; else state.conduces.unshift(c);
    save();
    return c;
  }

  function conduceTotals(c) {
    const items = (c && c.items) || [];
    const subtotal = items.reduce(function (a, i) { return a + (Number(i.qty) || 0) * (Number(i.price) || 0); }, 0);
    const units = items.reduce(function (a, i) { return a + (Number(i.qty) || 0); }, 0);
    return { subtotal: subtotal, units: units, count: items.length };
  }

  // Compara lo despachado con el stock del catalogo (solo items con stock numerico).
  function conduceStockCheck(c) {
    const out = [];
    ((c && c.items) || []).forEach(function (it) {
      if (!it.catalogId) return;
      const p = find('catalog', it.catalogId);
      if (!p) return;
      if (p.stock === null || p.stock === undefined || p.stock === '') return;
      const need = (Number(it.qty) || 0) * (Number(it.catalogQty) || 1);
      const have = Number(p.stock) || 0;
      out.push({ id: p.id, desc: it.desc, need: need, available: have, ok: have >= need });
    });
    return out;
  }

  // Descuenta stock. No aplica nada si algun item controlado no alcanza.
  function conduceApplyStock(c) {
    const check = conduceStockCheck(c);
    const missing = check.filter(function (x) { return !x.ok; });
    if (missing.length) return { ok: false, missing: missing, applied: 0 };
    check.forEach(function (x) {
      const p = find('catalog', x.id);
      if (p) p.stock = Math.max(0, (Number(p.stock) || 0) - x.need);
    });
    c.stockApplied = check.length > 0;
    save();
    return { ok: true, missing: [], applied: check.length };
  }

  // Devuelve el stock si el conduce se anula.
  function conduceRestoreStock(c) {
    if (!c || !c.stockApplied) return false;
    ((c.items) || []).forEach(function (it) {
      if (!it.catalogId) return;
      const p = find('catalog', it.catalogId);
      if (!p) return;
      if (p.stock === null || p.stock === undefined || p.stock === '') return;
      p.stock = (Number(p.stock) || 0) + (Number(it.qty) || 0) * (Number(it.catalogQty) || 1);
    });
    c.stockApplied = false;
    save();
    return true;
  }

  function conducesForJob(jobId) {
    return (state.conduces || []).filter(function (c) { return String(c.jobId) === String(jobId); });
  }
  // ===== Entradas de inventario (compras a proveedor) =====
  function registerStockEntry(catalogId, qty, unitCost, supplier, notes) {
    const it = find('catalog', catalogId);
    if (!it) return null;
    const q = Number(qty) || 0;
    if (q <= 0) return null;
    it.stock = (Number(it.stock) || 0) + q;
    if (unitCost != null && unitCost !== '' && !isNaN(Number(unitCost)) && Number(unitCost) >= 0) {
      it.cost = Number(unitCost);
    }
    if (!state.stockEntries) state.stockEntries = [];
    const entry = {
      id: uid(),
      catalogId: it.id,
      productName: it.name,
      qty: q,
      unitCost: (unitCost != null && unitCost !== '' && !isNaN(Number(unitCost))) ? Number(unitCost) : null,
      supplier: supplier || '',
      notes: notes || '',
      date: new Date().toISOString()
    };
    state.stockEntries.unshift(entry);
    save();
    return entry;
  }
  function audit(action, detail) {
    if (!state) return;
    if (!state.auditLog) state.auditLog = [];
    state.auditLog.unshift({
      id: uid(),
      ts: new Date().toISOString(),
      role: (state.settings && state.settings.staffMode) ? 'operador' : 'admin',
      action: String(action || ''),
      detail: String(detail || '')
    });
    if (state.auditLog.length > 500) state.auditLog.length = 500;
    save();
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
     if (!(meta && meta.v === 2)) return false;
     // fp === false: la clave maestra no está (o ya no está) en el keystore,
     // aunque meta.v sea 2 (p. ej. protección solo con contraseña). En ese caso
     // no se debe ofrecer el desbloqueo por huella. (Sin 'fp' = metadato legado.)
     if (meta.fp === false) return false;
     const bio = bioPlugin();
     return !!bio;
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

    // Desbloquea con la huella. Primero verifica la identidad biométrica
    // (prompt simple sin CryptoObject, compatible con la biometría débil del
    // Redmi A5) y luego lee la clave maestra desde el keystore.
    // Retorna: { ok: true } si todo bien, { ok: false, reason: 'bio' } si
    // la biometría falló, { ok: false, reason: 'decrypt' } si la huella fue
    // verificada pero el descifrado falló (clave no coincide).
    function unlockFingerprint() {
      console.log('[CotizaTec] unlockFingerprint: _envelope=' + !!_envelope);
      if (!_envelope) { console.log('[CotizaTec] unlockFingerprint: no _envelope'); return Promise.resolve({ ok: false, reason: 'none' }); }
      return bioVerifyWithRetry().then(function (vr) {
        console.log('[CotizaTec] unlockFingerprint: verified=' + vr.verified + ' code=' + vr.code);
        if (!vr.verified) { console.log('[CotizaTec] unlockFingerprint: bio failed'); return { ok: false, reason: 'bio' }; }
        return mkFromKeystore().then(function (mkRaw) {
          console.log('[CotizaTec] unlockFingerprint: mkRaw=' + !!mkRaw);
          if (!mkRaw) { console.log('[CotizaTec] unlockFingerprint: mkRaw null, marcando huella no disponible'); try { const m = readEncMeta(); if (m) { m.fp = false; writeEncMeta(m); } } catch (e) {} return { ok: false, reason: 'decrypt' }; }
          return importMk(mkRaw).then(function (key) {
            return decryptAndLoad(key).then(function (ok) {
              console.log('[CotizaTec] unlockFingerprint: decrypt=' + ok);
              if (!ok) { console.log('[CotizaTec] unlockFingerprint: decrypt failed'); return { ok: false, reason: 'decrypt' }; }
              _mkRaw = mkRaw;
              return { ok: true };
            });
          });
        });
      }).catch(function (e) { console.error('[CotizaTec] unlockFingerprint error:', e); return { ok: false, reason: 'error' }; });
    }

  // Desbloquea con la contraseña (respaldo o esquema legado v1). Devuelve true si OK.
  // En el esquema v1 (cifrado directo con la contraseña) descifra y carga sin
  // migrar todavía: la clave v1 se mantiene para re-guardar. La migración al
  // esquema de clave maestra ocurre al activar la protección (huella/contraseña),
  // momento en que el usuario puede autenticarse con biometría.
   function unlock(password) {
     console.log('[CotizaTec] unlock: _envelope=' + !!_envelope + ' password.length=' + password.length);
     if (!_envelope) { console.log('[CotizaTec] unlock: no _envelope'); return Promise.resolve(false); }
     const meta = readEncMeta();
     if (!meta) { console.log('[CotizaTec] unlock: no meta'); return Promise.resolve(false); }
     console.log('[CotizaTec] unlock: meta.wrap=' + !!meta.wrap);
     if (meta.wrap) {
       return unwrapMk(password, meta.wrap).then(function (mkRaw) {
         console.log('[CotizaTec] unlock: mkRaw=' + !!mkRaw);
         if (!mkRaw) return false;
         return importMk(mkRaw).then(function (key) {
           return decryptAndLoad(key).then(function (ok) {
             console.log('[CotizaTec] unlock: decrypt=' + ok);
             if (!ok) return false;
             _mkRaw = mkRaw;
             return true;
           });
         });
       }).catch(function (e) { console.error('[CotizaTec] unlock: unwrap error', e); return false; });
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
        writeEncMeta({ v: 2, wrap: wrap, fp: !!keystoreOk });
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
    if (state && state.settings) {
      state.settings.lockOnStart = false;
      state.settings.relockOnResume = false;
      state.settings.resetPassword = '';
    }
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

  // ===== Modo vendedor (rol empleado) + PIN del dueño =====
  // Protege el catálogo y los precios en el equipo. Es una barrera anti-error
  // local (no un control servidor), pensada para el teléfono compartido del negocio.
  function _hex(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }

  function _randHex(n) {
    const a = new Uint8Array(n);
    try {
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
      else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    } catch (e) {
      for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
    }
    return _hex(a);
  }

  // Respaldo síncrono (FNV-1a) por si el entorno no tiene WebCrypto (p. ej. tests).
  function _fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function hashPin(pin, salt) {
    const sub = subtle();
    if (sub && sub.digest && typeof TextEncoder !== 'undefined') {
      return sub.digest('SHA-256', new TextEncoder().encode(salt + '::' + String(pin)))
        .then(function (buf) { return _hex(buf); })
        .catch(function () { return _fnv(salt + '::' + String(pin)); });
    }
    return Promise.resolve(_fnv(salt + '::' + String(pin)));
  }

  function isStaffMode() {
    return !!(state && state.settings && state.settings.staffMode);
  }

  function hasStaffPin() {
    return !!(state && state.settings && state.settings.staffPin);
  }

  function setStaffPin(pin) {
    const salt = _randHex(16);
    return hashPin(pin, salt).then(function (h) {
      if (state && state.settings) state.settings.staffPin = salt + ':' + h;
      return h;
    });
  }

  function verifyStaffPin(pin) {
    const stored = state && state.settings && state.settings.staffPin;
    if (!stored) return Promise.resolve(false);
    const idx = String(stored).indexOf(':');
    const salt = idx >= 0 ? String(stored).slice(0, idx) : '';
    const h = idx >= 0 ? String(stored).slice(idx + 1) : String(stored);
    return hashPin(pin, salt).then(function (x) { return x === h; });
  }

  function setStaffMode(on) {
    if (state && state.settings) state.settings.staffMode = !!on;
  }

  function clearStaffPin() {
    if (state && state.settings) { state.settings.staffPin = ''; state.settings.staffMode = false; }
  }

  // Permisos del operador (descargados desde la web). Por defecto restrictivos.
  function _opPerms() {
    const p = state && state.settings && state.settings.operatorPermissions;
    return p || { canCreateConduce: true, canRegisterStockEntry: true, showCosts: false, showMargins: false, requireSupervisorPin: true };
  }
  function showCosts() { if (!isStaffMode()) return true; return !!_opPerms().showCosts; }
  function showMargins() { if (!isStaffMode()) return true; return !!_opPerms().showMargins; }
  function canCreateConduce() { if (!isStaffMode()) return true; return _opPerms().canCreateConduce !== false; }
  function canRegisterStockEntry() { if (!isStaffMode()) return true; return _opPerms().canRegisterStockEntry !== false; }
  function requireSupervisorPin() { if (!isStaffMode()) return false; return _opPerms().requireSupervisorPin !== false; }

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
   Object.defineProperty(api, 'state', { get: function () { return state; }, set: function (v) { state = v; }, enumerable: true, configurable: true });
   Object.assign(api, {
     load, save, incr, esc, money, date, push, find, update, remove, uid,
     jobTotals, newJob, saveJob, captureClient,
     CONDUCE_STATUS, conduceStatusLabel, conduceStatusColor, newConduce, saveConduce,
     registerStockEntry,
     conduceTotals, conduceStockCheck, conduceApplyStock, conduceRestoreStock, conducesForJob, nextConduceNumber,
     statusLabel, statusColor, STATUS, KEY, BAK_KEY, TS_KEY, FS_KEY, ENC_META,
     buildBackup, parseBackup, applyBackup, backupError,
     encryptBackupJson, decryptBackupJson,
     startedFromLocal, restoreFromIdb, restoreFromFs, fsFlush, itemType,
     needsUnlock, isEncrypted, isProtected, hasBackupPassword, hasFingerprint, canUnlockByPassword, bioAvailable, mkKeystoreExists,
     unlock, unlockFingerprint, setEncryption, removePassword, disableEncryption, relock, boot, blankState,
     isStaffMode, hasStaffPin, setStaffPin, verifyStaffPin, setStaffMode, clearStaffPin,
     onSave
  });
  return api;
})();