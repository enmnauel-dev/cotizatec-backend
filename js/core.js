var Util = (function () {
  function money(n) {
    return DB.money(n);
  }

  function toast(msg, ok) {
    let t = document.getElementById('toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.className = 'show' + (ok ? ' ok' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = ''; }, 2600);
  }

  function isNativeEnv() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  function capacitorPlugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) ||
      (window.Capacitor && window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin(name) : null);
  }

  function confirmar(msg) {
    return window.confirm(msg);
  }

  function escapeAttr(v) {
    return DB.esc(v);
  }

  const CLIENT_ICON = '&#128100;';
  const ITEM_ICON = '&#128221;';
  const TOOLS_ICON = '&#128295;';
  const WALLET_ICON = '&#128181;';
  const FLAG_ICON = '&#128681;';
  const PAPER_ICON = '&#128196;';
  const SAVE_ICON = '&#128190;';
  const PDF_ICON = '&#128462;';
  const WA_ICON = '&#128172;';
  const PLUS_ICON = '&#43;';
  const BACK_ICON = '&#8592;';
  const TRASH_ICON = '&#128465;';
  const PENCIL_ICON = '&#9998;';
  const CHECK_ICON = '&#10003;';
  const X_ICON = '&#10005;';
  const LOCK_ICON = '&#128274;';

  const api = {};
  Object.assign(api, {
    money, toast, isNativeEnv, capacitorPlugin, confirmar, escapeAttr,
    CLIENT_ICON, ITEM_ICON, TOOLS_ICON, WALLET_ICON, FLAG_ICON, PAPER_ICON,
    SAVE_ICON, PDF_ICON, WA_ICON, PLUS_ICON, BACK_ICON, TRASH_ICON,
    PENCIL_ICON, CHECK_ICON, X_ICON, LOCK_ICON
  });
  return api;
})();