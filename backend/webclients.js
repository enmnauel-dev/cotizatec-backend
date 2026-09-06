const crypto = require('crypto');

// ===== Cuentas web de clientes =====
// Permite que cada cliente (negocio) cree su usuario/contraseña y, al iniciar
// sesión, vea un panel con sus métricas. Para mostrar las ventas, el servidor
// debe poder descifrar el respaldo que sube la app. La app cifra con AES-256-GCM
// usando una clave derivada (PBKDF2) de CLOUD_SECRET + "::" + deviceId. Como ese
// secreto está embebido en el código de la app y es el mismo en el servidor,
// este puede descifrar los respaldos de los dispositivos del cliente.

const CLOUD_SECRET = 'cotizatec-cloud-backup-v1';
const ENC_ITER = 120000;
const SALT_B64 = 'Y290aXphdGVjLWNsb3VkLXNhbHQ=';

// Secreto para firmar los tokens de sesión de los clientes web. En producción
// debe venir de env (WEB_TOKEN_SECRET). Se genera uno aleatorio como respaldo.
function tokenSecret() {
  return process.env.WEB_TOKEN_SECRET || 'cotizatec-web-token-' + (process.env.LICENSE_PRIVATE_KEY || 'dev-secret');
}

// ===== Hash de contraseña (scrypt, seguro y nativo) =====
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, 64, (err, key) => {
      if (err) return reject(err);
      resolve(salt.toString('hex') + ':' + key.toString('hex'));
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const parts = String(stored || '').split(':');
    if (parts.length !== 2) return resolve(false);
    const salt = Buffer.from(parts[0], 'hex');
    const key = Buffer.from(parts[1], 'hex');
    crypto.scrypt(String(password), salt, key.length, (err, derived) => {
      if (err) return reject(err);
      resolve(crypto.timingSafeEqual(key, derived));
    });
  });
}

// ===== Token de sesión firmado con HMAC (sin dependencias) =====
function issueToken(account) {
  const payload = {
    sub: account.userId || account.clientId, // identidad única por usuario
    clientId: account.clientId,
    role: account.role || 'owner',
    iat: Date.now(),
    exp: Date.now() + 7 * 86400000 // 7 días
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
  return body + '.' + sig;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto.createHmac('sha256', tokenSecret()).update(body).digest('base64url');
    const a = Buffer.from(sig).toString('base64url');
    const b = Buffer.from(expected).toString('base64url');
    if (a !== b) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ===== Descifrado del respaldo de la app =====
// Replica exactamente la derivación de clave de js/backup.js.
function cloudKey(deviceId) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(
      String(CLOUD_SECRET + '::' + deviceId),
      Buffer.from(SALT_B64, 'base64'),
      ENC_ITER,
      32,
      'sha256',
      (err, key) => {
        if (err) return reject(err);
        resolve(key);
      }
    );
  });
}

