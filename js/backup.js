var Backups = (function () {
  function exportBackup() {
    // Pide una contraseña para cifrar el respaldo antes de generarlo.
    const sheet = document.createElement('div');
    sheet.id = 'sheet-holder';
    sheet.innerHTML = '<div class="sheet"><div class="sheet-head"><b>' + Util.SAVE_ICON + ' Crear respaldo protegido</b><button class="icon-btn" data-action="closeSheet">' + Util.X_ICON + '</button></div><div class="sheet-body">' +
      '<p class="muted">El archivo se cifrará con una contraseña. Sin ella no se podrá restaurar.</p>' +
      '<input id="bk-pass" class="sheet-input" type="password" placeholder="Contraseña (mínimo 4 caracteres)" autocomplete="off">' +
      '<input id="bk-pass2" class="sheet-input" type="password" placeholder="Repite la contraseña" autocomplete="off">' +
      '<button class="btn primary block" data-action="doExportBackup">' + Util.SAVE_ICON + ' Crear respaldo cifrado</button>' +
      '</div></div>';
    document.body.appendChild(sheet);
    setTimeout(function () { const i = document.getElementById('bk-pass'); if (i) i.focus(); }, 50);
  }

  function doExportBackup() {
    const p1 = (document.getElementById('bk-pass') || {}).value || '';
    const p2 = (document.getElementById('bk-pass2') || {}).value || '';
    if (p1.length < 4) { Util.toast('La contraseña debe tener al menos 4 caracteres', false); return; }
    if (p1 !== p2) { Util.toast('Las contraseñas no coinciden', false); return; }
    const json = DB.buildBackup();
    DB.encryptBackupJson(json, p1).then(function (enc) {
      const sh = document.getElementById('sheet-holder');
      if (sh) sh.remove();
      writeBackupFile(enc);
    }).catch(function (e) {
      Util.toast('No se pudo cifrar el respaldo', false);
      console.error('BK_ERR ' + (e && e.message));
    });
  }

  function writeBackupFile(content) {
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const fname = 'cotizatec-respaldo-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.cotizatec';
    const FS = Util.capacitorPlugin('Filesystem');
    if (Util.isNativeEnv() && FS) {
      const b64 = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(content)));
      FS.writeFile({ path: fname, directory: 'CACHE', data: b64 })
        .then(function () { return FS.getUri({ path: fname, directory: 'CACHE' }); })
        .then(function (res) {
          const SH = Util.capacitorPlugin('Share');
          if (!SH) { Util.toast('No se pudo compartir el respaldo', false); return null; }
          return SH.share({ files: [res.uri], title: fname, dialogTitle: 'Guardar respaldo en OneDrive / Drive' });
        })
        .then(function () { Util.toast('Respaldo cifrado creado: elige dónde guardarlo', true); })
        .catch(function (e) {
          console.error('BK_ERR ' + (e && e.message));
          Util.toast('Respaldo: ' + ((e && e.message) || 'error al compartir'), false);
        });
      return;
    }
    try {
      const blob = new Blob([content], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      Util.toast('Respaldo cifrado generado', true);
    } catch (e) {
      Util.toast('No se pudo generar el respaldo', false);
    }
  }

  function importBackupFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = function (ev) {
      const text = String(ev.target.result || '');
      // ¿Es un respaldo cifrado? Detecta el formato y pide la contraseña.
      let isEnc = false;
      try { const o = JSON.parse(text.replace(/^\uFEFF/, '').trim()); isEnc = !!(o && o.format === 'cotizatec-backup-enc'); } catch (e) { isEnc = false; }
      if (isEnc) {
        const sheet = document.createElement('div');
        sheet.id = 'sheet-holder';
        sheet.innerHTML = '<div class="sheet"><div class="sheet-head"><b>' + Util.LOCK_ICON + ' Restaurar respaldo protegido</b><button class="icon-btn" data-action="closeSheet">' + Util.X_ICON + '</button></div><div class="sheet-body">' +
          '<p class="muted">Este respaldo está cifrado. Escribe la contraseña para descifrarlo.</p>' +
          '<input id="bk-pass" class="sheet-input" type="password" placeholder="Contraseña" autocomplete="off">' +
          '<button class="btn primary block" data-action="doImportBackup">' + Util.CHECK_ICON + ' Descifrar y restaurar</button>' +
          '</div></div>';
        document.body.appendChild(sheet);
        window.__bkEncText = text;
        setTimeout(function () { const i = document.getElementById('bk-pass'); if (i) i.focus(); }, 50);
        return;
      }
      const d = DB.parseBackup(text);
      if (!d) { Util.toast(DB.backupError(text), false); return; }
      applyRestore(d);
    };
    r.onerror = function () { Util.toast('No se pudo leer el archivo', false); };
    r.readAsText(file);
  }

  function doImportBackup() {
    const p = (document.getElementById('bk-pass') || {}).value || '';
    const text = window.__bkEncText || '';
    if (!p) { Util.toast('Escribe la contraseña', false); return; }
    DB.decryptBackupJson(text, p).then(function (json) {
      window.__bkEncText = null;
      const sh = document.getElementById('sheet-holder');
      if (sh) sh.remove();
      const d = DB.parseBackup(json);
      if (!d) { Util.toast(DB.backupError(json), false); return; }
      if (!Util.confirmar('Esta acción reemplazará los datos actuales por los del respaldo. ¿Deseas continuar?')) return;
      applyRestore(d);
    }).catch(function (e) {
      if (e && e.message === 'bad-pass') { Util.toast('Contraseña incorrecta', false); return; }
      Util.toast('No se pudo descifrar el respaldo', false);
    });
  }

  function applyRestore(d) {
    if (!Util.confirmar('Esta acción reemplazará los datos actuales por los del respaldo. ¿Deseas continuar?')) return;
    DB.applyBackup(d);
    Media.recompressExisting();
    Backups.render();
    Util.toast('Respaldo restaurado', true);
  }

  function hashVal(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) & 0xffffffff; }
    return 'h' + (h >>> 0).toString(36);
  }

  function doReset() {
    // Marcar para que, al recargar, NO se restaure el respaldo de la nube del
    // mismo deviceId (si no, los datos "vuelven" y el reinicio no pone en cero).
    try { localStorage.setItem('cotizatec_skip_cloud_restore', '1'); } catch (e) {}
    // Borrar los 3 almacenes: localStorage, espejo IndexedDB y archivo nativo.
    localStorage.removeItem(DB.KEY);
    localStorage.removeItem(DB.BAK_KEY);
    localStorage.removeItem(DB.TS_KEY);
    try { localStorage.removeItem(DB.ENC_META); } catch (e) {}
    const FS = Util.capacitorPlugin('Filesystem');
    if (Util.isNativeEnv() && FS && FS.deleteFile) {
      FS.deleteFile({ path: DB.FS_KEY, directory: 'DATA' }).catch(function () {});
    }
    try {
      const req = indexedDB.open('cotizatec_idb_v1', 1);
      req.onsuccess = function () {
        const db = req.result;
        try { db.transaction('kv', 'readwrite').objectStore('kv').delete('state'); } catch (e) {}
        try { db.close(); } catch (e) {}
      };
    } catch (e) {}
    window.location.hash = '#/';
    location.reload();
  }

  // ===== Respaldo en la nube (cifrado) =====
  // Los datos se cifran en el dispositivo con AES-GCM antes de subirlos al
  // servidor, por lo que este solo almacena un blob ilegible. La clave se
  // deriva del deviceId + secreto embebido (PBKDF2).

  const CLOUD_SECRET = 'cotizatec-cloud-backup-v1';
  const ENC_ITER = 120000;
  const CLOUD_BASE = (typeof LICENCE_SERVER_BASE !== 'undefined' && LICENCE_SERVER_BASE) ? LICENCE_SERVER_BASE : 'https://cotizatec-backend.onrender.com';

  function _subtle() {
    try { return (window.crypto || {}).subtle || null; } catch (e) { return null; }
  }

  function _b64(buf) {
    const b = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    try { return btoa(bin); } catch (e) { return null; }
  }

  function _unb64(s) {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  function _cloudKey(deviceId) {
    const sub = _subtle();
    if (!sub) return Promise.resolve(null);
    return sub.importKey('raw', new TextEncoder().encode(CLOUD_SECRET + '::' + deviceId), 'PBKDF2', false, ['deriveKey'])
      .then(function (mat) {
        return sub.deriveKey(
          { name: 'PBKDF2', salt: _unb64('Y290aXphdGVjLWNsb3VkLXNhbHQ='), iterations: ENC_ITER, hash: 'SHA-256' },
          mat, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  function _encryptData(deviceId, jsonStr) {
    return _cloudKey(deviceId).then(function (key) {
      if (!key) return null;
      const iv = new Uint8Array(12);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(iv);
      return window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(jsonStr))
        .then(function (ct) {
          return JSON.stringify({ enc: 'aes-gcm', v: 1, iv: _b64(iv), ct: _b64(ct) });
        });
    });
  }

  function _decryptData(deviceId, envStr) {
    let env;
    try { env = JSON.parse(envStr); } catch (e) { return Promise.resolve(null); }
    if (!env || env.enc !== 'aes-gcm' || !env.iv || !env.ct) return Promise.resolve(null);
    return _cloudKey(deviceId).then(function (key) {
      if (!key) return null;
      return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: _unb64(env.iv) }, key, _unb64(env.ct))
        .then(function (buf) { return new TextDecoder().decode(buf); })
        .catch(function () { return null; });
    });
  }

  // Sube el respaldo cifrado al servidor. Devuelve true si se guardó.
  function pushToCloud(deviceId) {
    if (typeof fetch === 'undefined') return Promise.resolve(false);
    const json = DB.buildBackup();
    if (!json) return Promise.resolve(false);
    return _encryptData(deviceId, json).then(function (encrypted) {
      if (!encrypted) return false;
      return fetch(CLOUD_BASE + '/api/backup/' + encodeURIComponent(deviceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: encrypted })
      }).then(function (r) {
        return r.ok || r.status === 200;
      }).catch(function () {
        return false;
      });
    }).catch(function () {
      return false;
    });
  }

  // Descarga y restaura el respaldo desde el servidor (solo si no hay datos
  // locales). Devuelve true si se restauró correctamente.
  // Si el propio deviceId no tiene respaldo, consulta si existe un "reclamo"
  // de migración (equipo viejo -> equipo nuevo): descarga el respaldo del
  // equipo viejo, lo descifra con la clave de ESE deviceId, lo aplica y lo
  // re-cifra con la clave propia para dejar el respaldo bajo el ID nuevo.
  function pullFromCloud(deviceId) {
    if (typeof fetch === 'undefined') return Promise.resolve(false);
    // Prioridad: si existe un reclamo de migración, se restaura ESE respaldo
    // (equipo viejo -> equipo nuevo) y se re-cifra bajo el ID propio. Solo si no
    // hay reclamo se restaura el respaldo propio del dispositivo.
    return fetch(CLOUD_BASE + '/api/backup/claim/' + encodeURIComponent(deviceId))
      .then(function (r) { return r.json(); })
      .then(function (claim) {
        if (claim && claim.ok && claim.oldDeviceId) {
          return fetch(CLOUD_BASE + '/api/backup/' + encodeURIComponent(claim.oldDeviceId))
            .then(function (r) { return r.json(); })
            .then(function (oldBody) {
              if (!(oldBody && oldBody.ok && oldBody.data)) return false;
              return _decryptData(claim.oldDeviceId, oldBody.data).then(function (jsonStr) {
                if (!jsonStr) return false;
                const d = DB.parseBackup(jsonStr);
                if (!d) return false;
                DB.applyBackup(d);
                Media.recompressExisting();
                return pushToCloud(deviceId).then(function () {
                  return fetch(CLOUD_BASE + '/api/backup/claim/' + encodeURIComponent(deviceId) + '/resolve', { method: 'POST' })
                    .then(function () { return true; })
                    .catch(function () { return true; });
                });
              });
            });
        }
        return fetch(CLOUD_BASE + '/api/backup/' + encodeURIComponent(deviceId))
          .then(function (r) { return r.json(); })
          .then(function (body) {
            if (body && body.ok && body.data) {
              return _decryptData(deviceId, body.data).then(function (jsonStr) {
                if (!jsonStr) return false;
                const d = DB.parseBackup(jsonStr);
                if (!d) return false;
                DB.applyBackup(d);
                Media.recompressExisting();
                return true;
              });
            }
            return false;
          });
      })
      .catch(function () {
        return false;
      });
  }

  const api = { render: function () {} };
  Object.assign(api, { exportBackup, importBackupFile, doExportBackup, doImportBackup, hashVal, doReset, pushToCloud, pullFromCloud });

  // Auto-respaldo: cada vez que se guardan datos locales, se sube el respaldo
  // cifrado a la nube (debounce para agrupar cambios consecutivos).
  let _autoTimer = null;
  function _autoPush() {
    if (_autoTimer) clearTimeout(_autoTimer);
    _autoTimer = setTimeout(function () {
      if (typeof License === 'undefined' || !License.getDeviceId) return;
      License.getDeviceId().then(function (deviceId) {
        if (!deviceId) return;
        Backups.pushToCloud(deviceId);
      }).catch(function () {});
    }, 2500);
  }
  if (typeof DB !== 'undefined' && DB.onSave) DB.onSave(_autoPush);

  return api;
})();