require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./store');
const license = require('./license');
const bot = require('./bot');
const admin = require('./admin');
const webclients = require('./webclients');

const PORT = process.env.PORT || 3000;

license.setKeys(process.env.LICENSE_PUBLIC_KEY, process.env.LICENSE_PRIVATE_KEY);
if (!process.env.LICENSE_PRIVATE_KEY) {
  license.loadKeysFromFile();
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.post('/api/register', (req, res) => {
  const deviceId = String(req.body.deviceId || '').trim();
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return res.status(400).json({ error: 'deviceId invÃ¡lido' });
  }
  const meta = {
    appVersion: req.body.appVersion || '',
    platform: req.body.platform || ''
  };
  store.registerDevice(deviceId, meta);
  res.json({ ok: true });
});

app.get('/api/license/:deviceId', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const supportPhone = process.env.SUPPORT_PHONE || '';
  if (store.isBlocked(deviceId)) {
    return res.json({ ok: false, status: 'blocked', supportPhone, message: 'Dispositivo bloqueado. Contacta al administrador.' });
  }
  let l = store.getLicense(deviceId);
  const now = Date.now();
  if (!l) {
    const trialDays = Number(process.env.TRIAL_DAYS) || 15;
    const expiresAt = now + trialDays * 86400000;
    const payload = { v: 1, deviceId, issuedAt: now, expiresAt, graceUntil: expiresAt, trial: true };
    l = store.setLicense(deviceId, { deviceId, issuedAt: now, expiresAt, graceUntil: expiresAt, trial: true, token: license.signLicense(payload) });
    return res.json({ ok: true, status: 'trial', trial: true, supportPhone, issuedAt: l.issuedAt, expiresAt: l.expiresAt, graceUntil: l.graceUntil, token: l.token });
  }
  if (now < l.expiresAt) {
    return res.json({ ok: true, status: 'active', supportPhone, issuedAt: l.issuedAt, expiresAt: l.expiresAt, token: l.token });
  }
  if (now < l.graceUntil) {
    return res.json({ ok: true, status: 'grace', supportPhone, issuedAt: l.issuedAt, expiresAt: l.expiresAt, graceUntil: l.graceUntil, token: l.token });
  }
  const message = l.trial
    ? 'Tu perÃ­odo de prueba terminÃ³. ActÃ­vala contactando al administrador por WhatsApp.'
    : 'Licencia vencida y perÃ­odo de gracia agotado. Contacta al administrador para renovar.';
  return res.json({ ok: false, status: 'expired', supportPhone, message });
});

app.get('/api/device/:deviceId', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const l = store.getLicense(deviceId);
  res.json({ deviceId, license: l ? {
    issuedAt: l.issuedAt, expiresAt: l.expiresAt, graceUntil: l.graceUntil, status: 'active'
  } : null });
});

// Módulos y plan del negocio al que pertenece un dispositivo (para que la APP
// sepa qué funcionalidades tiene contratadas su cliente).
app.get('/api/device/:deviceId/modules', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const client = store.getClientByDeviceId(deviceId);
  if (!client) {
    return res.json({ ok: true, plan: null, modules: [], planLimit: null,
      warning: 'Dispositivo no vinculado a ningún negocio. Los módulos aparecerán cuando el administrador lo vincule.' });
  }
  const mods = client.modules || ['cotizaciones', 'clientes', 'ventas', 'reportes'];
  res.json({ ok: true, plan: client.plan || 'Básico', modules: mods, planLimit: client.planLimit != null ? client.planLimit : null });
});

app.post('/api/backup/:deviceId', async (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  if (!deviceId || deviceId.length < 8 || deviceId.length > 128) {
    return res.status(400).json({ error: 'deviceId invÃ¡lido' });
  }
  const data = String(req.body.data || '').trim();
  if (!data || data.length < 32) {
    return res.status(400).json({ error: 'Respaldo vacÃ­o o invÃ¡lido' });
  }
  if (data.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: 'Respaldo demasiado grande' });
  }
  await store.setBackup(deviceId, data);
  res.json({ ok: true });
});

app.get('/api/backup/:deviceId', async (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const b = await store.getBackup(deviceId);
  if (!b) return res.json({ ok: false, status: 'none' });
  res.json({ ok: true, savedAt: b.savedAt, data: b.data });
});

