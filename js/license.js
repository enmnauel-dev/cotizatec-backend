var License = (function () {
  var SERVER_BASE = (typeof LICENCE_SERVER_BASE !== 'undefined' && LICENCE_SERVER_BASE) ? LICENCE_SERVER_BASE : 'https://cotizatec-backend.onrender.com';
  var LICENSE_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAP+nqgL8XW7578mbKsuQB2nptyXOBl5/1RdI1mBq9M7o=\n-----END PUBLIC KEY-----\n';
  var LS_KEY = 'cotizatec_license';

  var state = {
    deviceId: '',
    token: '',
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
    try { localStorage.setItem(LS_KEY, JSON.stringify({ deviceId: state.deviceId, token: state.token })); } catch (e) {}
  }

  function loadPersisted() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY));
      if (raw && raw.deviceId) {
        state.deviceId = raw.deviceId;
        state.token = raw.token || '';
        return true;
      }
    } catch (e) {}
    return false;
  }

  function ensureDeviceId() {
    if (!state.deviceId) {
      state.deviceId = 'cotizatec-' + randomId(16);
      persist();
    }
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
      if (body && body.ok && body.token) {
        state.token = body.token;
        persist();
        return verifyToken(body.token);
      }
      if (body && body.ok && body.status === 'none') {
        state.token = '';
        persist();
      }
      return null;
    }).catch(function () {
      clearTimeout(timer);
      return null;
    });
  }

  function computeStatus(payload) {
    var now = Date.now();
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

  function check() {
    ensureDeviceId();
    loadPersisted();
    if (state.token) {
      return verifyToken(state.token).then(function (payload) {
        if (payload) {
          state.loaded = true;
          return checkOnline().then(function (fresh) {
            return computeStatus(fresh || payload);
          });
        }
        state.loaded = true;
        return checkOnline().then(function (fresh) {
          return computeStatus(fresh);
        });
      });
    }
    state.loaded = true;
    return checkOnline().then(function (fresh) {
      return computeStatus(fresh);
    });
  }

  function getDeviceId() {
    ensureDeviceId();
    return state.deviceId;
  }

  function isLoaded() {
    return state.loaded;
  }

  return { check: check, getDeviceId: getDeviceId, isLoaded: isLoaded, verifyToken: verifyToken, parseToken: parseToken };
})();