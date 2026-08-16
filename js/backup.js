var Backups = (function () {
  function exportBackup() {
    const json = DB.buildBackup();
    const d = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const fname = 'cotizatec-respaldo-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    const FS = Util.capacitorPlugin('Filesystem');
    if (Util.isNativeEnv() && FS) {
      const b64 = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
      FS.writeFile({ path: fname, directory: 'CACHE', data: b64 })
        .then(function () { return FS.getUri({ path: fname, directory: 'CACHE' }); })
        .then(function (res) {
          const SH = Util.capacitorPlugin('Share');
          if (!SH) { Util.toast('No se pudo compartir el respaldo', false); return null; }
          return SH.share({ files: [res.uri], title: fname, dialogTitle: 'Guardar respaldo en OneDrive / Drive' });
        })
        .then(function () { Util.toast('Respaldo creado: elige dónde guardarlo', true); })
        .catch(function (e) {
          console.error('BK_ERR ' + (e && e.message));
          Util.toast('Respaldo: ' + ((e && e.message) || 'error al compartir'), false);
        });
      return;
    }
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      Util.toast('Respaldo generado', true);
    } catch (e) {
      Util.toast('No se pudo generar el respaldo', false);
    }
  }

  function importBackupFile(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = function (ev) {
      const d = DB.parseBackup(ev.target.result);
      if (!d) { Util.toast(DB.backupError(ev.target.result), false); return; }
      if (!Util.confirmar('Esta acción reemplazará los datos actuales por los del respaldo. ¿Deseas continuar?')) return;
      DB.applyBackup(d);
      Media.recompressExisting();
      Backups.render();
      Util.toast('Respaldo restaurado', true);
    };
    r.onerror = function () { Util.toast('No se pudo leer el archivo', false); };
    r.readAsText(file);
  }

  function hashVal(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) + h + str.charCodeAt(i)) & 0xffffffff; }
    return 'h' + (h >>> 0).toString(36);
  }

  function doReset() {
    localStorage.removeItem(DB.KEY);
    localStorage.removeItem(DB.BAK_KEY);
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
        return fetch(CLOUD_BASE + '/api/backup/claim/' + encodeURIComponent(deviceId))
          .then(function (r) { return r.json(); })
          .then(function (claim) {
            if (!(claim && claim.ok && claim.oldDeviceId)) return false;
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
          });
      })
      .catch(function () {
        return false;
      });
  }

  const api = { render: function () {} };
  Object.assign(api, { exportBackup, importBackupFile, hashVal, doReset, pushToCloud, pullFromCloud });

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