// Reclamo de migraciÃ³n: el equipo nuevo pregunta si tiene un respaldo que
// heredar de un dispositivo viejo (mismo usuario, otro telÃ©fono).
app.get('/api/backup/claim/:deviceId', async (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const oldId = await store.getClaim(deviceId);
  if (!oldId) return res.json({ ok: false, status: 'none' });
  res.json({ ok: true, oldDeviceId: oldId });
});

// Cuando el equipo nuevo termina de restaurar y re-cifrar el respaldo con su
// propia clave, elimina el respaldo del equipo viejo y el reclamo.
app.post('/api/backup/claim/:deviceId/resolve', async (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const cleaned = await store.resolveMigration(deviceId);
  res.json({ ok: true, cleaned });
});

app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ===== Panel web del cliente =====
app.get('/panel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

// Cambio de contraseÃ±a del cliente ya autenticado. La cuenta se crea desde el
// panel del administrador; aquÃ­ el cliente solo puede cambiar su propia clave.
app.post('/api/client/change-password', async (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const { account } = auth;
  try {
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    const ok = await webclients.verifyPassword(current, account.passHash);
    if (!ok) {
      return res.status(401).json({ error: 'La contraseÃ±a actual es incorrecta.' });
    }
    if (next.length < 6) {
      return res.status(400).json({ error: 'La nueva contraseÃ±a debe tener al menos 6 caracteres.' });
    }
    const hash = await webclients.hashPassword(next);
    account.passHash = hash;
    account.updatedAt = Date.now();
    store.setWebAccount(account.username, account);
    res.json({ ok: true, message: 'ContraseÃ±a actualizada.' });
  } catch (e) {
    console.error('[client] change-password error:', e.message);
    res.status(500).json({ error: 'Error al cambiar la contraseÃ±a.' });
  }
});

app.post('/api/client/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const account = store.getWebAccountByUsername(username);
    if (!account) {
      return res.status(401).json({ error: 'Usuario o contraseÃ±a incorrectos.' });
    }
    const ok = await webclients.verifyPassword(password, account.passHash);
    if (!ok) {
      return res.status(401).json({ error: 'Usuario o contraseÃ±a incorrectos.' });
    }
    const token = webclients.issueToken(account);
    res.json({ ok: true, token, role: account.role || 'owner', userId: account.userId, name: account.name || (store.getClient(account.clientId) || {}).name || username });
  } catch (e) {
    console.error('[client] login error:', e.message);
    res.status(500).json({ error: 'Error al iniciar sesiÃ³n.' });
  }
});

function requireClient(req, res) {
  const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const info = webclients.verifyToken(auth);
  if (!info) {
    res.status(401).json({ error: 'SesiÃ³n invÃ¡lida o expirada.' });
    return null;
  }
  const account = store.getWebAccountById(info.sub);
  if (!account) {
    res.status(401).json({ error: 'Cuenta no encontrada.' });
    return null;
  }
  if (account.status === 'inactivo') {
    res.status(403).json({ error: 'Tu cuenta estÃ¡ desactivada.' });
    return null;
  }
  return { info, account };
}

app.get('/api/client/report', async (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const { account } = auth;
  try {
    const devices = account.deviceIds || [];
    let state = null;
    for (const deviceId of devices) {
      const b = await store.getBackup(deviceId);
      if (b && b.data) {
        const plain = await webclients.decryptBackup(deviceId, b.data);
        if (plain) {
          try {
            const parsed = JSON.parse(plain);
            if (parsed && parsed.data) state = parsed.data;
            break;
          } catch (e) { /* siguiente dispositivo */ }
        }
      }
    }
    if (!state) {
      return res.json({ ok: true, hasData: false, report: null, message: 'TodavÃ­a no hay datos de ventas para este cliente.' });
    }
    const report = webclients.computeReport(state);
    res.json({ ok: true, hasData: true, report });
  } catch (e) {
    console.error('[client] report error:', e.message);
    res.status(500).json({ error: 'Error al leer los datos.' });
  }
});

