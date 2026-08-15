const crypto = require('crypto');

function getAdminChatIds() {
  return String(process.env.ADMIN_CHAT_ID || '')
    .replace(/[^0-9,]/g, '')
    .split(',')
    .filter(Boolean)
    .map(Number);
}

function isAdmin(chatId) {
  return getAdminChatIds().indexOf(Number(chatId)) > -1;
}

function validateInitData(initData) {
  const botToken = process.env.TELEGRAM_TOKEN || '';
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    const dataCheckString = [...params.entries()]
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + '=' + v)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    let user = null;
    try { user = JSON.parse(params.get('user') || 'null'); } catch (e) { user = null; }
    return { user, authDate: params.get('auth_date') };
  } catch (e) {
    return null;
  }
}

module.exports = { getAdminChatIds, isAdmin, validateInitData };