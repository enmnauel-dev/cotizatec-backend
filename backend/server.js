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
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.', code: 'INVALID_CREDENTIALS' });
    }
    const ok = await webclients.verifyPassword(password, account.passHash);
    if (!ok) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.', code: 'INVALID_CREDENTIALS' });
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
    res.status(401).json({ error: 'Sesión inválida o expirada.', code: 'UNAUTHORIZED' });
    return null;
  }
  const account = store.getWebAccountById(info.sub);
  if (!account) {
    res.status(401).json({ error: 'Cuenta no encontrada.', code: 'UNAUTHORIZED' });
    return null;
  }
  if (account.status === 'inactivo') {
    res.status(403).json({ error: 'Tu cuenta está desactivada.', code: 'ACCOUNT_DISABLED' });
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
      const client0 = store.getClient(account.clientId);
      return res.json({ ok: true, hasData: false, report: null, modules: client0 && client0.modules || [], plan: client0 && client0.plan || null, message: 'TodavÃ­a no hay datos de ventas para este cliente.' });
    }
    const report = webclients.computeReport(state);
    const client = store.getClient(account.clientId);
    res.json({ ok: true, hasData: true, report, modules: client && client.modules || [], plan: client && client.plan || null });
  } catch (e) {
    console.error('[client] report error:', e.message);
    res.status(500).json({ error: 'Error al leer los datos.' });
  }
});