// ===== GestiÃ³n de usuarios del portal (solo el dueÃ±o del negocio) =====
// El dueÃ±o (role: owner) administra los usuarios web de SU PROPIO negocio.
// Se garantiza aislamiento total: solo puede operar sobre su clientId.
function requireOwner(req, res) {
  const auth = requireClient(req, res);
  if (!auth) return null;
  if (auth.info.role !== 'owner') {
    res.status(403).json({ error: 'Solo el dueÃ±o del negocio puede administrar usuarios.' });
    return null;
  }
  return auth;
}

const PORTAL_MAX_USERS = parseInt(process.env.PORTAL_MAX_USERS || '10', 10);

app.get('/api/client/users', (req, res) => {
  const auth = requireOwner(req, res);
  if (!auth) return;
  const clientId = auth.account.clientId;
  const client = store.getClient(clientId) || {};
  const limit = (client.planLimit != null ? parseInt(client.planLimit, 10) : PORTAL_MAX_USERS) || PORTAL_MAX_USERS;
  const users = store.listWebAccountsByClient(clientId).map((u) => ({
    userId: u.userId,
    username: u.username,
    name: u.name || '',
    role: u.role || 'owner',
    status: u.status || 'activo',
    createdAt: u.createdAt,
    deviceId: u.deviceIds ? u.deviceIds[0] : null
  }));
  res.json({ ok: true, limit, users });
});

app.post('/api/client/users', async (req, res) => {
  const auth = requireOwner(req, res);
  if (!auth) return;
  const clientId = auth.account.clientId;
  const name = String(req.body.name || '').trim();
  const username = String(req.body.username || '').toLowerCase().trim();
  const role = req.body.role === 'owner' ? 'owner' : 'empleado';
  if (!username || !/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Usuario invÃ¡lido (3-30: letras, nÃºmeros, . _ -).' });
  }
  if (store.getWebAccountByUsername(username)) {
    return res.status(409).json({ error: 'Ese usuario ya existe en el portal.' });
  }
  const client = store.getClient(clientId) || {};
  const limit = (client.planLimit != null ? parseInt(client.planLimit, 10) : PORTAL_MAX_USERS) || PORTAL_MAX_USERS;
  const count = store.countWebAccountsByClient(clientId);
  if (count >= limit) {
    return res.status(403).json({ error: 'Alcanzaste el lÃ­mite de ' + limit + ' usuarios de tu plan.' });
  }
  // ContraseÃ±a temporal generada: se muestra una sola vez, nunca se guarda en claro.
  const temp = Math.random().toString(36).slice(2, 8) + String(Math.floor(Math.random() * 100));
  const hash = await webclients.hashPassword(temp);
  const account = {
    username,
    clientId,
    name: name || username,
    role,
    status: 'activo',
    passHash: hash,
    deviceIds: (store.getClient(clientId) || { devices: [] }).devices.map((d) => d.deviceId),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.setWebAccount(username, account);
  res.json({ ok: true, createdAtPassword: temp, account: { userId: account.userId, username, name: account.name, role, status: 'activo' } });
});

app.post('/api/client/users/:userId/toggle', (req, res) => {
  const auth = requireOwner(req, res);
  if (!auth) return;
  const acc = store.getWebAccountById(req.params.userId);
  if (!acc || acc.clientId !== auth.account.clientId) {
    return res.status(404).json({ error: 'Usuario no encontrado en tu negocio.' });
  }
  if (acc.role === 'owner') {
    return res.status(400).json({ error: 'No puedes desactivar la cuenta del dueÃ±o.' });
  }
  acc.status = acc.status === 'inactivo' ? 'activo' : 'inactivo';
  acc.updatedAt = Date.now();
  store.setWebAccount(acc.username, acc);
  res.json({ ok: true, status: acc.status });
});

app.post('/api/client/users/:userId/reset-password', async (req, res) => {
  const auth = requireOwner(req, res);
  if (!auth) return;
  const acc = store.getWebAccountById(req.params.userId);
  if (!acc || acc.clientId !== auth.account.clientId) {
    return res.status(404).json({ error: 'Usuario no encontrado en tu negocio.' });
  }
  const temp = Math.random().toString(36).slice(2, 8) + String(Math.floor(Math.random() * 100));
  const hash = await webclients.hashPassword(temp);
  store.setWebAccountPasswordByUserId(acc.userId, hash);
  res.json({ ok: true, resetPassword: temp });
});

function requireAdmin(req, res) {
  const raw = req.query.initData || '';
  if (!raw) {
    console.log('[admin] peticiÃ³n sin initData (' + req.path + ')');
    res.status(401).json({ error: 'No autorizado. Falta initData de Telegram.' });
    return null;
  }
  const info = admin.validateInitData(raw);
  if (!info) {
    console.log('[admin] initData invÃ¡lido: token len=' + String(process.env.TELEGRAM_TOKEN || '').length + ' user=' + raw.slice(0, 60));
    res.status(401).json({ error: 'No autorizado. initData de Telegram invÃ¡lido.' });
    return null;
  }
  if (!admin.isAdmin(info.user && info.user.id)) {
    console.log('[admin] usuario no-admin: id=' + (info.user && info.user.id));
    res.status(403).json({ error: 'No autorizado. Tu cuenta de Telegram no es administradora.' });
    return null;
  }
  return info;
}

function licenseStatus(deviceId, l) {
  if (store.isBlocked(deviceId)) return 'blocked';
  if (!l) return 'none';
  const now = Date.now();
  if (now < l.expiresAt) return 'active';
  if (now < l.graceUntil) return 'grace';
  return 'expired';
}

function licenseLabel(st) {
  return st === 'active' ? 'ðŸŸ¢ Activa' : st === 'grace' ? 'ðŸŸ¡ Por Vencer' : st === 'expired' ? 'ðŸ”´ Vencida' : st === 'blocked' ? 'ðŸ”’ Bloqueada' : 'âšª Sin licencia';
}

function enrichClient(c) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    plan: c.plan || 'Básico',
    modules: c.modules || ['cotizaciones', 'clientes', 'ventas', 'reportes'],
    planLimit: c.planLimit != null ? c.planLimit : null,
    createdAt: c.createdAt,
    devices: (c.devices || []).map((d) => {
      const l = store.getLicense(d.deviceId);
      const st = licenseStatus(d.deviceId, l);
      return {
        deviceId: d.deviceId,
        alias: d.alias || null,
        status: st,
        label: licenseLabel(st),
        expiresAt: l ? l.expiresAt : null,
        graceUntil: l ? l.graceUntil : null
      };
    })
  };
}

