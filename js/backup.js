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

  const api = { render: function () {} };
  Object.assign(api, { exportBackup, importBackupFile, hashVal, doReset });
  return api;
})();