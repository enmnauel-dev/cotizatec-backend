var Lock = (function () {
  let unlocked = false;

  function bioApi() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NativeBiometric) || null;
  }

  function appPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) || null;
  }

  function unlockApp() {
    unlocked = true;
    const o = document.getElementById('lock-screen');
    if (o) o.remove();
  }

  function resetLock() {
    unlocked = false;
  }

  function showPasswordField() {
    const p = document.getElementById('lock-pwd-wrap');
    if (p) p.style.display = 'block';
    const b = document.getElementById('lock-bio-btn');
    if (b) b.style.display = 'none';
  }

  function lockOverlayHtml(bioAvailable, hasPwd) {
    let html = '<div id="lock-screen"><div class="lock-card">';
    html += '<div class="lock-ic">' + Util.LOCK_ICON + '</div>';
    html += '<b>CotizaTec</b>';
    html += '<p class="muted">App bloqueada. Desbloquéala para continuar.</p>';
    if (bioAvailable) {
      html += '<button class="btn primary block" data-action="bioUnlock" id="lock-bio-btn">' + Util.LOCK_ICON + ' Desbloquear con huella</button>';
      if (hasPwd) html += '<button class="btn ghost block" type="button" data-action="togglePwd" id="lock-pwd-toggle">Usar contraseña</button>';
    }
    html += '<div id="lock-pwd-wrap"' + (bioAvailable && hasPwd ? ' style="display:none"' : '') + '>';
    if (hasPwd) {
      html += '<input id="lock-pwd-input" class="sheet-input" type="password" placeholder="Contraseña">';
      html += '<button class="btn block" data-action="passwordUnlock">' + Util.CHECK_ICON + ' Entrar</button>';
    } else if (!bioAvailable) {
      html += '<p class="muted">No hay huella ni contraseña disponibles.</p>';
      html += '<button class="btn block" data-action="forceUnlock">' + Util.CHECK_ICON + ' Entrar de todos modos</button>';
    }
    html += '</div></div></div>';
    return html;
  }

  function buildOverlay(protectedApp, hasPwd, fingerprintActive) {
    const bio = bioApi();
    if (bio && protectedApp) {
      Promise.resolve(bio.isAvailable({ useFallback: false })).then(function (r) {
        const avail = !!(r && r.isAvailable) && fingerprintActive;
        if (!avail && !hasPwd) { unlockApp(); return; }
        const old = document.getElementById('lock-screen');
        if (old) old.remove();
        const d = document.createElement('div');
        d.innerHTML = lockOverlayHtml(avail, hasPwd);
        document.body.appendChild(d.firstChild);
      }).catch(function () {
        if (!hasPwd) { unlockApp(); return; }
        const old = document.getElementById('lock-screen');
        if (old) old.remove();
        const d = document.createElement('div');
        d.innerHTML = lockOverlayHtml(false, hasPwd);
        document.body.appendChild(d.firstChild);
      });
    } else if (bio) {
      Promise.resolve(bio.isAvailable({ useFallback: false })).then(function (r) {
        const avail = !!(r && r.isAvailable) && fingerprintActive;
        if (!avail && !hasPwd) { unlockApp(); return; }
        const old = document.getElementById('lock-screen');
        if (old) old.remove();
        const d = document.createElement('div');
        d.innerHTML = lockOverlayHtml(avail, hasPwd);
        document.body.appendChild(d.firstChild);
      }).catch(function () {
        if (!hasPwd) { unlockApp(); return; }
        const old = document.getElementById('lock-screen');
        if (old) old.remove();
        const d = document.createElement('div');
        d.innerHTML = lockOverlayHtml(false, hasPwd);
        document.body.appendChild(d.firstChild);
      });
    } else {
      if (!hasPwd) { unlockApp(); return; }
      const old = document.getElementById('lock-screen');
      if (old) old.remove();
      const d = document.createElement('div');
      d.innerHTML = lockOverlayHtml(false, hasPwd);
      document.body.appendChild(d.firstChild);
    }
  }

  function applyLockScreen(force) {
    if (force !== true && (!DB.state.settings.lockOnStart || unlocked)) {
      const o = document.getElementById('lock-screen');
      if (o) o.remove();
      return;
    }
    const doRelock = (force === true && !DB.needsUnlock() && DB.isProtected());
    if (doRelock) {
      Promise.resolve(DB.relock()).then(function () {
        applyLockScreen(true);
      });
      return;
    }
    const protectedApp = DB.isProtected();
    const hasPwd = protectedApp ? DB.canUnlockByPassword() : !!DB.state.settings.resetPassword;
    const fingerprintActive = DB.hasFingerprint();
    buildOverlay(protectedApp, hasPwd, fingerprintActive);
  }

  const api = {};
  Object.assign(api, { bioApi, unlockApp, resetLock, showPasswordField, applyLockScreen, appPlugin });
  return api;
})();