app.get('/api/admin/verify', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  res.json({ ok: true, user: info.user });
});

app.get('/api/admin/summary', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const now = Date.now();
  const DAY = 86400000;
  const lic = store.allLicenses();
  let active = 0, expiring = 0;
  Object.keys(lic).forEach((id) => {
    if (store.isBlocked(id)) return;
    const l = lic[id];
    const st = licenseStatus(id, l);
    if (st === 'active') {
      active++;
      if (l.expiresAt - now <= 7 * DAY) expiring++;
    }
  });
  res.json({
    ok: true,
    summary: {
      activeLicenses: active,
      expiringSoon: expiring,
      blocked: store.blockedCount(),
      clients: store.listClients().length,
      devices: store.deviceCount()
    }
  });
});

app.get('/api/admin/clients', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const q = String(req.query.q || '').toLowerCase().trim();
  let list = store.listClients().map(enrichClient);
  if (q) {
    list = list.filter((c) =>
      (c.name || '').toLowerCase().indexOf(q) > -1 ||
      (c.phone || '').toLowerCase().indexOf(q) > -1 ||
      (c.devices || []).some((d) => (d.deviceId || '').toLowerCase().indexOf(q) > -1)
    );
  }
  list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ ok: true, clients: list });
});

app.get('/api/admin/orphans', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const q = String(req.query.q || '').toLowerCase().trim();
  const devices = store.allDevices();
  const clients = store.listClients();
  const linked = {};
  clients.forEach((c) => (c.devices || []).forEach((d) => { linked[d.deviceId] = true; }));
  const lic = store.allLicenses();
  let orphans = Object.keys(devices).map((deviceId) => {
    const l = lic[deviceId];
    const st = licenseStatus(deviceId, l);
    return {
      deviceId,
      alias: null,
      status: st,
      label: licenseLabel(st),
      expiresAt: l ? l.expiresAt : null,
      graceUntil: l ? l.graceUntil : null,
      firstSeen: devices[deviceId].firstSeen,
      lastSeen: devices[deviceId].lastSeen
    };
  }).filter((d) => !linked[d.deviceId]);
  if (q) {
    orphans = orphans.filter((d) => (d.deviceId || '').toLowerCase().indexOf(q) > -1);
  }
  orphans.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ ok: true, orphans });
});

