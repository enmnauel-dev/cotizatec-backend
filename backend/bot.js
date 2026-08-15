const TelegramBot = require('node-telegram-bot-api');
const store = require('./store');
const { signLicense } = require('./license');

let ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '';
const LICENSE_DAYS = parseInt(process.env.LICENSE_DAYS || '30', 10);
const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || '15', 10);

function buildLicense(deviceId, days, graceDays) {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + days * 24 * 60 * 60 * 1000;
  const graceUntil = expiresAt + graceDays * 24 * 60 * 60 * 1000;
  const payload = {
    v: 1,
    deviceId,
    issuedAt,
    expiresAt,
    graceUntil
  };
  return {
    deviceId,
    issuedAt,
    expiresAt,
    graceUntil,
    token: signLicense(payload)
  };
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' });
}

function isAdmin(chatId) {
  return ADMIN_CHAT_ID ? String(chatId) === String(ADMIN_CHAT_ID) : false;
}

function startBot(token) {
  const bot = new TelegramBot(token, { polling: true });
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;

    if (!isAdmin(chatId)) {
      if (cmd === '/start' && !ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '🤖 CotizaTec Admin\n\nTu CHAT ID es: <code>' + chatId + '</code>\n\nConfigúralo en la variable ADMIN_CHAT_ID del servidor para activar los comandos de administración.', { parse_mode: 'HTML' });
        return;
      }
      bot.sendMessage(chatId, '⚠️ No autorizado. Este bot es de administración de CotizaTec.');
      return;
    }

    const [cmd, arg] = text.split(/\s+/);

    if (cmd === '/start' || cmd === '/ayuda') {
      bot.sendMessage(chatId, [
        '🤖 CotizaTec Admin',
        '',
        '/usuarios — usuarios registrados y licencias activas',
        '/activar <deviceId> [días] — activar licencia (por defecto ' + LICENSE_DAYS + ' días)',
        '/renovar <deviceId> [días] — renovar/ampliar licencia',
        '/bloquear <deviceId> — revocar licencia',
        '/estado <deviceId> — ver estado de un dispositivo',
        '/avisar <deviceId> — enviar aviso de pago al cliente',
        ''
      ].join('\n'));
      return;
    }

    if (cmd === '/usuarios') {
      const devices = Object.keys(store.allLicenses());
      const lic = store.allLicenses();
      const lines = ['📊 RESUMEN CotizaTec', '', 'Dispositivos registrados: ' + store.deviceCount(), 'Licencias activas: ' + store.licenseCount(), ''];
      if (devices.length === 0) lines.push('(sin licencias aún)');
      devices.forEach((d) => {
        const l = lic[d];
        const vence = l && l.expiresAt > Date.now() ? '✅ hasta ' + formatDate(l.expiresAt) : '⛔ vencida';
        lines.push('• ' + d.slice(0, 10) + '… ' + vence);
      });
      bot.sendMessage(chatId, lines.join('\n'));
      return;
    }

    if (cmd === '/activar' || cmd === '/renovar') {
      if (!arg) { bot.sendMessage(chatId, 'Usa: ' + cmd + ' <deviceId> [días]'); return; }
      const deviceId = arg.trim();
      const days = parseInt((text.split(/\s+/)[2] || ''), 10) || LICENSE_DAYS;
      const license = buildLicense(deviceId, days, GRACE_DAYS);
      store.setLicense(deviceId, license);
      bot.sendMessage(chatId, '✅ Licencia activada para ' + deviceId.slice(0, 16) + '… por ' + days + ' días.\nVence: ' + formatDate(license.expiresAt));
      return;
    }

    if (cmd === '/bloquear') {
      if (!arg) { bot.sendMessage(chatId, 'Usa: /bloquear <deviceId>'); return; }
      store.removeLicense(arg.trim());
      bot.sendMessage(chatId, '⛔ Licencia revocada para ' + arg.trim().slice(0, 16) + '…');
      return;
    }

    if (cmd === '/estado') {
      if (!arg) { bot.sendMessage(chatId, 'Usa: /estado <deviceId>'); return; }
      const deviceId = arg.trim();
      const l = store.getLicense(deviceId);
      if (!l) { bot.sendMessage(chatId, 'Sin licencia para ' + deviceId.slice(0, 16) + '…'); return; }
      const now = Date.now();
      let st = '❌ bloqueada (venció y pasó gracia)';
      if (now < l.expiresAt) st = '✅ activa';
      else if (now < l.graceUntil) st = '⏳ en período de gracia hasta ' + formatDate(l.graceUntil);
      bot.sendMessage(chatId, 'Estado ' + deviceId.slice(0, 16) + '…: ' + st + '\nActiva desde: ' + formatDate(l.issuedAt) + '\nVence: ' + formatDate(l.expiresAt));
      return;
    }

    if (cmd === '/avisar') {
      if (!arg) { bot.sendMessage(chatId, 'Usa: /avisar <deviceId>'); return; }
      bot.sendMessage(chatId, '📨 Aviso de pago enviado a ' + arg.trim().slice(0, 16) + '… (implementado en la app).');
      return;
    }

    bot.sendMessage(chatId, 'Comando no reconocido. Usa /ayuda');
  });

  bot.on('polling_error', (err) => {
    console.error('[bot] polling error:', err.message);
  });

  return bot;
}

module.exports = { startBot, isAdmin, buildLicense, formatDate };