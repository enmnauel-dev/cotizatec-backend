require('dotenv').config();
const express = require('express');
const store = require('./store');
const license = require('./license');
const bot = require('./bot');

const PORT = process.env.PORT || 3000;

license.setKeys(process.env.LICENSE_PUBLIC_KEY, process.env.LICENSE_PRIVATE_KEY);
if (!process.env.LICENSE_PRIVATE_KEY) {
  license.loadKeysFromFile();
}

const app = express();
app.use(express.json());

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