require('dotenv').config();
const express = require('express');
const path = require('path');
const store = require('./store');
const license = require('./license');
const bot = require('./bot');
const admin = require('./admin');

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
    return res.status(400).json({ error: 'deviceId inválido' });
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
  const l = store.getLicense(deviceId);
  if (!l) {
    return res.json({ ok: false, status: 'none', message: 'Sin licencia. Contacta al administrador para activar.' });
  }
  const now = Date.now();
  if (now < l.expiresAt) {
    return res.json({ ok: true, status: 'active', issuedAt: l.issuedAt, expiresAt: l.expiresAt, token: l.token });
  }
  if (now < l.graceUntil) {
    return res.json({ ok: true, status: 'grace', issuedAt: l.issuedAt, expiresAt: l.expiresAt, graceUntil: l.graceUntil, token: l.token });
  }
  return res.json({ ok: false, status: 'expired', message: 'Licencia vencida y período de gracia agotado.' });
});

app.get('/api/device/:deviceId', (req, res) => {
  const deviceId = String(req.params.deviceId || '').trim();
  const l = store.getLicense(deviceId);
  res.json({ deviceId, license: l ? {
    issuedAt: l.issuedAt, expiresAt: l.expiresAt, graceUntil: l.graceUntil, status: 'active'
  } : null });
});

app.use('/admin', express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

function requireAdmin(req, res) {
  const raw = req.query.initData || '';
  if (!raw) {
    console.log('[admin] petición sin initData (' + req.path + ')');
    res.status(401).json({ error: 'No autorizado. Falta initData de Telegram.' });
    return null;
  }
  const info = admin.validateInitData(raw);
  if (!info) {
    console.log('[admin] initData inválido: token len=' + String(process.env.TELEGRAM_TOKEN || '').length + ' user=' + raw.slice(0, 60));
    res.status(401).json({ error: 'No autorizado. initData de Telegram inválido.' });
    return null;
  }
  if (!admin.isAdmin(info.user && info.user.id)) {
    console.log('[admin] usuario no-admin: id=' + (info.user && info.user.id));
    res.status(403).json({ error: 'No autorizado. Tu cuenta de Telegram no es administradora.' });
    return null;
  }
  return info;
}

function licenseStatus(l) {
  if (!l) return 'none';
  const now = Date.now();
  if (now < l.expiresAt) return 'active';
  if (now < l.graceUntil) return 'grace';
  return 'expired';
}

function licenseLabel(st) {
  return st === 'active' ? '🟢 Activa' : st === 'grace' ? '🟡 Por Vencer' : st === 'expired' ? '🔴 Vencida' : '⚪ Sin licencia';
}

function enrichClient(c) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    createdAt: c.createdAt,
    devices: (c.devices || []).map((d) => {
      const l = store.getLicense(d.deviceId);
      const st = licenseStatus(l);
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
  let active = 0, expiring = 0, blocked = 0;
  Object.keys(lic).forEach((id) => {
    const l = lic[id];
    const st = licenseStatus(l);
    if (st === 'active') {
      active++;
      if (l.expiresAt - now <= 7 * DAY) expiring++;
    } else if (st === 'expired') {
      blocked++;
    }
  });
  res.json({
    ok: true,
    summary: {
      activeLicenses: active,
      expiringSoon: expiring,
      blocked: blocked,
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
    const st = licenseStatus(l);
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
  const c = store.updateClient(req.params.id, { name: req.body.name, phone: req.body.phone });
  if (!c) return res.status(404).json({ error: 'Cliente no encontrado.' });
  res.json({ ok: true, client: enrichClient(c) });
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
  store.setLicense(req.params.deviceId, l);
  res.json({ ok: true, license: l });
});

app.post('/api/admin/device/:deviceId/block', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.removeLicense(req.params.deviceId);
  res.json({ ok: true });
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
  store.setLicense(req.params.deviceId, l);
  const c = store.addDeviceToClient(req.params.id, req.params.deviceId, req.body.alias);
  res.json({ ok: true, license: l, client: c ? enrichClient(c) : null });
});

app.post('/api/admin/clients/:id/devices/:deviceId/block', (req, res) => {
  const info = requireAdmin(req, res);
  if (!info) return;
  store.removeLicense(req.params.deviceId);
  res.json({ ok: true });
});

store.init().then(() => {
  app.listen(PORT, () => {
    console.log('[server] CotizaTec backend en puerto ' + PORT);
    if (!process.env.LICENSE_PRIVATE_KEY && !process.env.LICENSE_PUBLIC_KEY) {
      console.warn('[server] ⚠️  Faltan claves de licencia. Ejecuta: npm run genkeys y copia a .env');
    }
    if (!process.env.TELEGRAM_TOKEN) {
      console.warn('[server] ⚠️  Falta TELEGRAM_TOKEN en .env. El bot no se iniciará.');
    } else {
      bot.startBot(process.env.TELEGRAM_TOKEN);
      console.log('[bot] Bot de Telegram iniciado.');
    }
  });
});