app.post('/api/admin/clients', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre del cliente.' });
  const c = store.createClient({ name, phone: req.body.phone });
  res.json({ ok: true, client: enrichClient(c) });
});

app.put('/api/admin/clients/:id', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.updateClient(req.params.id, {
    name: req.body.name,
    phone: req.body.phone,
    plan: req.body.plan,
    modules: req.body.modules,
    planLimit: req.body.planLimit
  });
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, client: enrichClient(c) });
});

// ===== Gestión de cuentas web por cliente (solo administrador) =====
// En el MVP el administrador crea/administra todos los usuarios de cada
// negocio. La estructura (clientId + userId + role + status + deviceIds) ya
// permite en el futuro que el propietario gestione sus propios empleados.
function adminUsersOf(clientId) {
  return store.listWebAccountsByClient(clientId).map((u) => ({
    userId: u.userId,
    username: u.username,
    name: u.name || u.username,
    role: u.role || 'owner',
    status: u.status || 'activo',
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    deviceId: (u.deviceIds || [])[0] || null
  }));
}

function makeTempPassword() {
  return 'CT' + Math.random().toString(36).slice(2, 6) + String(Math.floor(Math.random() * 900) + 100);
}

app.get('/api/admin/clients/:id/webaccounts', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, users: adminUsersOf(c.id) });
});

app.post('/api/admin/clients/:id/webaccounts', async (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  const username = String(req.body.username || '').toLowerCase().trim();
  const name = String(req.body.name || '').trim();
  const role = req.body.role === 'owner' ? 'owner' : 'empleado';
  let password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) {
    return res.status(400).json({ error: 'Usuario inválido (3-30: letras, números, . _ -).' });
  }
  const existing = store.getWebAccountByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Ese usuario ya existe en el portal.' });
  }
  const generated = !password;
  if (generated) password = makeTempPassword();
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  const hash = await webclients.hashPassword(password);
  const account = {
    username,
    clientId: c.id,
    name: name || username,
    role,
    status: 'activo',
    passHash: hash,
    deviceIds: (c.devices || []).map((d) => d.deviceId),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  store.setWebAccount(username, account);
  const body = { ok: true, account: { userId: account.userId, username, name: account.name, role, status: 'activo' } };
  if (generated) body.createdAtPassword = password;
  res.json(body);
});

app.post('/api/admin/clients/:id/webaccounts/:userId/toggle', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const acc = store.getWebAccountById(req.params.userId);
  if (!acc || String(acc.clientId) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Usuario no encontrado en este cliente.' });
  }
  acc.status = acc.status === 'inactivo' ? 'activo' : 'inactivo';
  acc.updatedAt = Date.now();
  store.setWebAccount(acc.username, acc);
  res.json({ ok: true, status: acc.status });
});

app.post('/api/admin/clients/:id/webaccounts/:userId/reset-password', async (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const acc = store.getWebAccountById(req.params.userId);
  if (!acc || String(acc.clientId) !== String(req.params.id)) {
    return res.status(404).json({ error: 'Usuario no encontrado en este cliente.' });
  }
  const temp = makeTempPassword();
  const hash = await webclients.hashPassword(temp);
  store.setWebAccountPasswordByUserId(acc.userId, hash);
  res.json({ ok: true, resetPassword: temp, userId: acc.userId });
});

app.delete('/api/admin/clients/:id', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.removeClient(req.params.id);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/devices', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const deviceId = String(req.body.deviceId || '').trim();
  if (!deviceId) return res.status(400).json({ error: 'Falta deviceId.' });
  const owner = store.deviceInOtherClient(req.params.id, deviceId);
  if (owner) return res.status(409).json({ error: 'Ese dispositivo ya estÃ¡ vinculado al cliente "' + owner.name + '". QuÃ­talo de ahÃ­ o usa ese cliente.' });
  const c = store.addDeviceToClient(req.params.id, deviceId, req.body.alias);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, client: enrichClient(c) });
});

