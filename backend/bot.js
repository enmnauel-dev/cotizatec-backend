const TelegramBot = require('node-telegram-bot-api');
const store = require('./store');
const { signLicense } = require('./license');
const { isAdmin } = require('./admin');

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

function startBot(token) {
  const clean = String(token || '').replace(/["'\s,;\r\n]+/g, '');
  const bot = new TelegramBot(clean, { polling: true });
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;
    const [cmd, arg] = text.split(/\s+/);

    if (!isAdmin(chatId)) {
      console.log('[bot] mensaje NO autorizado de chat ' + chatId + ' (ADMIN_CHAT_ID=' + JSON.stringify(ADMIN_CHAT_ID) + '): ' + text.slice(0, 40));
      if (cmd === '/start' && !ADMIN_CHAT_ID) {
        bot.sendMessage(chatId, '🤖 CotizaTec Admin\n\nTu CHAT ID es: <code>' + chatId + '</code>\n\nConfigúralo en la variable ADMIN_CHAT_ID del servidor para activar los comandos de administración.', { parse_mode: 'HTML' });
        return;
      }
      bot.sendMessage(chatId, '⚠️ No autorizado. Este bot es de administración de CotizaTec.');
      return;
    }

    if (cmd === '/start' || cmd === '/ayuda') {
      bot.sendMessage(chatId, [
        '🤖 CotizaTec Admin',
        '',
        '/dashboard — abrir panel de administración',
        '/usuarios — usuarios registrados y licencias activas',
        '/activar <deviceId> [días] — activar licencia (por defecto ' + LICENSE_DAYS + ' días)',
        '/renovar <deviceId> [días] — renovar/ampliar licencia',
        '/bloquear <deviceId> — revocar licencia',
        '/estado <deviceId> — ver estado de un dispositivo',
        '/migrar <viejo> <nuevo> — mover respaldo (y licencia) a otro dispositivo',
        '/avisar <deviceId> — enviar aviso de pago al cliente',
        ''
      ].join('\n'));
      return;
    }

    if (cmd === '/dashboard') {
      const webAppUrl = (process.env.WEB_APP_URL || 'https://cotizatec-backend.onrender.com/admin');
      bot.sendMessage(chatId, '📊 Panel de administración CotizaTec', {
        reply_markup: {
          inline_keyboard: [[{ text: '📊 Abrir Dashboard', web_app: { url: webAppUrl } }]]
        }
      });
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
      store.unblockDevice(deviceId);
      store.setLicense(deviceId, license);
      bot.sendMessage(chatId, '✅ Licencia activada para ' + deviceId.slice(0, 16) + '… por ' + days + ' días.\nVence: ' + formatDate(license.expiresAt));
      return;
    }

    if (cmd === '/bloquear') {
if (!arg) { bot.sendMessage(chatId, 'Usa: /bloquear <deviceId>'); return; }
      store.blockDevice(arg.trim());
      bot.sendMessage(chatId, '🔒 Dispositivo bloqueado: ' + arg.trim().slice(0, 16) + '…');
      return;
    }

    if (cmd === '/estado') {
      if (!arg) { bot.sendMessage(chatId, 'Usa: /estado <deviceId>'); return; }
      const deviceId = arg.trim();
      if (store.isBlocked(deviceId)) {
        bot.sendMessage(chatId, 'Estado ' + deviceId.slice(0, 16) + '…: 🔒 bloqueado manualmente.');
        return;
      }
      const l = store.getLicense(deviceId);
      if (!l) { bot.sendMessage(chatId, 'Sin licencia para ' + deviceId.slice(0, 16) + '…'); return; }
      const now = Date.now();
      let st = '❌ bloqueada (venció y pasó gracia)';
      if (now < l.expiresAt) st = '✅ activa';
      else if (now < l.graceUntil) st = '⏳ en período de gracia hasta ' + formatDate(l.graceUntil);
      bot.sendMessage(chatId, 'Estado ' + deviceId.slice(0, 16) + '…: ' + st + '\nActiva desde: ' + formatDate(l.issuedAt) + '\nVence: ' + formatDate(l.expiresAt));
      return;
    }

    if (cmd === '/migrar') {
      const parts = text.split(/\s+/);
      const fromId = (parts[1] || '').trim();
      const toId = (parts[2] || '').trim();
      if (!fromId || !toId) { bot.sendMessage(chatId, 'Usa: /migrar <deviceId_viejo> <deviceId_nuevo>'); return; }
      try {
        const result = await store.migrateDevice(fromId, toId);
        store.blockDevice(fromId);
        let licMsg = 'ℹ️ el viejo no tenía licencia';
        if (result.licenseMoved) {
          const newLic = store.getLicense(toId);
          licMsg = '✅ licencia movida (vence ' + (newLic ? formatDate(newLic.expiresAt) : '?') + ')';
        } else if (store.getLicense(fromId)) {
          licMsg = 'ℹ️ el viejo estaba en prueba (no se mueve; el nuevo ya tiene su trial)';
        }
        bot.sendMessage(chatId,
          '🔄 Migración iniciada:\n' +
          '• Respaldo: ' + (result.backupExists ? '✅ listo para heredar (el nuevo lo descargará, descifrará y re-cifrará al abrir la app)' : '⚠️ no había respaldo para ' + fromId.slice(0, 16) + '…') + '\n' +
          '• Licencia: ' + licMsg + '\n' +
          '• Dispositivo viejo: bloqueado (deja de funcionar)\n' +
          '💡 El cliente solo debe abrir la app en el equipo nuevo: restaurará sus datos automáticamente.');
      } catch (e) {
        console.error('[bot] /migrar error:', e.message);
        bot.sendMessage(chatId, '❌ Error al migrar: ' + e.message);
      }
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