// ===== Documentos del portal web (módulo 'documentos') =====
// Se generan SOLO desde la web con los datos del negocio (cliente, trabajo,
// montos, pagos, saldo) y se almacenan en el backend aislados por clientId.
function docMoney(n) {
  const v = Number(n) || 0;
  return 'RD$ ' + v.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function docFmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('es-DO', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (e) { return iso; }
}
function docNumber() {
  return 'DOC-' + String(Date.now()).slice(-6) + '-' + Math.floor(Math.random() * 90 + 10);
}
// Replica la fórmula de la app (js/db.js -> jobTotals)
function jobTotalsWeb(j) {
  const subtotal = (j.items || []).reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const taxable = Math.max(0, subtotal - (Number(j.discount) || 0));
  const itbis = Number(j.itbis) || 0;
  const tax = itbis > 0 ? taxable * itbis / 100 : 0;
  const total = taxable + tax;
  const collected = (j.payments || []).reduce((a, p) => a + (Number(p.amount) || 0), 0);
  const balance = Math.max(0, total - collected);
  return { subtotal, discount: Number(j.discount) || 0, itbis, tax, total, collected, balance };
}
const DOC_ENABLED = {
  'carta-saldo': true,
  'debo-pagare': true,
  'testigos': true,
  'pagare-notarial': true,
  'pagare-garantia': true,
  'entrega-voluntaria': true,
  'debo-pagare-garantia': true,
  'intimacion': true
};
const DOC_TITLES = {
  'carta-saldo': 'Carta de Saldo',
  'debo-pagare': 'Debo y Pagaré',
  'testigos': 'Declaración de Testigos',
  'pagare-notarial': 'Pagaré Notarial',
  'pagare-garantia': 'Pagaré con Garantía',
  'entrega-voluntaria': 'Entrega Voluntaria del Bien',
  'debo-pagare-garantia': 'Debo y Pagaré con Garantía',
  'intimacion': 'Intimación de Pago'
};
// Reglas por tipo: unos exigen saldo pendiente, carta-saldo exige saldo RD$ 0.
const DOC_REQUIRES_PENDING = { 'debo-pagare': true, 'pagare-notarial': true, 'pagare-garantia': true, 'debo-pagare-garantia': true, 'entrega-voluntaria': true, 'intimacion': true };
const DOC_REQUIRES_BIEN = { 'pagare-garantia': true, 'debo-pagare-garantia': true, 'entrega-voluntaria': true };

const DOC_CSS = `
<style>
  body { font-family: Georgia, serif; color: #111; max-width: 720px; margin: 0 auto; padding: 48px 40px; font-size: 15px; line-height: 1.6; }
  h1 { text-align: center; font-size: 22px; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 4px; }
  .biz { text-align: center; font-size: 14px; margin-bottom: 4px; }
  .line { border-bottom: 3px double #111; margin: 14px 0 26px; }
  .doc-no { text-align: right; font-size: 12px; color: #444; margin-bottom: 20px; }
  p { text-align: justify; }
  table { width: 100%; border-collapse: collapse; margin: 22px 0; }
  td, th { border: 1px solid #aaa; padding: 8px 10px; font-size: 14px; }
  .amt { text-align: right; white-space: nowrap; }
  .sign { display: flex; justify-content: space-between; margin-top: 64px; }
  .sign .box { text-align: center; }
  .sign .line2 { border-top: 1px solid #111; margin-top: 52px; width: 220px; font-size: 13px; }
  .foot { margin-top: 40px; font-size: 11px; color: #555; text-align: center; }
  .list { margin: 20px 0; padding-left: 4px; }
  .list tr td { border-top: 1px dashed #aaa; }
  .fill { display: inline-block; border-bottom: 1px solid #111; min-width: 160px; }
</style>`;

function docHTML(doc) {
  const c = doc.data || {};
  const biz = c.businessName || 'CotizaTec';
  const ciudad = c.ciudad || 'Santiago de los Caballeros';
  const hoy = docFmtDate(doc.createdAt) || docFmtDate(new Date());
  const debtor = c.debtor || c.clientName || '____________________';
  const debtorId = c.debtorId || '____________________';
  const debtorAddr = c.debtorAddr || '____________________';
  const jobCode = c.jobCode || '________________';
  const total = docMoney(c.total);
  const collected = docMoney(c.collected);
  const balance = docMoney(c.balance);
  const bien = c.bien || '______________________________________ (describir el bien entregado en garantía, ejemplo: vehículo marca/modelo, chasis No. ____)';
  const notario = c.notario || '____________________';
  const notarioNum = c.notarioNum || '___';
  const testigos = (c.testigos && c.testigos.length ? c.testigos : []);
  const witnessesTable = testigos.length
    ? `<table><tr><th>Nombre del testigo</th><th>Cédula / Documento</th><th>Firma</th></tr>${testigos.map((w) => `<tr><td>${escHTML(w.name)}</td><td>${escHTML(w.doc)}</td><td style="height:34px">·</td></tr>`).join('')}</table>`
    : `<table><tr><th>Nombre del testigo</th><th>Cédula / Documento</th><th>Firma</th></tr><tr><td>1. ______________</td><td>________</td><td style="height:34px">·</td></tr><tr><td>2. ______________</td><td>________</td><td style="height:34px">·</td></tr></table>`;

  let title, sub, body;
  switch (doc.type) {
    case 'carta-saldo':
      title = 'Carta de Saldo'; sub = 'FINIQUITO Y CARTA DE PAGO';
      body = `
        <p>Por medio de la presente, <b>${biz}</b>, establecimiento comercial con domicilio en ${ciudad}, República Dominicana, hace constar y CERTIFICA que el/la señor(a) <b>${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, ha cancelado en su totalidad la obligación derivada de la operación <b>${jobCode}</b>, por el monto de <b>${total}</b>.</p>
        <p>Que al día de la fecha, el referido cliente <b>no adeuda suma alguna</b> a favor de ${biz}, quedando de esta manera finiquitado y libre de cualquier compromiso pendiente con la presente operación.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto total</th><th>Total abonado</th><th>Saldo</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>RD$ 0.00</b></td></tr></table>
        <p>Esta carta de saldo se expide a solicitud de la parte interesada, a los ${hoy}.</p>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma del CLIENTE</div></div><div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div></div>`;
      break;
    case 'debo-pagare':
      title = 'Declaración de Deuda'; sub = 'PAGARÉ NO NEGOCIABLE';
      body = `
        <p>En la ciudad de ${ciudad}, República Dominicana, a los ${hoy}, por medio del presente documento y con valor de Carta de Pago y Finiquito entre partes, <b>YO, ${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, mayor de edad, domiciliado(a) en <b>${debtorAddr}</b>, en mi calidad de <b>DEUDOR(A)</b>, declaro tener y reconocer expresamente la obligación de pagar a favor de <b>${biz}</b> la suma de <b>${balance}</b>, equivalente al saldo pendiente de la operación ${jobCode}, por los conceptos y servicios prestados.</p>
        <p>Me obligo a pagar el monto total adeudado en fecha <b>${c.fechaPago ? docFmtDate(c.fechaPago) : '____________________'}</b>, en moneda de curso legal, sin necesidad de intimación ni requerimiento previo.</p>
        <p>En caso de incumplimiento, autorizo expresamente a ${biz} a ejercer las acciones legales correspondientes, incluyendo el cobro judicial, por lo que este documento constituye un título suficiente.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Abonado</th><th>Saldo pendiente</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <p>Firmado en ${ciudad} a los ${hoy}.</p>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma del DEUDOR(A)</div></div><div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div></div>`;
      break;
    case 'testigos':
      title = 'Declaración de Testigos'; sub = 'VALIDACIÓN DE CONTRATO / PAGARÉ';
      body = `
        <p>Por medio de la presente, en la ciudad de ${ciudad}, República Dominicana, a los ${hoy}, los suscritos comparecen como <b>TESTIGOS</b> en el acto relativo a la obligación derivada de la operación <b>${jobCode}</b>, suscrita entre el(la) señor(a) <b>${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, y <b>${biz}</b>, por un monto de <b>${total}</b>.</p>
        <p>Los comparecientes declaran, bajo fe de juramento, haber presenciado la firma del documento y dan fe de la veracidad y libre consentimiento de las partes.</p>
        ${witnessesTable}
        <div class="sign">
          <div class="box"><div>.</div><div class="line2">Testigo 1</div></div>
          <div class="box"><div>.</div><div class="line2">Testigo 2</div></div>
          <div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div>
        </div>`;
      break;
    case 'pagare-notarial':
      title = 'Pagaré Notarial'; sub = 'DEUDA FORMALIZADA ANTE NOTARIO';
      body = `
        <p>Ante el <b>Notario Público No. ${notarioNum}</b> del municipio de ${ciudad}, República Dominicana, licenciado(a) <b>${notario}</b>, se hizo presente el(la) señor(a) <b>${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, mayor de edad, domiciliado(a) en <b>${debtorAddr}</b>, quien DECLARA adeudar a favor de <b>${biz}</b> la suma de <b>${balance}</b>, correspondiente al saldo de la operación <b>${jobCode}</b>, y se obliga a pagarla en fecha <b>${c.fechaPago ? docFmtDate(c.fechaPago) : '____________________'}</b>.</p>
        <p>El presente pagaré se otorga con <b>fuerza ejecutiva</b> para el cobro judicial en caso de incumplimiento, conforme a las disposiciones legales aplicables de la República Dominicana.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Abonado</th><th>Saldo pendiente</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <p>Firmado y sellado en presencia del Notario, a los ${hoy}.</p>
        <div class="sign">
          <div class="box"><div>.</div><div class="line2">Firma del DEUDOR(A)</div></div>
          <div class="box"><div>.</div><div class="line2">Notario Público No. ${notarioNum} — ${escHTML(notario)}</div></div>
        </div>`;
      break;
    case 'pagare-garantia':
      title = 'Pagaré con Garantía'; sub = 'COMPROMISO DE PAGO RESPALDADO POR UN BIEN';
      body = `
        <p>En la ciudad de ${ciudad}, República Dominicana, a los ${hoy}, <b>YO, ${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, mayor de edad, domiciliado(a) en <b>${debtorAddr}</b>, en calidad de <b>DEUDOR(A)</b>, reconozco adeudar a favor de <b>${biz}</b> la suma de <b>${balance}</b>, correspondiente al saldo de la operación <b>${jobCode}</b>.</p>
        <p>Para garantizar el cumplimiento de esta obligación, entrego en <b>GARANTÍA</b> el siguiente bien: <b class="fill">${bien}</b>, el cual responderá por la deuda en caso de no ser satisfecha.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Abonado</th><th>Saldo pendiente</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <p>Autorizo expresamente el cobro judicial en caso de incumplimiento.</p>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma del DEUDOR(A)</div></div><div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div></div>`;
      break;
    case 'debo-pagare-garantia':
      title = 'Debo y Pagaré con Garantía'; sub = 'COMPROMISO DE PAGO CON PRENDA';
      body = `
        <p>En la ciudad de ${ciudad}, República Dominicana, a los ${hoy}, <b>YO, ${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, domiciliado(a) en <b>${debtorAddr}</b>, DECLARO deber y la obligación de pagar a favor de <b>${biz}</b> la suma de <b>${balance}</b>, por el saldo pendiente de la operación <b>${jobCode}</b>.</p>
        <p>En señal de garantía de dicho pago, formalizo la inclusión de la siguiente <b>prenda o bien</b> como aval del monto prestado: <b class="fill">${bien}</b>.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Abonado</th><th>Saldo pendiente</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <p>Me obligo a pagar en fecha <b>${c.fechaPago ? docFmtDate(c.fechaPago) : '____________________'}</b>. En caso de incumplimiento, el bien entregado en garantía podrá destinarse al pago de la deuda.</p>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma del DEUDOR(A)</div></div><div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div></div>`;
      break;
    case 'entrega-voluntaria':
      title = 'Entrega Voluntaria del Bien'; sub = 'ACUERDO DE DEVOLUCIÓN EN GARANTÍA';
      body = `
        <p>En la ciudad de ${ciudad}, República Dominicana, a los ${hoy}, entre <b>${biz}</b> y el(la) señor(a) <b>${debtor}</b>, con documento de identidad No. <b>${debtorId}</b>, se ha convenido lo siguiente:</p>
        <p>Que el deudor, obligado por la operación <b>${jobCode}</b>, por un saldo de <b>${balance}</b>, procede a la <b>ENTREGA VOLUNTARIA</b> del bien: <b class="fill">${bien}</b>, a favor de ${biz}, para saldar la deuda referida sin necesidad de recurrir a juicio de embargo.</p>
        <p>Otorgada la presente entrega, el deudor queda descargado de la obligación en la medida del valor del bien entregado, quedando constancia de cualquier diferencia pendiente en su caso.</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Abonado</th><th>Saldo antes de entrega</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma del DEUDOR(A)</div></div><div class="box"><div>.</div><div class="line2">Sello y firma — ${escHTML(biz)}</div></div></div>`;
      break;
    case 'intimacion':
      title = 'Intimación de Pago'; sub = 'NOTIFICACIÓN DE COBRO';
      body = `
        <p>En cumplimiento de las disposiciones legales, <b>${biz}</b> INTIMA formalmente al(la) señor(a) <b>${debtor}</b>, domiciliado(a) en <b>${debtorAddr}</b>, a regularizar las siguientes obligaciones vencidas derivadas de la operación <b>${jobCode}</b>:</p>
        <table><tr><th>Concepto / Operación</th><th>Monto original</th><th>Total abonado</th><th>Saldo vencido</th></tr>
          <tr><td>${jobCode}</td><td class="amt">${total}</td><td class="amt">${collected}</td><td class="amt"><b>${balance}</b></td></tr></table>
        <p>Se concede un plazo de <b>___ días</b> a partir de la recepción de la presente para saldar el monto adeudado. Vencido este plazo sin el pago correspondiente, se procederá a ejercer las acciones legales pertinentes, incluyendo el embargo y/o demanda judicial.</p>
        <p>Firmado en ${ciudad}, República Dominicana, a los ${hoy}.</p>
        <div class="sign"><div class="box"><div>.</div><div class="line2">Firma — ${escHTML(biz)}</div></div><div class="box"><div>.</div><div class="line2">Recibido: firma del DEUDOR</div></div></div>`;
      break;
    default:
      return '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"></head><body><p>Documento no disponible.</p></body></html>';
  }

  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${DOC_CSS}</head><body>
  <div class="doc-no">No.: ${doc.number}</div>
  <h1>${title}</h1>
  <div class="biz">${sub}</div>
  <div class="line"></div>
  ${body}
  <div class="foot">Documento generado por el portal web de CotizaTec — No. ${doc.number} · Plantilla v${doc.templateVersion || '1.0'}</div>
</body></html>`;
}
function escHTML(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]; }); }

// Estado operativo (clientes + trabajos con saldos) para alimentar selección
app.get('/api/client/data', async (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const { account } = auth;
  const client = store.getClient(account.clientId);
  const modules = (client && client.modules) || [];
  if (modules.indexOf('documentos') === -1) return res.status(403).json({ error: 'Tu negocio no tiene contratado el módulo de Documentos.' });
  try {
    const data = await readClientData(account.clientId);
    if (!data.ok || !data.state) return res.json({ ok: true, clients: [], jobs: [] });
    const st = data.state;
    const clients = (st.clients || []).map((c) => ({ id: c.id, name: c.name, phone: c.phone || '' }));
    const jobs = (st.jobs || []).map((j) => {
      const t = jobTotalsWeb(j);
      return { id: j.id, code: j.code || '', number: j.number, date: j.date, clientId: j.clientId, clientName: j.clientName || '', status: j.status || 'COTIZADO', total: t.total, collected: t.collected, balance: t.balance };
    });
    res.json({ ok: true, clients, jobs });
  } catch (e) {
    console.error('[client] data error:', e.message);
    res.status(500).json({ error: 'Error al leer los datos.' });
  }
});

// Generar un documento (gate módulo documentos; válido para tipos habilitados)
app.post('/api/client/documents', async (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const { account } = auth;
  const client = store.getClient(account.clientId);
  const modules = (client && client.modules) || [];
  if (modules.indexOf('documentos') === -1) return res.status(403).json({ error: 'Tu negocio no tiene contratado el módulo de Documentos.' });
  const type = String(req.body.type || '').trim();
  const jobId = String(req.body.jobId || '').trim();
  if (!DOC_ENABLED[type]) return res.status(400).json({ error: 'Tipo de documento no disponible todavía.' });
  if (!jobId) return res.status(400).json({ error: 'Selecciona un trabajo.' });
  try {
    const data = await readClientData(account.clientId);
    if (!data.ok || !data.state) return res.status(404).json({ error: 'No hay datos del negocio.' });
    const job = (data.state.jobs || []).find((j) => String(j.id) === String(jobId));
    if (!job) return res.status(404).json({ error: 'Trabajo no encontrado.' });
    const t = jobTotalsWeb(job);
    const c = data.state.clients || [];
    const clientRow = c.find((x) => String(x.id) === String(job.clientId)) || null;
    if (type === 'carta-saldo' && (t.balance > 0 || job.status === 'COTIZADO')) {
      return res.status(400).json({ error: 'La Carta de Saldo solo se emite para trabajos totalmente cobrados (saldo RD$ 0).' });
    }
    if (DOC_REQUIRES_PENDING[type] && t.balance <= 0) {
      return res.status(400).json({ error: 'Este documento requiere un trabajo con saldo pendiente mayor a RD$ 0.' });
    }
    const bien = String(req.body.bien || '').trim();
    if (DOC_REQUIRES_BIEN[type] && !bien) {
      return res.status(400).json({ error: 'Indica la descripción del bien que respalda la garantía.' });
    }
    const doc = {
      id: 'doc-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      number: docNumber(),
      businessId: account.clientId,
      clientId: job.clientId || null,
      jobId: job.id,
      jobCode: job.code || (job.number || ''),
      type,
      status: 'emitido',
      createdAt: Date.now(),
      amount: t.total,
      collected: t.collected,
      balance: t.balance,
      paidInFull: t.balance <= 0,
      templateVersion: 'v1.0',
      data: {
        businessName: (data.state.settings && data.state.settings.businessName) || (client && client.name) || '',
        clientName: job.clientName || (clientRow && clientRow.name) || '',
        clientPhone: job.clientPhone || (clientRow && clientRow.phone) || '',
        debtorId: clientRow && clientRow.document || '',
        debtorAddr: clientRow && clientRow.address || '',
        jobCode: job.code || (job.number || ''),
        total: t.total,
        collected: t.collected,
        balance: t.balance,
        bien: bien,
        fechaPago: req.body.fechaPago || null,
        testigos: Array.isArray(req.body.testigos) ? req.body.testigos.slice(0, 5).map((w) => ({ name: String((w && w.name) || '').trim(), doc: String((w && w.doc) || '').trim() })).filter((w) => w.name) : [],
        ciudad: String(req.body.ciudad || '').trim() || null
      }
    };
    store.addDocument(doc);
    res.json({ ok: true, doc: publicDoc(doc), html: docHTML(doc) });
  } catch (e) {
    console.error('[client] doc create error:', e.message);
    res.status(500).json({ error: 'Error al generar el documento.' });
  }
});

function publicDoc(d) {
  return { id: d.id, number: d.number, type: d.type, title: DOC_TITLES[d.type] || d.type, status: d.status, createdAt: d.createdAt, clientName: d.data && d.data.clientName || '', jobCode: d.jobCode, amount: d.amount, collected: d.collected, balance: d.balance, paidInFull: d.paidInFull };
}

// Listar documentos del negocio (con filtro opcional por clienteId)
app.get('/api/client/documents', (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const client = store.getClient(auth.account.clientId);
  if ((client && client.modules || []).indexOf('documentos') === -1) return res.status(403).json({ error: 'Módulo de Documentos no contratado.' });
  const clientIdParam = String(req.query.clientId || '').trim();
  let docs = store.listDocumentsByClient(auth.account.clientId);
  if (clientIdParam) docs = docs.filter((d) => String(d.clientId) === String(clientIdParam));
  res.json({ ok: true, documents: docs.map(publicDoc) });
});

// Obtener un documento (HTML para imprimir) — aislado por negocio
app.get('/api/client/documents/:id', (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const doc = store.getDocument(String(req.params.id || '').trim());
  if (!doc || String(doc.businessId) !== String(auth.account.clientId)) {
    return res.status(404).json({ error: 'Documento no encontrado.' });
  }
  res.json({ ok: true, doc: publicDoc(doc), html: docHTML(doc) });
});

// Eliminar documento — solo del propio negocio
app.delete('/api/client/documents/:id', (req, res) => {
  const auth = requireClient(req, res);
  if (!auth) return;
  const doc = store.getDocument(String(req.params.id || '').trim());
  if (!doc || String(doc.businessId) !== String(auth.account.clientId)) {
    return res.status(404).json({ error: 'Documento no encontrado.' });
  }
  store.removeDocument(doc.id);
  res.json({ ok: true });
});

// ===== GestiÃ³n de usuarios del portal (solo el dueÃ±o del negocio) =====
// El dueÃ±o (role: owner) administra los usuarios web de SU PROPIO negocio.
// Se garantiza aislamiento total: solo puede operar sobre su clientId.
function requireOwner(req, res) {
  const auth = requireClient(req, res);
  if (!auth) return null;
  if (auth.info.role !== 'owner') {
    res.status(403).json({ error: 'Solo el dueño del negocio puede administrar usuarios.', code: 'OWNER_ONLY' });
    return null;
  }
  return auth;
}

const PORTAL_MAX_USERS = parseInt(process.env.PORTAL_MAX_USERS || '10', 10);

// ===== GPS / rastreo de flota (módulo 'gps') =====
// La app móvil de los operadores reporta su posición con el token de su
// cuenta web; el dueño del negocio la consulta desde el panel web.
app.post('/api/client/gps', (req, res) => {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = license.verifyLicense(bearer);
  if (!payload || !payload.deviceId) {
    return res.status(401).json({ error: 'Token de dispositivo inválido o expirado.', code: 'UNAUTHORIZED' });
  }
  const client = store.getClientByDeviceId(payload.deviceId);
  if (!client) {
    return res.status(403).json({ error: 'Este dispositivo no está vinculado a un negocio.', code: 'DEVICE_UNASSIGNED' });
  }
  if ((client.modules || []).indexOf('gps') === -1) {
    return res.status(403).json({ error: 'Tu negocio no tiene contratado el módulo de GPS.', code: 'MODULE_DISABLED' });
  }
  const lat = Number(req.body.lat);
  const lon = Number(req.body.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Coordenadas inválidas (lat -90..90, lon -180..180).', code: 'INVALID_COORDINATES' });
  }
  const round2 = (n) => Math.round(n * 100) / 100;
  const pos = {
    lat,
    lon,
    acc: isFinite(Number(req.body.acc)) ? round2(Number(req.body.acc)) : null,
    speed: isFinite(Number(req.body.speed)) ? round2(Number(req.body.speed)) : null,
    ts: req.body.ts ? Number(req.body.ts) : Date.now()
  };
  store.setGpsPosition(client.id, String(payload.deviceId), pos);
  res.json({ ok: true, pos, timestamp: new Date().toISOString() });
});

app.get('/api/client/gps', (req, res) => {
  const auth = requireOwner(req, res);
  if (!auth) return;
  const client = store.getClient(auth.account.clientId) || {};
  if ((client.modules || []).indexOf('gps') === -1) {
    return res.status(403).json({ error: 'Tu negocio no tiene contratado el módulo de GPS.', code: 'MODULE_DISABLED' });
  }
  const map = store.getGpsMap(client.id) || {};
  const devices = client.devices || [];
  const positions = devices.map((d) => {
    const pos = map[d.deviceId] || null;
    return pos ? { deviceId: d.deviceId, name: d.alias || d.deviceId, pos } : null;
  }).filter(Boolean);
  res.json({ ok: true, updated: Date.now(), timestamp: new Date().toISOString(), positions });
});

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
    const monthly = report.monthly || [];
    activity = {
      ventas: report.totals && report.totals.ventas || 0,
      cotizaciones: report.totals && report.totals.cotizaciones || 0,
      facturadoMes: monthly.length ? monthly[monthly.length - 1].facturado || 0 : 0
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
      const client0 = store.getClient(clientId);
      return res.json({ ok: true, hasData: false, report: null, modules: client0 && client0.modules || [], plan: client0 && client0.plan || null, message: 'Todavía no hay datos de ventas para este cliente.', viewOnly: true });
    }
    const report = webclients.computeReport(state);
    const client = store.getClient(clientId);
    res.json({ ok: true, hasData: true, report, modules: client && client.modules || [], plan: client && client.plan || null, viewOnly: true });
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