app.delete('/api/admin/clients/:id/devices/:deviceId', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.removeDeviceFromClient(req.params.id, req.params.deviceId);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, client: enrichClient(c) });
});

app.post('/api/admin/device/:deviceId/activate', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const days = parseInt(req.body.days, 10) || 30;
  const graceDays = parseInt(req.body.graceDays, 10) || 15;
  const now = Date.now();
  const expiresAt = now + days * 86400000;
  const graceUntil = expiresAt + graceDays * 86400000;
  const l = {
    deviceId: req.params.deviceId,
    issuedAt: now,
    expiresAt,
    graceUntil,
    token: license.signLicense({ v: 1, deviceId: req.params.deviceId, issuedAt: now, expiresAt, graceUntil })
  };
  store.unblockDevice(req.params.deviceId);
  store.setLicense(req.params.deviceId, l);
  res.json({ ok: true, license: l });
});

app.post('/api/admin/device/:deviceId/block', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.blockDevice(req.params.deviceId);
  res.json({ ok: true });
});

app.post('/api/admin/device/:deviceId/unblock', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.unblockDevice(req.params.deviceId);
  res.json({ ok: true });
});

app.post('/api/admin/device/:deviceId/migrate', async (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const toId = String(req.body.toDeviceId || '').trim();
  if (!toId || toId.length < 8 || toId.length > 128) {
    return res.status(400).json({ error: 'Falta toDeviceId vÃ¡lido.' });
  }
  const fromId = String(req.params.deviceId || '').trim();
  const result = await store.migrateDevice(fromId, toId);
  store.blockDevice(fromId);
  res.json({ ok: true, backupMoved: result.backupExists, licenseMoved: result.licenseMoved });
});

app.delete('/api/admin/device/:deviceId', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.removeDevice(req.params.deviceId);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/devices/:deviceId/activate', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const owner = store.deviceInOtherClient(req.params.id, req.params.deviceId);
  if (owner) return res.status(409).json({ error: 'Ese dispositivo ya estÃ¡ vinculado al cliente "' + owner.name + '".' });
  const days = parseInt(req.body.days, 10) || 30;
  const graceDays = parseInt(req.body.graceDays, 10) || 15;
  const now = Date.now();
  const l = {
    deviceId: req.params.deviceId,
    issuedAt: now,
    expiresAt: now + days * 86400000,
    graceUntil: now + days * 86400000 + graceDays * 86400000,
    token: license.signLicense({ v: 1, deviceId: req.params.deviceId, issuedAt: now, expiresAt: now + days * 86400000, graceUntil: now + days * 86400000 + graceDays * 86400000 })
  };
  store.unblockDevice(req.params.deviceId);
  store.setLicense(req.params.deviceId, l);
  const c = store.addDeviceToClient(req.params.id, req.params.deviceId, req.body.alias);
  res.json({ ok: true, license: l, client: c ? enrichClient(c) : null });
});

app.post('/api/admin/clients/:id/devices/:deviceId/block', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.blockDevice(req.params.deviceId);
  res.json({ ok: true });
});

app.post('/api/admin/clients/:id/devices/:deviceId/unblock', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.unblockDevice(req.params.deviceId);
  res.json({ ok: true });
});

// ===== Ficha administrativa del cliente (resumen) =====
// Reutiliza computeReport sobre los respaldos de TODOS los dispositivos del
// cliente para mostrar actividad del mes en el panel del administrador.
async function readClientData(clientId) {
  const client = store.getClient(clientId);
  if (!client) return { ok: false };
  let state = null;
  for (const d of (client.devices || [])) {
    const b = await store.getBackup(d.deviceId);
    if (b && b.data) {
      const plain = await webclients.decryptBackup(d.deviceId, b.data);
      if (plain) {
        try {
          const parsed = JSON.parse(plain);
          if (parsed && parsed.data) { state = parsed.data; break; }
        } catch (e) { /* siguiente dispositivo */ }
      }
    }
  }
  return { ok: true, state };
}

function moduleDefs() {
  return [
    { key: 'cotizaciones', label: 'Cotizaciones' },
    { key: 'clientes', label: 'Clientes' },
    { key: 'ventas', label: 'Ventas' },
    { key: 'reportes', label: 'Reportes' },
    { key: 'documentos', label: 'Documentos' },
    { key: 'garantias', label: 'Garantías' },
    { key: 'finanzas', label: 'Finanzas' },
    { key: 'contabilidad', label: 'Contabilidad' },
    { key: 'gps', label: 'GPS' }
  ];
}