function decryptBackup(deviceId, encStr) {
  let env;
  try { env = JSON.parse(encStr); } catch (e) { return Promise.resolve(null); }
  if (!env || env.enc !== 'aes-gcm' || !env.iv || !env.ct) return Promise.resolve(null);
  return cloudKey(deviceId).then((key) => {
    return new Promise((resolve) => {
      try {
        const iv = Buffer.from(env.iv, 'base64');
        const ct = Buffer.from(env.ct, 'base64');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        // AES-GCM requiere auth tag al final del ciphertext
        const tag = ct.slice(ct.length - 16);
        const data = ct.slice(0, ct.length - 16);
        decipher.setAuthTag(tag);
        const out = Buffer.concat([decipher.update(data), decipher.final()]);
        resolve(out.toString('utf8'));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// ===== Cálculo de métricas a partir del estado de la app =====
function computeReport(state) {
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
  function money(v) { return (Math.round(num(v) * 100) / 100); }

  const jobs = (state.jobs || []).filter((j) => {
    const d = new Date(j.date);
    return !isNaN(d.getTime());
  });

  function jobTotals(j) {
    const subtotal = (j.items || []).reduce((a, i) => a + num(i.qty) * num(i.price), 0);
    const discount = num(j.discount);
    const taxable = Math.max(0, subtotal - discount);
    const itbis = num(j.itbis);
    const tax = itbis > 0 ? (taxable * itbis) / 100 : 0;
    const total = taxable + tax;
    const itemsCost = (j.items || []).reduce((a, i) => a + num(i.qty) * num(i.cost), 0);
    const expenses = (j.expenses || []).reduce((a, e) => a + num(e.amount), 0);
    const cost = itemsCost + expenses;
    const collected = (j.payments || []).reduce((a, p) => a + num(p.amount), 0);
    const balance = Math.max(0, total - collected);
    const margin = total - cost;
    return { subtotal, discount, itbis, tax, total, itemsCost, expenses, cost, collected, balance, margin };
  }

  const nowKey = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

  const totals = {
    facturado: 0,
    cobrado: 0,
    porCobrar: 0,
    gastado: 0,
    ganancia: 0,
    trabajos: 0,
    pendientes: 0,
    cotizaciones: 0,
    ventas: 0
  };
  const monthly = {};
  const active = jobs.filter((j) => j.status !== 'CANCELADO');
  // Se considera "cotización" un trabajo aún en COTIZADO; el resto cuenta como venta.
  function isCotizacion(j) { return (j.status || '').toUpperCase() === 'COTIZADO'; }

  active.forEach((j) => {
    const t = jobTotals(j);
    totals.facturado += t.total;
    totals.porCobrar += t.balance;
    totals.gastado += t.cost;
    totals.ganancia += t.margin;
    totals.trabajos++;
    if (isCotizacion(j)) totals.cotizaciones++; else totals.ventas++;
    if (t.balance > 0) totals.pendientes++;
    const key = nowKey(new Date(j.date));
    if (!monthly[key]) monthly[key] = { facturado: 0, cobrado: 0, porCobrar: 0, gastado: 0, ganancia: 0, trabajos: 0 };
    monthly[key].facturado += t.total;
    monthly[key].porCobrar += t.balance;
    monthly[key].gastado += t.cost;
    monthly[key].ganancia += t.margin;
    monthly[key].trabajos++;
  });

  // Cobrado por fecha de pago (no por fecha de trabajo)
  jobs.forEach((j) => {
    (j.payments || []).forEach((p) => {
      const d = new Date(p.date);
      if (isNaN(d.getTime())) return;
      const key = nowKey(d);
      if (!monthly[key]) monthly[key] = { facturado: 0, cobrado: 0, porCobrar: 0, gastado: 0, ganancia: 0, trabajos: 0 };
      monthly[key].cobrado += num(p.amount);
      totals.cobrado += num(p.amount);
    });
  });

  // Últimos trabajos
  const recent = active.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 20).map((j) => {
    const t = jobTotals(j);
    return {
      code: j.code || j.number || 'Cotización',
      client: j.clientName || 'Sin cliente',
      date: j.date,
      status: j.status || '',
      total: money(t.total),
      balance: money(t.balance),
      margin: money(t.margin)
    };
  });

  const monthlyArr = Object.keys(monthly).sort().reverse().map((k) => ({
    month: k,
    facturado: money(monthly[k].facturado),
    cobrado: money(monthly[k].cobrado),
    porCobrar: money(monthly[k].porCobrar),
    gastado: money(monthly[k].gastado),
    ganancia: money(monthly[k].ganancia),
    trabajos: monthly[k].trabajos
  }));

  // ===== Comparativa de período equivalente =====
  // Compara el mes actual (hasta hoy) contra el MISMO período del mes anterior
  // (día 1 al mismo día del mes previo), para no comparar un mes incompleto
  // contra otro completo.
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth();
  const dayOfMonth = today.getDate();
  const todayISO = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(dayOfMonth).padStart(2, '0');
  const prevDate = new Date(y, m - 1, 1);
  const prevISO = prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0') + '-01';

  // Suma de facturado por día (para acotar el período hasta hoy)
  const daily = {};
  active.forEach((j) => {
    const d = new Date(j.date);
    if (isNaN(d.getTime())) return;
    const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    daily[iso] = (daily[iso] || 0) + jobTotals(j).total;
  });

  const inPeriod = (iso, startISO, endISO) => iso >= startISO && iso <= endISO;
  let current = 0;
  Object.keys(daily).forEach((k) => { if (k >= todayISO.slice(0, 8) + '01' && k <= todayISO) current += daily[k]; });
  let prev = 0;
  Object.keys(daily).forEach((k) => { if (inPeriod(k, prevISO, prevDayISO(prevDate, dayOfMonth))) prev += daily[k]; });

  function prevDayISO(prevDate, dm) {
    // Último día del mes anterior que existe en el rango comparado
    const lastDay = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 0).getDate();
    const dd = Math.min(dm, lastDay);
    return prevDate.getFullYear() + '-' + String(prevDate.getMonth() + 1).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }

  const monthName = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][m];
  const prevName = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][prevDate.getMonth()];

  let pctDiff = null;
  let comparisonMsg = null;
  let vsText = null;
  if (current > 0 || prev > 0) {
    if (prev === 0) {
      pctDiff = null;
      vsText = 'No hubo ventas el mismo período de ' + prevName + '.';
      comparisonMsg = 'Estás iniciando este mes con estas ventas.';
    } else {
      pctDiff = Math.round(((current - prev) / prev) * 1000) / 10;
      const above = current >= prev;
      vsText = 'Vas ' + Math.abs(pctDiff).toFixed(1).replace(/\.0$/, '') + '% ' + (above ? 'por encima' : 'por debajo') + ' del mismo período de ' + prevName + ' (1–' + dayOfMonth + ').';
      comparisonMsg = vsText;
    }
  }

  // Serie para el gráfico: últimos 12 meses (facturado), en orden cronológico
  const series = [];
  for (let i = 11; i >= 0; i--) {
    const sd = new Date(y, m - i, 1);
    const key = sd.getFullYear() + '-' + String(sd.getMonth() + 1).padStart(2, '0');
    const val = monthly[key] ? monthly[key].facturado : 0;
    series.push({
      key,
      label: ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][sd.getMonth()],
      facturado: money(val)
    });
  }

  const meta = {
    businessName: (state.settings && (state.settings.businessName || state.settings.tallerName || state.settings.name)) || '',
    comparison: {
      monthName, prevName, dayOfMonth, current: money(current), prev: money(prev),
      pctDiff, vsText, comparisonMsg
    }
  };

  return {
    totals: {
      facturado: money(totals.facturado),
      cobrado: money(totals.cobrado),
      porCobrar: money(totals.porCobrar),
      gastado: money(totals.gastado),
      ganancia: money(totals.ganancia),
      trabajos: totals.trabajos,
      pendientes: totals.pendientes,
      cotizaciones: totals.cotizaciones,
      ventas: totals.ventas,
      clientes: (state.clients || []).length,
      productos: (state.catalog || []).length
    },
    monthly: monthlyArr,
    recent,
    series,
    meta
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  decryptBackup,
  computeReport
};
