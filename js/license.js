var License = (function () {
  var SERVER_BASE = (typeof LICENCE_SERVER_BASE !== 'undefined' && LICENCE_SERVER_BASE) ? LICENCE_SERVER_BASE : 'https://cotizatec-backend.onrender.com';
  var LICENSE_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAP+nqgL8XW7578mbKsuQB2nptyXOBl5/1RdI1mBq9M7o=\n-----END PUBLIC KEY-----\n';
  var LS_KEY = 'cotizatec_license';

  var state = {
    deviceId: '',
    token: '',
    supportPhone: '',
    loaded: false
  };

  function base64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function pemToBytes(pem) {
    var body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
    return base64ToBytes(body);
  }

  function randomId(len) {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var s = '';
    var c = typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(len)) : null;
    for (var i = 0; i < len; i++) {
      s += c ? chars[c[i] % chars.length] : chars[Math.floor(Math.random() * chars.length)];
    }
    return s;
  }

  function persist() {
    try { localStorage.setItem(LS_KEY, JSON.stringify({ deviceId: state.deviceId, token: state.token, supportPhone: state.supportPhone })); } catch (e) {}
  }

  function loadPersisted() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw && raw.deviceId) {
        state.deviceId = raw.deviceId;
        state.token = raw.token || '';
        state.supportPhone = raw.supportPhone || '';
        return true;
      }
    } catch (e) {}
    return false;
  }

  function ensureDeviceId() {
    if (state.deviceId) return Promise.resolve(state.deviceId);
    var cap = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Device;
    var useCap = cap && cap.getId && cap.getId();
    var set = function (id) {
      state.deviceId = id;
      persist();
      return state.deviceId;
    };
    if (useCap) {
      return useCap.then(function (info) {
        var id = (info && info.identifier) || '';
        var clean = String(id).replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 20);
        if (!clean) {
          clean = randomId(16);
        }
        return set('cotizatec-' + clean);
      }).catch(function () {
        return set('cotizatec-' + randomId(16));
      });
    }
    return Promise.resolve(set('cotizatec-' + randomId(16)));
  }

  function parseToken(token) {
    try {
      var outer = JSON.parse(atob(token));
      if (!outer || !outer.d || !outer.s) return null;
      return JSON.parse(outer.d);
    } catch (e) {
      return null;
    }
  }

  function verifySignature(payloadData, sigB64) {
    if (!window.crypto || !window.crypto.subtle) return Promise.resolve(false);
    var keyBytes = pemToBytes(LICENSE_PUBLIC_KEY_PEM);
    var sigBytes = base64ToBytes(sigB64);
    var dataBytes = new TextEncoder().encode(payloadData);
    return window.crypto.subtle.importKey('spki', keyBytes, { name: 'Ed25519' }, false, ['verify']).then(function (key) {
      return window.crypto.subtle.verify('Ed25519', key, sigBytes, dataBytes);
    }).catch(function () {
      return false;
    });
  }

  function verifyToken(token) {
    var outer;
    try { outer = JSON.parse(atob(token)); } catch (e) { return Promise.resolve(null); }
    if (!outer || !outer.d || !outer.s) return Promise.resolve(null);
    var payload;
    try { payload = JSON.parse(outer.d); } catch (e) { return Promise.resolve(null); }
    if (!payload.deviceId || payload.deviceId !== state.deviceId) return Promise.resolve(null);
    return verifySignature(outer.d, outer.s).then(function (ok) {
      if (!ok) return null;
      return payload;
    });
  }

  function checkOnline() {
    if (typeof fetch === 'undefined') return Promise.resolve(null);
    var url = SERVER_BASE + '/api/license/' + encodeURIComponent(state.deviceId);
    var timer = setTimeout(function () {}, 8000);
    return fetch(url).then(function (r) { return r.json(); }).then(function (body) {
      clearTimeout(timer);
      if (body && typeof body.supportPhone === 'string') {
        state.supportPhone = body.supportPhone;
        persist();
      }
      if (body && body.status === 'blocked') {
        state.token = '';
        persist();
        return { blocked: true };
      }
      if (body && body.ok && body.token) {
        state.token = body.token;
        persist();
        return verifyToken(body.token);
      }
      if (body && body.status === 'none') {
        state.token = '';
        persist();
      }
      return null;
    }).then(function (result) {
      registerDevice();
      return result;
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  function registerDevice() {
    if (typeof fetch === 'undefined' || !state.deviceId) return;
    var appVersion = (window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform()) || 'web';
    fetch(SERVER_BASE + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: state.deviceId, appVersion: 'cotizatec-' + appVersion, platform: appVersion })
    }).catch(function () {});
  }

  function computeStatus(payload) {
    var now = Date.now();
    if (payload && payload.blocked) return { status: 'blocked' };
    if (!payload) return { status: 'none' };
    if (now < payload.expiresAt) {
      return {
        status: 'active',
        expiresAt: payload.expiresAt,
        graceUntil: payload.graceUntil,
        daysLeft: Math.floor((payload.expiresAt - now) / 86400000)
      };
    }
    if (now < payload.graceUntil) {
      return {
        status: 'grace',
        expiresAt: payload.expiresAt,
        graceUntil: payload.graceUntil,
        daysLeft: 0,
        graceDaysLeft: Math.floor((payload.graceUntil - now) / 86400000)
      };
    }
    return { status: 'expired', expiresAt: payload.expiresAt, graceUntil: payload.graceUntil };
  }

  function notificationsPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  }

  var notifDayMs = 86400000;

  function scheduleNotification(id, title, body, at) {
    var n = notificationsPlugin();
    if (!n || !n.schedule) return;
    if (at <= Date.now()) return;
    n.schedule({
      notifications: [{
        id: id,
        title: title,
        body: body,
        schedule: { at: new Date(at) },
        sound: 'default'
      }]
    }).catch(function (e) { console.error('NOTIF_ERR ' + (e && e.message)); });
  }

  function scheduleAll(payload) {
    if (!payload || !payload.expiresAt || !payload.graceUntil) return;
    var now = Date.now();
    var exp = payload.expiresAt;
    var grace = payload.graceUntil;
    if (now >= grace) return;

    scheduleNotification(1, 'CotizaTec', 'Tu suscripción vence en 5 días. Conéctate a internet para renovarla automáticamente.', exp - 5 * notifDayMs);
    scheduleNotification(2, 'CotizaTec', 'Tu suscripción vence mañana. Conéctate a internet para renovarla y evitar el bloqueo.', exp - 1 * notifDayMs);
    scheduleNotification(3, 'CotizaTec', 'Tu licencia caducó. Entraste en período de gracia de 15 días. Conéctate para renovar y evitar el bloqueo.', exp);
    scheduleNotification(4, 'CotizaTec', 'Te quedan 7 días de gracia. Renueva tu suscripción para seguir usando CotizaTec.', grace - 7 * notifDayMs);
    scheduleNotification(5, 'CotizaTec', 'Te quedan 3 días de gracia. Si no renuevas, la app se bloqueará.', grace - 3 * notifDayMs);
    scheduleNotification(6, 'CotizaTec', 'ÚLTIMA OPORTUNIDAD: mañana la app se bloqueará si no renuevas tu suscripción.', grace - 1 * notifDayMs);
  }

  function check() {
    loadPersisted();
    return ensureDeviceId().then(function () {
      if (state.token) {
        return verifyToken(state.token).then(function (payload) {
          if (payload) {
            state.loaded = true;
            return checkOnline().then(function (fresh) {
              scheduleAll(fresh || payload);
              return computeStatus(fresh || payload);
            });
          }
          state.loaded = true;
          return checkOnline().then(function (fresh) {
            scheduleAll(fresh);
            return computeStatus(fresh);
          });
        });
      }
      state.loaded = true;
      return checkOnline().then(function (fresh) {
        scheduleAll(fresh);
        return computeStatus(fresh);
      });
    });
  }

  function getDeviceId() {
    return ensureDeviceId().then(function () {
      return state.deviceId;
    });
  }

  // Revalidación en segundo plano: consulta el servidor sin tocar el arranque.
  // Devuelve el status actual (blocked/none/active/grace). Si el servidor
  // bloquea el dispositivo, el token local se borra dentro de checkOnline.
  function refresh() {
    return ensureDeviceId().then(function () {
      if (typeof fetch === 'undefined') return Promise.resolve(computeStatus(null));
      return checkOnline().then(function (fresh) {
        return computeStatus(fresh);
      });
    });
  }

  function isLoaded() {
    return state.loaded;
  }

  function requestNotificationPermission() {
    var n = notificationsPlugin();
    if (!n || !n.requestPermissions) return Promise.resolve(false);
    return n.requestPermissions().then(function (res) {
      return !!(res && res.display === 'granted');
    }).catch(function () {
      return false;
    });
  }

  return { check: check, refresh: refresh, getDeviceId: getDeviceId, getSupportPhone: function () { return state.supportPhone; }, isLoaded: isLoaded, verifyToken: verifyToken, parseToken: parseToken, requestNotificationPermission: requestNotificationPermission };
})();