// Resumen para la ficha del admin (no expone credenciales ni claves).
app.get('/api/admin/clients/:id/view-portal-token', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, token: webclients.issueViewToken(c.id) });
});

app.get('/api/admin/clients/:id/summary', async (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });

  const users = store.listWebAccountsByClient(c.id);
  const owner = users.find((u) => (u.role || 'owner') === 'owner') || users[0] || null;
  const limit = (c.planLimit != null ? parseInt(c.planLimit, 10) : PORTAL_MAX_USERS) || PORTAL_MAX_USERS;

  const data = await readClientData(c.id);
  let activity = null;
  if (data.ok && data.state) {
    const report = webclients.computeReport(data.state);
    activity = {
      ventas: report.totals && report.totals.ventas || 0,
      cotizaciones: report.totals && report.totals.cotizaciones || 0,
      facturadoMes: report.monthly ? report.monthly[report.monthly.length - 1].facturado || 0 : 0
    };
  }

  res.json({
    ok: true,
    client: enrichClient(c),
    props: {
      owner: owner ? { name: owner.name || owner.username, username: owner.username, role: owner.role } : null
    },
    users: { total: users.length, activo: users.filter((u) => u.status !== 'inactivo').length, limit },
    activity,
    modules: moduleDefs().map((m) => ({ key: m.key, label: m.label, active: (c.modules || []).indexOf(m.key) !== -1 }))
  });
});

// ===== Ver portal como cliente (rol viewer, SOLO LECTURA, auditado) =====
// El administrador obtiene un token de vista con rol 'viewer'. El reporte se
// lee de los dispositivos del cliente y la UI del portal lo muestra en modo
// solo lectura: no modifica la sesión real del cliente y no expone credenciales.
app.get('/api/client/report/view', (req, res) => {
  const token = String((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const info = webclients.verifyToken(token);
  if (!info || info.role !== 'viewer') {
    return res.status(401).json({ error: 'Vista no autorizada.' });
  }
  const c = store.getClient(info.clientId);
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.locals.viewToken = info;
  res.locals.viewClientId = c.id;
  next_(req, res);
});

// Middleware encadenado: /api/client/report/view resuelve el cliente y delega
// en la lógica de reporte compartida (solo lectura, sin mutar sesión).
function next_(req, res) {
  const info = res.locals.viewToken;
  const clientId = res.locals.viewClientId;
  const devices = store.getClient(clientId).devices.map((d) => d.deviceId);
  (async () => {
    let state = null;
    for (const deviceId of devices) {
      const b = await store.getBackup(deviceId);
      if (b && b.data) {
        const plain = await webclients.decryptBackup(deviceId, b.data);
        if (plain) {
          try {
            const parsed = JSON.parse(plain);
            if (parsed && parsed.data) { state = parsed.data; break; }
          } catch (e) { /* siguiente */ }
        }
      }
    }
    if (!state) {
      return res.json({ ok: true, hasData: false, report: null, message: 'Todavía no hay datos de ventas para este cliente.', viewOnly: true });
    }
    const report = webclients.computeReport(state);
    res.json({ ok: true, hasData: true, report, viewOnly: true });
  })().catch((e) => {
    console.error('[client] view report error:', e.message);
    res.status(500).json({ error: 'Error al leer los datos.' });
  });
}

store.init().then(() => {
  app.listen(PORT, () => {
    console.log('[server] CotizaTec backend en puerto ' + PORT);
    if (!process.env.LICENSE_PRIVATE_KEY && !process.env.LICENSE_PUBLIC_KEY) {
      console.warn('[server] âš ï¸  Faltan claves de licencia. Ejecuta: npm run genkeys y copia a .env');
    }
    if (!process.env.TELEGRAM_TOKEN) {
      console.warn('[server] âš ï¸  Falta TELEGRAM_TOKEN en .env. El bot no se iniciarÃ¡.');
    } else {
      bot.startBot(process.env.TELEGRAM_TOKEN);
      console.log('[bot] Bot de Telegram iniciado.');
    }
  });
});