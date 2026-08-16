var UI = (function () {
  const app = document.getElementById('app');
  let draft = null;
  let pendingClientFor = null;
  const { money, toast, isNativeEnv, capacitorPlugin, confirmar, escapeAttr,
    CLIENT_ICON, ITEM_ICON, TOOLS_ICON, WALLET_ICON, FLAG_ICON, PAPER_ICON,
    SAVE_ICON, PDF_ICON, WA_ICON, PLUS_ICON, BACK_ICON, TRASH_ICON,
    PENCIL_ICON, CHECK_ICON, X_ICON, LOCK_ICON } = Util;
  const { compressImage, recompressExisting } = Media;
  const { exportBackup, importBackupFile, hashVal, doReset } = Backups;
  const { unlockApp, resetLock, showPasswordField, applyLockScreen, appPlugin, bioApi } = Lock;
  Backups.render = render;

  const TITLES = {
    dashboard: 'Inicio',
    clientes: 'Clientes',
    cliente: 'Cliente',
    catalogo: 'Catálogo',
    'catalogo-item': 'Catálogo',
    cotizacion: 'Cotización',
    trabajos: 'Trabajos',
    trabajo: 'Detalle',
    ajustes: 'Ajustes'
  };

  const NAV = [
    { v: 'dashboard', label: 'Inicio', icon: '&#8962;' },
    { v: 'clientes', label: 'Clientes', icon: '&#128100;' },
    { v: 'catalogo', label: 'Catálogo', icon: '&#128722;' },
    { v: 'trabajos', label: 'Trabajos', icon: '&#128203;' },
    { v: 'ajustes', label: 'Ajustes', icon: '&#9881;' }
  ];

  let routeName = 'dashboard';
  let params = {};
  let draftEntryMode = null;
  let biometricPromptActive = false;
  let licenseStatus = null;




  function parseHash() {
    const h = window.location.hash.replace(/^#\/?/, '');
    const parts = h.split('/').filter(Boolean);
    routeName = parts[0] || 'dashboard';
    params = {};
    if (parts[1] === 'editar' && parts[2]) {
      params.id = parts[2];
      params.mode = 'editar';
    } else {
      if (parts[1]) params.id = parts[1];
      if (parts[2]) {
        params.aux = parts[2];
        if (parts[1] === 'f') params.filter = parts[2];
      }
    }
    if (!TITLES[routeName]) routeName = 'dashboard';
  }

  function shell() {
    const isEditor = routeName === 'cotizacion';
    const showBack = routeName !== 'dashboard' && !isEditor && routeName !== 'clientes' && routeName !== 'catalogo' && routeName !== 'trabajos' && routeName !== 'ajustes';
    const title = TITLES[routeName];
    const biz = DB.state.settings.businessName || 'CotizaTec';

    let html = '<header class="topbar">';
    html += '<div class="bar-top">';
    if (showBack) {
      html += '<button class="icon-btn" data-action="back"><span>' + BACK_ICON + '</span></button>';
    } else {
      html += '<div class="brand"><span class="logo">' + TOOLS_ICON + '</span><span class="bname">' + escapeAttr(biz) + '</span></div>';
    }
    html += '<div class="bar-right">';
    if (isEditor) {
      const code = (draft && draft.code) ? draft.code : 'NUEVA';
      html += '<span class="bar-chip">' + escapeAttr(code) + '</span>';
    }
    html += '</div></div>';

    if (routeName === 'dashboard') {
      html += '<div class="bar-title">¡Hola, ' + escapeAttr(biz.split(' ')[0]) + '! 👋</div>';
      html += '<div class="bar-sub">Resumen de tu taller hoy</div>';
    } else if (!isEditor) {
      html += '<div class="bar-title">' + escapeAttr(title) + '</div>';
    } else {
      html += '<div class="bar-title">' + (draft && draft.code ? 'Editar cotización' : 'Nueva cotización') + '</div>';
    }
    html += '</header>';

    if (licenseStatus && licenseStatus.status === 'grace') {
      html += '<div class="grace-banner">⚠️ Modo offline: te quedan <b>' + licenseStatus.graceDaysLeft + '</b> día(s) de gracia. Conéctate a internet para renovar tu licencia.</div>';
    }

    if (!isEditor) {
      html += '<nav class="bottom-nav">';
      NAV.forEach(function (n) {
        const act = n.v === routeName || (routeName === 'cliente' && n.v === 'clientes') || (routeName === 'cotizacion' && n.v === 'trabajos') || (routeName === 'trabajo' && n.v === 'trabajos') ? ' active' : '';
        html += '<button class="nav-btn' + act + '" data-action="nav" data-to="' + n.v + '"><span class="ni">' + n.icon + '</span><span>' + n.label + '</span></button>';
      });
      html += '</nav>';
    }
    return html;
  }

  function mount(inner) {
    app.innerHTML = shell() + '<main class="content' + (routeName === 'cotizacion' ? ' editor' : '') + '">' + inner + '</main>';
    window.scrollTo(0, 0);
  }

  function typeBadge(type) {
    const t = DB.itemType(type);
    const cls = String(t.id === 'PRODUCTO' ? 'rep' : 'mo');
    return '<span class="badge ' + cls + '">' + escapeAttr(t.label) + '</span>';
  }

  function statusBadge(id) {
    return '<span class="badge" style="background:' + DB.statusColor(id) + '">' + DB.statusLabel(id) + '</span>';
  }

  function statusPill(id) {
    const map = { COTIZADO: 'cotizado', APROBADO: 'aprobado', EN_PROCESO: 'proceso', COMPLETADO: 'completado', COBRADO: 'cobrado', CANCELADO: 'cancelado' };
    const key = map[id] || String(id).toLowerCase();
    return '<span class="pill p-' + key + '">' + DB.statusLabel(id) + '</span>';
  }

  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return (p[0] ? p[0].charAt(0) : '') + (p[1] ? p[1].charAt(0) : '');
  }

  function avatarClass(i) {
    return 'av-' + ((i % 5) + 1);
  }

  function emptyBox(icon, txt, btn) {
    let h = '<div class="empty"><div class="empty-icon">' + icon + '</div><p>' + txt + '</p>';
    if (btn) h += '<button class="btn" data-action="' + btn.action + '"' + (btn.data ? btn.data : '') + '>' + (btn.icon || PLUS_ICON) + ' ' + btn.label + '</button>';
    return h + '</div>';
  }

  function dashboard() {
    const s = DB.state;
    const jobs = s.jobs;
    const pending = jobs.filter(function (j) { return j.status === 'COTIZADO'; });
    const pendingTotal = pending.reduce(function (a, j) { return a + DB.jobTotals(j).total; }, 0);
    const totCotizado = jobs.filter(function (j) { return j.status !== 'COBRADO' && j.status !== 'CANCELADO'; }).reduce(function (a, j) { return a + DB.jobTotals(j).total; }, 0);
    const cobrado = jobs.reduce(function (a, j) { return a + DB.jobTotals(j).collected; }, 0);
    const porCobrar = jobs.reduce(function (a, j) { return a + DB.jobTotals(j).balance; }, 0);
    const ganancia = jobs.reduce(function (a, j) { return a + DB.jobTotals(j).margin; }, 0);

    const hh = new Date().getHours();
    const saludo = hh < 12 ? 'Buenos días' : (hh < 18 ? 'Buenas tardes' : 'Buenas noches');
    const biz = DB.state.settings.businessName || 'Mi Negocio';
    const hoy = DB.date(new Date().toISOString());

    let html = '<div class="hero-card"><div class="hero-ic">' + WALLET_ICON + '</div><div class="hero-txt"><small>' + saludo + ' · ' + hoy + '</small><b>' + escapeAttr(biz) + '</b><span>Por cobrar <b>' + money(porCobrar) + '</b></span></div></div>';
    html += '<div class="grid2">';
    html += statCard(FLAG_ICON, 'Pendientes', pending.length + ' cot.', 'por ' + money(pendingTotal), '#f59e0b');
    html += statCard(PAPER_ICON, 'Cotizado', money(totCotizado), 'total estimado', '#3b82f6');
    html += statCard(WALLET_ICON, 'Cobrado', money(cobrado), 'en caja', '#10b981');
    html += statCard('&#128176;', 'Por cobrar', money(porCobrar), 'saldo pendiente', '#ef4444');
    html += '<div class="span2">' + statCard(TOOLS_ICON, 'Ganancia real', money(ganancia), 'cobrado − materiales', '#8b5cf6') + '</div>';
    html += '</div>';

    if (pending.length) {
      html += '<section class="card alert-card"><h3>' + CHECK_ICON + ' Cotizaciones por aprobar</h3>';
      pending.slice(0, 5).forEach(function (j) {
        html += '<a class="row-line" data-action="navTrabajo" data-id="' + j.id + '"><span><b>' + escapeAttr(j.clientName || 'Cliente') + '</b></span><b>' + money(DB.jobTotals(j).total) + '</b></a>';
      });
      if (pending.length > 5) html += '<small class="muted">+' + (pending.length - 5) + ' más en Trabajos</small>';
      html += '</section>';
    }

    html += '<div class="sec"><h3>' + PAPER_ICON + ' Últimos trabajos</h3></div>';
    if (!jobs.length) {
      html += emptyBox(PAPER_ICON, 'Aún no tienes cotizaciones', { action: 'newQuote', label: 'Crear cotización', icon: PLUS_ICON });
    } else {
      jobs.slice(0, 5).forEach(function (j) {
        const t = DB.jobTotals(j);
        html += '<div class="job" data-action="navTrabajo" data-id="' + j.id + '">';
        html += '<div class="job-head"><b>' + escapeAttr(j.code || 'Cotización') + '</b>' + statusPill(j.status) + '</div>';
        html += '<small>' + escapeAttr(j.clientName || 'Sin cliente') + ' · ' + DB.date(j.date) + '</small>';
        html += '<div class="job-money"><div class="m">Total <b>' + money(t.total) + '</b></div><div class="m pend">Saldo <b>' + money(t.balance) + '</b></div></div>';
        html += '</div>';
      });
    }

    html += '<button class="fab" data-action="newQuote"><span>' + PLUS_ICON + '</span></button>';
    return html;
  }

  function statCard(icon, label, val, sub, color) {
    return '<div class="stat" style="--c:' + color + '"><div class="stat-ic">' + icon + '</div><div class="stat-l">' + label + '</div><div class="stat-v">' + val + '</div><div class="stat-s">' + sub + '</div></div>';
  }

  function clients() {
    const s = DB.state;
    let html = '';
    if (!s.clients.length) {
      html += emptyBox(CLIENT_ICON, 'Agrega tus clientes para cotizar más rápido', { action: 'newClient', label: 'Nuevo cliente' });
    } else {
      html += '<div class="h-search">&#128269;&nbsp;<input data-search="clients" placeholder="Buscar cliente…"></div>';
      html += '<p class="muted">' + s.clients.length + ' cliente(s)</p>';
      s.clients.forEach(function (c, i) {
        const count = s.jobs.filter(function (j) { return String(j.clientId) === String(c.id); }).length;
        html += '<div class="list-row" data-search-item="clients" data-action="openClient" data-id="' + c.id + '"><div class="avatar ' + avatarClass(i) + '">' + initials(c.name) + '</div>';
        html += '<div class="inf"><b>' + escapeAttr(c.name) + '</b>';
        html += '<span>' + (c.phone ? escapeAttr(c.phone) : 'sin teléfono') + ' · ' + count + ' trabajo(s)' + (c.address ? ' · ' + escapeAttr(c.address) : '') + '</span></div>';
        html += '<div class="person-actions"><button class="icon-btn" data-action="editClient" data-id="' + c.id + '">' + PENCIL_ICON + '</button><button class="icon-btn danger" data-action="deleteClient" data-id="' + c.id + '">' + TRASH_ICON + '</button></div>';
        html += '<div class="chev">&#10148;</div>';
        html += '</div>';
      });
    }
    html += '<button class="btn block" data-action="newClient">' + PLUS_ICON + ' Nuevo cliente</button>';
    return html;
  }

  function clientForm() {
    const id = params.id;
    const c = id ? DB.find('clients', id) : null;
    const backToQuote = pendingClientFor === 'quote';

let html = '<form class="card form" data-form="cliente">';
    html += '<label>Nombre *</label><input type="text" name="name" value="' + escapeAttr(c ? c.name : '') + '" placeholder="Ej. Juan Pérez">';
    html += '<label>Teléfono (WhatsApp)</label><input type="tel" name="phone" value="' + escapeAttr(c ? c.phone : '') + '" placeholder="809-000-0000">';
    html += '<label>Dirección</label><input type="text" name="address" value="' + escapeAttr(c ? c.address : '') + '" placeholder="Calle, sector, ciudad">';
    html += '<button class="btn primary block" type="submit">' + SAVE_ICON + ' Guardar cliente</button>';
    if (!backToQuote) html += '<button class="btn block ghost" type="button" data-action="back">Cancelar</button>';
    html += '</form>';
    return html;
  }

  function clientPerfil(id) {
    const c = DB.find('clients', id);
    if (!c) { mount(emptyBox(CLIENT_ICON, 'Cliente no encontrado', { action: 'nav', label: 'Volver', icon: BACK_ICON })); return ''; }
    const jobs = DB.state.jobs.filter(function (j) { return String(j.clientId) === String(c.id) && j.status !== 'CANCELADO'; });
    let total = 0, collected = 0, balance = 0;
    jobs.forEach(function (j) { const t = DB.jobTotals(j); total += t.total; collected += t.collected; balance += t.balance; });
    const pendCount = jobs.filter(function (j) { return DB.jobTotals(j).balance > 0.005; }).length;
    const saldado = jobs.length > 0 && balance <= 0.005;

    let html = '';
    html += '<div class="pcard"><div class="avatar big av-2">' + initials(c.name) + '</div>';
    html += '<div class="pinfo"><b>' + escapeAttr(c.name) + '</b>';
    html += '<span>' + (c.phone ? escapeAttr(c.phone) : 'sin teléfono') + (c.address ? ' · ' + escapeAttr(c.address) : '') + '</span>';
    html += '<div class="btns-row">';
    html += '<button class="btn small" data-action="editClient" data-id="' + c.id + '">' + PENCIL_ICON + ' Editar</button>';
    html += '<button class="btn small danger-ghost" data-action="deleteClient" data-id="' + c.id + '">' + TRASH_ICON + ' Eliminar</button>';
    html += '</div></div></div>';

    html += '<div class="grid2">';
    html += statCard(WALLET_ICON, 'Por cobrar', money(balance), saldado ? 'al día ✓' : (pendCount + ' con saldo'), saldado ? '#10b981' : '#f59e0b');
    html += statCard(CHECK_ICON, 'Abonado', money(collected), 'de ' + money(total), '#10b981');
    html += '<div class="span2">' + statCard(PAPER_ICON, 'Trabajos', jobs.length + ' cotizaciones', 'total cotizado ' + money(total), '#3b82f6') + '</div>';
    html += '</div>';

    html += '<div class="btns-row">';
    html += '<button class="btn primary block" data-action="quoteForClient" data-id="' + c.id + '">' + PLUS_ICON + ' Nueva cotización</button>';
    html += '<button class="btn block" data-action="clientAddAbono" data-id="' + c.id + '">' + WALLET_ICON + ' Registrar abono</button>';
    html += '</div>';

    if (jobs.length) {
      html += '<div class="card"><h3>' + PAPER_ICON + ' Sus trabajos</h3>';
      jobs.forEach(function (j) {
        const t = DB.jobTotals(j);
        html += '<div class="list-row" data-action="navTrabajo" data-id="' + j.id + '"><div class="inf"><b>' + escapeAttr(j.code || 'Cotización') + '</b>';
        html += '<span>' + DB.date(j.date) + ' · ' + DB.statusLabel(j.status) + '</span></div>';
        html += '<b class="' + (t.balance > 0.005 ? 'pend' : 'paidv') + '">' + money(t.balance) + '</b><div class="chev">&#10148;</div></div>';
      });
      html += '</div>';
    } else {
      html += emptyBox(PAPER_ICON, 'Este cliente aún no tiene cotizaciones', { action: 'quoteForClient', label: 'Crear cotización', data: ' data-id="' + c.id + '"' });
    }
    return html;
  }

  function pendingJobsSheet(jobs) {
    let html = '<div class="sheet"><div class="sheet-head"><b>Elige el trabajo</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div><div class="sheet-body">';
    jobs.forEach(function (j) {
      html += '<button class="sheet-item" data-action="pickPendingJob" data-id="' + j.id + '"><span>' + escapeAttr(j.code || 'Cotización') + '<small>' + escapeAttr(j.clientName || '') + '</small></span><b>' + money(DB.jobTotals(j).balance) + '</b></button>';
    });
    html += '</div></div>';
    return html;
  }

  function abonoSheetHtml(j) {
    const bal = DB.jobTotals(j).balance;
    let html = '<div class="sheet"><div class="sheet-head"><b>Abono · ' + escapeAttr(j.code || 'Cotización') + '</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div><div class="sheet-body">';
    html += '<p class="muted">Saldo pendiente: <b>' + money(bal) + '</b></p>';
    html += '<input id="abono-amount" class="sheet-input" type="number" step="0.01" min="0.01" placeholder="Monto del abono (RD$)" inputmode="decimal">';
    html += '<input id="abono-note" class="sheet-input" type="text" placeholder="Nota (ej. Anticipo 50%)">';
    html += '<button class="btn primary block" data-action="abonoSave" data-id="' + j.id + '">' + CHECK_ICON + ' Guardar abono</button>';
    html += '</div></div>';
    return html;
  }

  function openSheet(html) {
    const s = document.createElement('div');
    s.id = 'sheet-holder';
    s.innerHTML = html;
    document.body.appendChild(s);
  }

  function resetPassSheet() {
    let html = '<div class="sheet"><div class="sheet-head"><b>' + LOCK_ICON + ' Reiniciar la app</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div><div class="sheet-body">';
    html += '<p class="muted">Para borrar todos los datos escribe tu contraseña de seguridad.</p>';
    html += '<input id="reset-pass-verify" class="sheet-input" type="password" placeholder="Contraseña">';
    html += '<button class="btn primary block" data-action="confirmResetData">' + TRASH_ICON + ' Borrar todo</button>';
    html += '</div></div>';
    return html;
  }

  function catalog() {
    const s = DB.state;
    const filter = params.filter || 'ALL';
    const types = s.settings.itemTypes || [];
    let html = '<div class="chips">';
    html += '<button class="chip' + (filter === 'ALL' ? ' on' : '') + '" data-action="catalogFilter" data-f="ALL">Todo</button>';
    types.forEach(function (t) {
      html += '<button class="chip' + (filter === t.id ? ' on' : '') + '" data-action="catalogFilter" data-f="' + t.id + '">' + escapeAttr(t.label) + '</button>';
    });
    html += '</div>';

    const items = s.catalog.filter(function (i) { return filter === 'ALL' || i.type === filter; }).sort(function (a, b) { return a.name.localeCompare(b.name); });

    if (!items.length) {
      html += emptyBox(ITEM_ICON, 'Tu catálogo estará aquí. Añade tus servicios y productos', { action: 'newCatalogItem', label: 'Nuevo ítem' });
    } else {
      html += '<div class="h-search">&#128269;&nbsp;<input data-search="catalog" placeholder="Buscar ítem…"></div>';
      items.forEach(function (i) {
        const it = DB.itemType(i.type);
        const isProduct = it.id === 'PRODUCTO';
        html += '<div class="card item" data-search-item="catalog"><div class="item-ty ' + (isProduct ? 'rep' : 'mo') + '">' + (isProduct ? ITEM_ICON : TOOLS_ICON) + '</div>';
        html += '<div class="item-info">' + typeBadge(i.type) + '<b>' + escapeAttr(i.name) + '</b><span class="pr">' + money(i.price) + '</span>';
        if (Number(i.packQty) > 0) {
          const pk = Number(i.packPrice) > 0 ? i.packPrice : (Number(i.price) * Number(i.packQty));
          html += '<small class="pack-hint">Caja × ' + i.packQty + (i.unit ? ' ' + escapeAttr(i.unit) : '') + ' · ' + money(pk) + '</small>';
        }
        html += '</div>';
        html += '<div class="person-actions"><button class="icon-btn" data-action="editCatalog" data-id="' + i.id + '">' + PENCIL_ICON + '</button><button class="icon-btn danger" data-action="removeCatalog" data-id="' + i.id + '">' + TRASH_ICON + '</button></div></div>';
      });
    }
    html += '<button class="btn block" data-action="newCatalogItem">' + PLUS_ICON + ' Nuevo ítem</button>';
    return html;
  }

  function catalogFormView() {
    const id = params.id;
    const i = id ? DB.find('catalog', id) : null;
    let html = '<form class="card form" data-form="catalog"><label>Nombre *</label><input type="text" name="name" value="' + escapeAttr(i ? i.name : '') + '" placeholder="Ej. Cambio de compresor">';
    html += '<label>Tipo</label><select name="type">' + (DB.state.settings.itemTypes || []).map(function (t) {
      return '<option value="' + t.id + '"' + (i && i.type === t.id ? ' selected' : '') + '>' + escapeAttr(t.label) + '</option>';
    }).join('') + '</select>';
    html += '<label>Precio (RD$) *</label><input type="number" step="0.01" min="0" name="price" value="' + (i ? i.price : '') + '" placeholder="0.00">';
    html += '<details class="pack-fields"><summary>' + PLUS_ICON + ' Se vende por caja (opcional)</summary>';
    html += '<label>Unidad de medida</label><input type="text" name="unit" value="' + escapeAttr(i ? i.unit || '' : '') + '" placeholder="Ej. pieza, metro, libra">';
    html += '<label>Unidades por caja</label><input type="number" step="1" min="0" name="packQty" value="' + (i && i.packQty ? i.packQty : '') + '" placeholder="Ej. 12">';
    html += '<label>Precio de la caja (RD$)</label><input type="number" step="0.01" min="0" name="packPrice" value="' + (i && i.packPrice ? i.packPrice : '') + '" placeholder="Si lo dejas vacío = unidad × caja">';
    html += '</details>';
    html += '<button class="btn primary block" type="submit">' + SAVE_ICON + ' Guardar</button>';
    html += '<button class="btn block ghost" type="button" data-action="back">Cancelar</button>';
    html += '</form>';
    return html;
  }

  function ensureDraft() {
    if (draft) return draft;
    if (params.id && String(params.id).charAt(0) === 'j') {
      const existing = DB.find('jobs', params.id);
      if (existing) {
        draft = JSON.parse(JSON.stringify(existing));
        draftEntryMode = 'edit';
        return draft;
      }
    }
    const cid = params.id ? String(params.id) : null;
    const client = cid ? DB.find('clients', cid) : null;
    draft = DB.newJob(client);
    draftEntryMode = 'new';
    return draft;
  }

  function quoteEditor() {
    const j = ensureDraft();

    let html = '<div class="quote-editor">';

    html += '<section class="qclient">';
    html += '<label>Cliente *</label><select id="qc-client">';
    html += '<option value="">— Seleccionar cliente —</option>';
    DB.state.clients.forEach(function (cl) {
      html += '<option value="' + cl.id + '"' + (String(cl.id) === String(j.clientId) ? ' selected' : '') + '>' + escapeAttr(cl.name) + (cl.phone ? ' · ' + escapeAttr(cl.phone) : '') + '</option>';
    });
    html += '</select>';
    html += '<button class="btn" data-action="addClientFromQuote">' + PLUS_ICON + ' Nuevo cliente</button>';
    html += '</section>';

    html += '<section class="card form">';
    html += '<h3>' + ITEM_ICON + ' Conceptos (' + (j.items ? j.items.length : 0) + ')</h3>';
    html += '<div id="item-list">' + itemsListHtml(j) + '</div>';
    html += '<div class="row btns-row">';
    html += '<button class="btn small" data-action="openCatalogPicker">' + ITEM_ICON + ' Catálogo</button>';
    html += '<button class="btn small ghost" data-action="addManualLine">' + PLUS_ICON + ' Línea manual</button>';
    html += '</div>';
    html += '</section>';

    html += '<section class="card form">';
    html += '<label>Descuento (RD$)</label><input type="number" step="0.01" min="0" id="qc-disc" value="' + (j.discount || 0) + '">';
    html += '<label>ITBIS %</label><input type="number" step="1" min="0" id="qc-itbis" value="' + (j.itbis || 0) + '">';
    html += '<label>Notas</label><textarea id="qc-notes" rows="2" placeholder="Garantía, forma de pago, tiempo de entrega...">' + escapeAttr(j.notes || '') + '</textarea>';
    html += '</section>';

    html += '<div id="totals-panel">' + totalsHtml(j) + '</div>';

    html += '<div class="editor-bar">';
    html += '<button class="btn ghost" data-action="back">Cancelar</button>';
    html += '<button class="btn primary" data-action="quoteSave">' + SAVE_ICON + ' Guardar cotización</button>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function itemsListHtml(j) {
    const items = j.items || [];
    if (!items.length) return '<p class="muted">Sin conceptos todavía. Agrega desde el catálogo o crea una línea manual.</p>';
    let h = '';
    items.forEach(function (it, idx) {
      h += '<div class="q-item"><input class="qi-qty" type="number" min="0" step="1" data-qf="qty" data-qi="' + idx + '" value="' + (it.qty || 1) + '">';
      h += '<input class="qi-desc" type="text" data-qf="desc" data-qi="' + idx + '" placeholder="Descripción" value="' + escapeAttr(it.desc || '') + '">';
      h += '<input class="qi-price" type="number" min="0" step="0.01" data-qf="price" data-qi="' + idx + '" value="' + (it.price || '') + '">';
      h += '<span class="qi-sub" id="qi-sub-' + idx + '">' + money((it.qty || 0) * (it.price || 0)) + '</span>';
      h += '<button class="icon-btn danger qi-del" data-action="removeQuoteItem" data-id="' + idx + '">' + X_ICON + '</button>';
      h += '</div>';
    });
    return h;
  }

  function totalsHtml(j) {
    const t = DB.jobTotals(j);
    return '<section class="card totals"><div class="t-row"><span>Subtotal</span><b>' + money(t.subtotal) + '</b></div>'
      + (t.discount > 0 ? '<div class="t-row"><span>Descuento</span><b style="color:#ef4444">-' + money(t.discount) + '</b></div>' : '')
      + '<div class="t-row"><span>ITBIS (' + (j.itbis || 0) + '%)</span><b>' + money(t.tax) + '</b></div>'
      + '<div class="t-row total"><span>Total</span><b class="big">' + money(t.total) + '</b></div></section>';
  }

  function jobsView() {
    const filter = params.filter || 'ALL';
    const s = DB.state;
    let html = '<div class="chips">';
    [['ALL', 'Todos']].concat(DB.STATUS.map(function (x) { return [x.id, x.label]; })).forEach(function (f) {
      html += '<button class="chip' + (filter === f[0] ? ' on' : '') + '" data-action="jobsFilter" data-f="' + f[0] + '">' + f[1] + '</button>';
    });
    html += '</div>';

    let jobs = s.jobs.slice();
    if (filter !== 'ALL') jobs = jobs.filter(function (j) { return j.status === filter; });
    jobs.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

    if (!jobs.length) {
      html += emptyBox(PAPER_ICON, 'No hay trabajos en esta vista', { action: 'newQuote', label: 'Crear cotización' });
    } else {
      jobs.forEach(function (j) {
        const t = DB.jobTotals(j);
        html += '<div class="job" data-action="navTrabajo" data-id="' + j.id + '">';
        html += '<div class="job-head"><b>' + escapeAttr(j.code || 'Cotización') + '</b>' + statusPill(j.status) + '</div>';
        html += '<small>' + escapeAttr(j.clientName || 'Sin cliente') + ' · ' + DB.date(j.date) + '</small>';
        html += '<div class="job-money"><div class="m">Total <b>' + money(t.total) + '</b></div><div class="m pend">Saldo <b>' + money(t.balance) + '</b></div></div>';
        html += '</div>';
      });
    }
    html += '<button class="fab" data-action="newQuote"><span>' + PLUS_ICON + '</span></button>';
    return html;
  }

  function jobDetail() {
    const j = DB.find('jobs', params.id);
    if (!j) { mount(emptyBox(PAPER_ICON, 'Trabajo no encontrado', { action: 'nav', label: 'Volver', icon: BACK_ICON })); return; }
    const t = DB.jobTotals(j);

    let html = '';

    html += stepperHtml(j.status);

    const paid = t.balance <= 0.005;
    html += '<div class="moneyc">';
    html += '<div class="mc-row"><span>Total cotización</span><b>' + money(t.total) + '</b></div>';
    html += '<div class="mc-row"><span>Cobrado</span><b>' + money(t.collected) + '</b></div>';
    html += '<div class="mc-row' + (paid ? ' mc-paid' : '') + '"><span>Saldo por cobrar</span><b>' + money(t.balance) + (paid ? ' · ' + CHECK_ICON + ' Saldado' : '') + '</b></div>';
    html += '</div>';

    html += '<div class="do">';
    html += '<button class="btn w" data-action="pdfShare" data-id="' + j.id + '">' + PDF_ICON + ' PDF</button>';
    html += '<button class="btn p" data-action="whatsapp" data-id="' + j.id + '">' + WA_ICON + ' WhatsApp</button>';
    html += '</div>';

    html += '<section class="card"><h3>' + ITEM_ICON + ' Conceptos</h3>';
    if (j.items && j.items.length) {
      j.items.forEach(function (it) {
        html += '<div class="row-line"><span>' + escapeAttr(it.desc || '') + '<small>' + (it.qty || 0) + ' × ' + money(it.price) + '</small></span><b>' + money((it.qty || 0) * (it.price || 0)) + '</b></div>';
      });
    } else html += '<p class="muted">Sin conceptos.</p>';
    if (j.notes) html += '<p class="notes">' + escapeAttr(j.notes) + '</p>';
    html += '</section>';

    html += signaturesCard(j);

    html += '<section class="card"><h3>' + TOOLS_ICON + ' Estado del trabajo</h3>';
    html += '<div class="btns-row">';
    DB.STATUS.forEach(function (s) {
      html += '<button class="chip' + (j.status === s.id ? ' on' : '') + '" data-action="setStatus" data-id="' + j.id + '" data-status="' + s.id + '">' + s.label + '</button>';
    });
    html += '</div>';
    html += '<div class="btns-row">';
    html += '<button class="btn small" data-action="pdfDownload" data-id="' + j.id + '">' + PDF_ICON + ' Descargar</button>';
    html += '<button class="btn small" data-action="editQuote" data-id="' + j.id + '">' + PENCIL_ICON + ' Editar</button>';
    html += '<button class="btn small" data-action="duplicateJob" data-id="' + j.id + '">' + ITEM_ICON + ' Duplicar</button>';
    html += '</div></section>';

    html += expensesCard(j);
    html += paymentsCard(j);

    html += '<button class="btn block danger-ghost" data-action="deleteJob" data-id="' + j.id + '">' + TRASH_ICON + ' Eliminar trabajo</button>';
    return html;
  }

  function stepperHtml(status) {
    const order = DB.STATUS.map(function (x) { return x.id; });
    const idx = order.indexOf(status);
    let html = '<div class="stepper">';
    DB.STATUS.forEach(function (s, i) {
      let cls = 'step';
      if (idx >= 0 && i < idx) cls += ' done';
      if (idx >= 0 && i === idx) cls += ' cur';
      const tick = (i < idx) ? CHECK_ICON : (i + 1);
      html += '<div class="' + cls + '"><div class="dot">' + tick + '</div><div class="lb">' + s.label + '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function expensesCard(j) {
    let html = '<section class="card"><h3>' + TOOLS_ICON + ' Gastos / Materiales comprados</h3>';
    if (j.expenses && j.expenses.length) {
      j.expenses.forEach(function (e) {
        html += '<div class="row-line"><span>' + escapeAttr(e.name) + '<small>' + DB.date(e.date) + '</small></span><b>' + money(e.amount) + '</b><button class="icon-btn danger" data-action="removeExpense" data-id="' + j.id + '" data-ex="' + e.id + '">' + X_ICON + '</button></div>';
      });
      html += '<div class="t-row"><span>Costo total materiales</span><b>' + money(DB.jobTotals(j).cost) + '</b></div>';
    } else {
      html += '<p class="muted">Registra qué compraste para este trabajo y calcularemos tu ganancia real.</p>';
    }
    html += '<form data-form="expense" data-job="' + j.id + '"><div class="inline-form"><input name="label" placeholder="Ej. Compresor 1.5HP" required><input name="amount" type="number" step="0.01" min="0" placeholder="0.00" required><button class="btn small primary">' + PLUS_ICON + '</button></div></form>';
    html += '</section>';
    return html;
  }

  function paymentsCard(j) {
    const t = DB.jobTotals(j);
    let html = '<section class="card"><h3>' + WALLET_ICON + ' Abonos / Pagos</h3>';
    if (j.payments && j.payments.length) {
      j.payments.forEach(function (p) {
        html += '<div class="row-line"><span>' + escapeAttr(p.note || 'Abono') + '<small>' + DB.date(p.date) + '</small></span><b>' + money(p.amount) + '</b><button class="icon-btn danger" data-action="removePayment" data-id="' + j.id + '" data-pay="' + p.id + '">' + X_ICON + '</button></div>';
      });
    } else html += '<p class="muted">' + (t.balance <= 0.005 ? CHECK_ICON + ' Saldado' : 'Registra anticipos o abonos. Cobrado: ' + money(t.collected) + ' · Por cobrar: ' + money(t.balance)) + '</p>';
    html += '<form data-form="payment" data-job="' + j.id + '"><div class="inline-form"><input name="note" placeholder="Ej. Anticipo 50%"><input name="amount" type="number" step="0.01" min="0" placeholder="0.00" required><button class="btn small primary">' + PLUS_ICON + '</button></div></form>';
    html += '</section>';
    return html;
  }

let signCtx = null;

  function signaturesCard(j) {
    const s = DB.state.settings;
    let html = '<section class="card"><h3>' + PENCIL_ICON + ' Firmas</h3>';

    html += '<div class="sig-block"><b class="sig-lbl">Firma del técnico</b>';
    if (s.signature) {
      html += '<img class="sign-preview" src="' + s.signature + '" alt="Firma del técnico">';
      html += '<div class="btns-row"><button class="btn small" data-action="signTech">Firmar</button><button class="btn small danger-ghost" data-action="removeTechSignature">' + TRASH_ICON + ' Quitar</button></div>';
    } else {
      html += '<p class="muted">Tu firma como técnico. Se imprimirá en el PDF.</p>';
      html += '<button class="btn block" data-action="signTech">' + PENCIL_ICON + ' Firmar técnico</button>';
    }
    html += '</div>';

    html += '<div class="sig-block"><b class="sig-lbl">Firma del cliente</b>';
    if (j.signature) {
      html += '<img class="sign-preview" src="' + j.signature + '" alt="Firma del cliente">';
      html += '<div class="btns-row"><button class="btn small" data-action="signJob" data-id="' + j.id + '">Firmar</button><button class="btn small danger-ghost" data-action="removeJobSignature" data-id="' + j.id + '">' + TRASH_ICON + ' Quitar</button></div>';
    } else {
      html += '<p class="muted">Opcional: cuando el cliente acepte la cotización.</p>';
      html += '<button class="btn block" data-action="signJob" data-id="' + j.id + '">' + PENCIL_ICON + ' Firmar cliente</button>';
    }
    html += '</div>';

    html += '</section>';
    return html;
  }

  function signatureSheetHtml(target, jobId) {
    const title = target === 'tech' ? 'Firma del técnico' : 'Firma del cliente';
    let html = '<div class="sheet"><div class="sheet-head"><b>' + title + '</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div>';
    html += '<div class="sheet-body">';
    html += '<p class="muted">Traza tu firma con el dedo dentro del recuadro y pulsa "Guardar".</p>';
    html += '<div class="sign-box"><canvas id="sign-canvas"></canvas></div>';
    html += '<div class="btns-row"><button class="btn" data-action="signClear">' + TRASH_ICON + ' Limpiar</button>';
    html += '<button class="btn primary" data-action="signSave" data-target="' + target + '" data-id="' + (jobId || '') + '">' + CHECK_ICON + ' Guardar firma</button></div>';
    html += '</div></div>';
    return html;
  }

  function openSignSheet(target, jobId) {
    const s = document.createElement('div');
    s.id = 'sheet-holder';
    s.innerHTML = signatureSheetHtml(target, jobId);
    document.body.appendChild(s);
    setupSignCanvas();
  }

  function setupSignCanvas() {
    const cv = document.getElementById('sign-canvas');
    if (!cv) return;
    const W = 800, H = 280;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    signCtx = ctx;

    function pos(ev) {
      const r = cv.getBoundingClientRect();
      return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
    }
    let drawing = false;
    cv.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      drawing = true;
      const p = pos(ev);
      signCtx.beginPath();
      signCtx.moveTo(p.x, p.y);
      if (cv.setPointerCapture) { try { cv.setPointerCapture(ev.pointerId); } catch (e) {} }
    });
    cv.addEventListener('pointermove', function (ev) {
      if (!drawing) return;
      ev.preventDefault();
      const p = pos(ev);
      signCtx.lineTo(p.x, p.y);
      signCtx.stroke();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (evName) {
      cv.addEventListener(evName, function () { drawing = false; });
    });
  }

  function clearSignCanvas() {
    if (!signCtx) return;
    const cv = signCtx.canvas;
    signCtx.save();
    signCtx.setTransform(1, 0, 0, 1, 0, 0);
    signCtx.fillStyle = '#fff';
    signCtx.fillRect(0, 0, cv.width, cv.height);
    signCtx.restore();
  }

  function saveSign(target, jobId) {
    const cv = document.getElementById('sign-canvas');
    if (!cv) return;
    const data = cv.toDataURL('image/png');
    compressImage(data, 360, function (compressed) {
      if (target === 'tech') {
        DB.state.settings.signature = compressed;
      } else {
        const j = DB.find('jobs', jobId);
        if (!j) { toast('No se encontró el trabajo', false); return; }
        j.signature = compressed;
      }
      DB.save();
      const close = document.getElementById('sheet-holder');
      if (close) close.remove();
      render();
      toast('Firma guardada', true);
    });
  }

function settingsView() {
    const s = DB.state.settings;
    let html = '<form data-form="settings">';
    html += '<section class="card form">';
    html += '<h3>' + TOOLS_ICON + ' Tu negocio</h3>';
    html += '<label>Nombre del negocio / técnico</label><input type="text" name="businessName" value="' + escapeAttr(s.businessName) + '">';
    html += '<label>Teléfono</label><input type="tel" name="phone" value="' + escapeAttr(s.phone) + '">';
    html += '<label>Dirección</label><input type="text" name="address" value="' + escapeAttr(s.address) + '">';
    html += '<label>Logo</label>';
    html += '<input type="file" accept="image/png,image/jpeg" data-upload="logo">';
    if (s.logo) html += '<button class="btn small ghost" type="button" data-action="removeLogo">Quitar logo</button>';
    html += '</section>';

    html += '<section class="card form">';
    html += '<h3>' + PENCIL_ICON + ' Tu firma</h3>';
    html += '<p class="muted">Dibújala una vez con el dedo; aparecerá en el PDF bajo "Firma del técnico".</p>';
    if (s.signature) {
      html += '<img class="sign-preview" src="' + s.signature + '" alt="Firma">';
      html += '<div class="btns-row"><button class="btn" type="button" data-action="signTech">Firmar otra vez</button><button class="btn small danger-ghost" type="button" data-action="removeTechSignature">Quitar</button></div>';
    } else {
      html += '<button class="btn primary block" type="button" data-action="signTech">' + PENCIL_ICON + ' Firmar ahora</button>';
    }
    html += '</section>';

    html += '<section class="card form">';
    html += '<h3>' + PDF_ICON + ' Cotización</h3>';
    html += '<label>ITBIS / IVA (%)</label><input type="number" step="1" min="0" name="itbis" value="' + (s.itbis || 0) + '">';
    html += '<label>Válida por (días)</label><input type="number" step="1" min="1" name="validityDays" value="' + (s.validityDays || 15) + '">';
    html += '<label>Prefijo de cotización</label><input type="text" name="quotePrefix" value="' + escapeAttr(s.quotePrefix || 'COT') + '">';
    html += '<label>Título del documento</label><input type="text" name="docTitle" value="' + escapeAttr(s.docTitle || 'COTIZACIÓN') + '" placeholder="COTIZACIÓN / PEDIDO / FACTURA">';
    html += '<label class="switch-line"><span>Pie de página "Creado con ..."</span><input type="checkbox" name="watermarkEnabled"' + (s.watermarkEnabled ? ' checked' : '') + '></label>';
    html += '<label>Texto del pie</label><input type="text" name="watermark" value="' + escapeAttr(s.watermark || '') + '">';
    html += '</section>';

    html += '<section class="card form">';
    html += '<h3>' + LOCK_ICON + ' Bloqueo de la app</h3>';
    html += '<label class="switch-line"><span>Pedir huella o contraseña al abrir la app</span><input type="checkbox" name="lockOnStart"' + (s.lockOnStart ? ' checked' : '') + '></label>';
    html += '<label class="switch-line"><span>Volver a bloquear al cambiar de app</span><input type="checkbox" name="relockOnResume"' + (s.relockOnResume ? ' checked' : '') + '></label>';
    html += '<div class="btns-row">';
    if (DB.isProtected()) {
      html += '<button class="btn small primary" type="button" data-action="disableProtection">' + LOCK_ICON + ' Desactivar protección</button>';
      if (!DB.hasFingerprint()) {
        html += '<button class="btn small primary" type="button" data-action="enableProtection">' + LOCK_ICON + ' Activar huella</button>';
      }
      if (DB.hasBackupPassword()) html += '<button class="btn small danger-ghost" type="button" data-action="removeBackupPassword">' + X_ICON + ' Quitar contraseña de respaldo</button>';
    } else {
      html += '<button class="btn small primary" type="button" data-action="enableProtection">' + LOCK_ICON + ' Activar protección con huella</button>';
    }
    html += '</div>';
    if (DB.hasFingerprint() && !DB.hasBackupPassword()) {
      html += '<label for="backup-pwd-set">Contraseña de respaldo (por si la huella falla)</label>';
      html += '<div class="btns-row"><input type="password" id="backup-pwd-set" class="sheet-input" placeholder="Mínimo 4 caracteres" style="flex:1">';
      html += '<button class="btn small primary" type="button" data-action="saveBackupPassword">' + CHECK_ICON + ' Guardar</button></div>';
    }
    html += '<p class="muted">' + (DB.isProtected()
      ? (LOCK_ICON + ' Protegido: los datos se cifran con AES-256' + (DB.hasFingerprint()
          ? '. Se desbloquea con huella' + (DB.hasBackupPassword() ? ' o contraseña de respaldo' : '') + '.'
          : '. Por ahora solo se desbloquea con la contraseña. Activa la protección con huella en la zona de riesgo para usarla.') )
      : 'Sin protección: los datos se guardan sin cifrar en el dispositivo. Al activar la protección se pedirá tu huella (y una contraseña de respaldo si quieres).') + '</p>';
    html += '<button class="btn primary block" type="submit">' + SAVE_ICON + ' Guardar ajustes</button>';
    html += '</section>';
    html += '</form>';

    html += '<section class="card danger-zone"><h3>' + TRASH_ICON + ' Zona de riesgo</h3>';
    html += '<p class="muted">Esto borra todos tus datos locales (clientes, catálogo, cotizaciones).</p>';
    html += '<label for="reset-pwd-set">Contraseña de seguridad (opcional)</label>';
    html += '<input type="password" id="reset-pwd-set" class="sheet-input" placeholder="Mínimo 4 caracteres">';
    html += '<div class="btns-row">';
    html += '<button class="btn small primary" type="button" data-action="saveResetPassword">' + CHECK_ICON + ' Guardar contraseña</button>';
    if (s.resetPassword) html += '<button class="btn small danger-ghost" type="button" data-action="removeResetPassword">' + X_ICON + ' Quitar</button>';
    html += '</div>';
    html += '<p class="muted">' + (s.resetPassword ? (LOCK_ICON + ' Protegido: datos cifrados con AES-256. Se pedirá la contraseña al abrir la app.') : 'Sin contraseña: los datos se guardan sin cifrar en el dispositivo.') + '</p>';
    html += '<button class="btn block danger-ghost" data-action="resetData">Reiniciar la app</button>';
    html += '</section>';

    html += '<section class="card"><h3>' + SAVE_ICON + ' Respaldo de datos</h3>';
    html += '<p class="muted">Crea un archivo con todos tus datos (catálogo, clientes, cotizaciones y ajustes) y guárdalo en tu OneDrive o Google Drive. Con Restaurar los recuperas en este u otro dispositivo.</p>';
    html += '<button class="btn primary block" type="button" data-action="createBackup">' + SAVE_ICON + ' Crear respaldo</button>';
    html += '<button class="btn block" type="button" data-action="restoreBackup">' + BACK_ICON + ' Restaurar respaldo</button>';
    html += '<input type="file" id="backup-file" accept=".json,application/json" style="display:none">';
    html += '</section>';

    html += '<section class="card"><h3>' + WA_ICON + ' Consejo rápido</h3>';
    html += '<p class="muted">Instala la app: menú del navegador → "Añadir a pantalla de inicio" para usarla sin conexión como una app real.</p>';
    html += '</section>';
    return html;
  }

  function packChooserSheet(it) {
    const packPrice = Number(it.packPrice) > 0 ? it.packPrice : (Number(it.price) * Number(it.packQty));
    const packLabel = it.packQty + (it.unit ? ' ' + it.unit + 's' : '') + ' por caja';
    let html = '<div class="sheet"><div class="sheet-head"><b>' + escapeAttr(it.name) + '</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div>';
    html += '<div class="sheet-body">';
    html += '<p class="muted">Elige cómo lo vendes:</p>';
    html += '<button class="sheet-item" data-action="pickCatalogUnit" data-id="' + it.id + '"><span>' + (DB.itemType(it.type).id === 'PRODUCTO' ? ITEM_ICON : TOOLS_ICON) + ' ' + (it.unit ? escapeAttr(it.unit) : 'Unidad') + '</span><b>' + money(it.price) + '</b></button>';
    html += '<button class="sheet-item" data-action="pickCatalogPack" data-id="' + it.id + '"><span>' + ITEM_ICON + ' Caja · ' + escapeAttr(packLabel) + '</span><b>' + money(packPrice) + '</b></button>';
    html += '</div></div>';
    return html;
  }

  function catalogPickerSheet() {
    const s = DB.state;
    let html = '<div class="sheet"><div class="sheet-head"><b>Catálogo</b><button class="icon-btn" data-action="closeSheet">' + X_ICON + '</button></div>';
    html += '<div class="sheet-body">';
    s.catalog.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (i) {
      html += '<button class="sheet-item" data-action="pickCatalogItem" data-id="' + i.id + '"><span>' + (DB.itemType(i.type).id === 'PRODUCTO' ? ITEM_ICON : TOOLS_ICON) + ' ' + escapeAttr(i.name) + (Number(i.packQty) > 0 ? ' <small class="pack-hint">caja ×' + i.packQty + '</small>' : '') + '</span><b>' + money(i.price) + '</b></button>';
    });
    html += '</div></div>';
    return html;
  }

  function render() {
    parseHash();

    if (routeName === 'cotizacion' && !draftEntryMode) {
      draft = null;
    } else if (routeName === 'cotizacion' && draftEntryMode === 'new' && !draft) {
      ensureDraft();
    }

    let inner = '';
    switch (routeName) {
      case 'clientes': inner = clients(); break;
      case 'cliente': inner = (params.id === 'perfil') ? clientPerfil(params.aux) : clientForm(); break;
      case 'catalogo': inner = catalog(); break;
      case 'cotizacion': inner = quoteEditor(); break;
      case 'trabajos': inner = jobsView(); break;
      case 'trabajo': inner = jobDetail(); break;
      case 'ajustes': inner = settingsView(); break;
      case 'catalogo-item': inner = catalogFormView(); break;
      default: inner = dashboard();
    }
    mount(inner);
    if (routeName === 'cotizacion') {
      const clientSel = document.getElementById('qc-client');
      if (clientSel) clientSel.addEventListener('change', function () { draft.clientId = this.value || null; DB.captureClient(draft); });
    }
    refreshEditorBindings();
  }

  function refreshEditorBindings() {
    if (routeName !== 'cotizacion' || !draft) return;
    const disc = document.getElementById('qc-disc');
    const itbis = document.getElementById('qc-itbis');
    const notes = document.getElementById('qc-notes');
    if (disc) disc.addEventListener('input', function () { draft.discount = Number(this.value) || 0; refreshTotals(); });
    if (itbis) itbis.addEventListener('input', function () { draft.itbis = Number(this.value) || 0; refreshTotals(); });
    if (notes) notes.addEventListener('input', function () { draft.notes = this.value; });
  }

  function refreshTotals() {
    const panel = document.getElementById('totals-panel');
    if (panel && draft) panel.innerHTML = totalsHtml(draft);
  }

  function go(hash) {
    window.location.hash = hash;
  }

  const ACTIONS = {

    nav: function (el) { go('#/' + el.dataset.to); },

    contactSupport: function () { contactSupportAction(); },

    licenseRetry: function () {
      const scr = document.getElementById('license-screen');
      if (scr) scr.remove();
      License.check().then(function (st) {
        if (st.status === 'active' || st.status === 'grace') {
          licenseStatus = st;
          return DB.boot().then(function (mode) {
            if (mode === 'locked') { UI.showLockFirst(); return; }
            UI.init();
            try { Reminders.scheduleToday(); } catch (e) {}
          });
        }
        UI.showLicenseScreen(st);
      });
    },

    back: function () {
      if (pendingClientFor !== 'quote') { draft = null; draftEntryMode = null; }
      pendingClientFor = null;
      history.back();
    },

    navTrabajo: function (el) { go('#/trabajo/' + el.dataset.id); },

    newQuote: function () { draft = null; draftEntryMode = 'new'; pendingClientFor = null; go('#/cotizacion/nueva'); },

    newClient: function () { go('#/cliente/nuevo'); },

    addClientFromQuote: function () {
      pendingClientFor = 'quote';
      go('#/cliente/nuevo');
    },

    editClient: function (el) { go('#/cliente/editar/' + el.dataset.id); },

    openClient: function (el) { go('#/cliente/perfil/' + el.dataset.id); },

    quoteForClient: function (el) {
      const c = DB.find('clients', el.dataset.id);
      if (!c) return;
      draft = null;
      draftEntryMode = 'new';
      pendingClientFor = null;
      draft = DB.newJob(c);
      render();
      go('#/cotizacion/nueva');
    },

    clientAddAbono: function (el) {
      const c = DB.find('clients', el.dataset.id);
      if (!c) return;
      const pend = DB.state.jobs.filter(function (j) { return String(j.clientId) === String(c.id) && j.status !== 'CANCELADO' && DB.jobTotals(j).balance > 0.005; });
      if (!pend.length) { toast('Este cliente no tiene saldo pendiente', false); return; }
      openSheet(pend.length === 1 ? abonoSheetHtml(pend[0]) : pendingJobsSheet(pend));
    },

    pickPendingJob: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      const holder = document.getElementById('sheet-holder');
      if (holder) holder.innerHTML = abonoSheetHtml(j);
    },

    abonoSave: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      const amtInput = document.getElementById('abono-amount');
      const noteInput = document.getElementById('abono-note');
      const amount = Number(amtInput ? amtInput.value : '');
      if (!(amount > 0)) { toast('Escribe el monto del abono', false); return; }
      j.payments.push({ id: 'p' + DB.incr('payment'), note: (noteInput ? noteInput.value.trim() : '') || 'Abono', amount: amount, date: new Date().toISOString() });
      DB.save();
      if (DB.jobTotals(j).balance <= 0.005) { try { Reminders.cancelForJob(j.id); } catch (e) {} }
      const holder = document.getElementById('sheet-holder');
      if (holder) holder.remove();
      render();
      toast('Abono registrado', true);
    },

    deleteClient: function (el) {
      const c = DB.find('clients', el.dataset.id);
      if (!c) return;
      const jobs = DB.state.jobs.filter(function (j) { return String(j.clientId) === String(c.id); }).length;
      if (!confirmar('¿Eliminar a ' + c.name + '?' + (jobs ? ' Tiene ' + jobs + ' trabajo(s) asociado(s).' : ''))) return;
      DB.remove('clients', c.id);
      if (routeName === 'cliente' && params.id === 'perfil') { go('#/clientes'); return; }
      render();
    },

    newCatalogItem: function () { go('#/catalogo-item/nuevo'); },

    editCatalog: function (el) { go('#/catalogo-item/editar/' + el.dataset.id); },

    removeCatalog: function (el) {
      const i = DB.find('catalog', el.dataset.id);
      if (!i) return;
      if (!confirmar('¿Eliminar "' + i.name + '" del catálogo?')) return;
      DB.remove('catalog', i.id);
      render();
    },

    catalogFilter: function (el) { go('#/catalogo/f/' + el.dataset.f); },

    jobsFilter: function (el) { go('#/trabajos/f/' + el.dataset.f); },

    openCatalogPicker: function () {
      const s = document.createElement('div');
      s.id = 'sheet-holder';
      s.innerHTML = catalogPickerSheet();
      document.body.appendChild(s);
    },

    closeSheet: function () {
      const sh = document.getElementById('sheet-holder');
      if (sh) sh.remove();
    },

    pickCatalogItem: function (el) {
      const it = DB.find('catalog', el.dataset.id);
      if (!it) return;
      if (Number(it.packQty) > 0) {
        const sh = document.getElementById('sheet-holder');
        if (sh) sh.innerHTML = packChooserSheet(it);
        return;
      }
      ensureDraft();
      if (!draft.items) draft.items = [];
      draft.items.push({ desc: it.name, qty: 1, price: it.price, type: it.type });
      const close = document.getElementById('sheet-holder');
      if (close) close.remove();
      const lst = document.getElementById('item-list');
      if (lst) lst.innerHTML = itemsListHtml(draft);
      refreshTotals();
    },

    pickCatalogUnit: function (el) {
      const it = DB.find('catalog', el.dataset.id);
      if (!it) return;
      ensureDraft();
      if (!draft.items) draft.items = [];
      const unitLabel = it.unit ? (it.unit + ' (unidad)') : '';
      draft.items.push({ desc: unitLabel ? (it.name + ' · ' + unitLabel) : it.name, qty: 1, price: it.price, type: it.type });
      const close = document.getElementById('sheet-holder');
      if (close) close.remove();
      const lst = document.getElementById('item-list');
      if (lst) lst.innerHTML = itemsListHtml(draft);
      refreshTotals();
    },

    pickCatalogPack: function (el) {
      const it = DB.find('catalog', el.dataset.id);
      if (!it) return;
      const packQty = Number(it.packQty) || 1;
      const packPrice = Number(it.packPrice) > 0 ? it.packPrice : (Number(it.price) * packQty);
      ensureDraft();
      if (!draft.items) draft.items = [];
      draft.items.push({ desc: it.name + ' · caja × ' + packQty, qty: 1, price: packPrice, type: it.type });
      const close = document.getElementById('sheet-holder');
      if (close) close.remove();
      const lst = document.getElementById('item-list');
      if (lst) lst.innerHTML = itemsListHtml(draft);
      refreshTotals();
    },

    addManualLine: function () {
      ensureDraft();
      if (!draft.items) draft.items = [];
      draft.items.push({ desc: '', qty: 1, price: 0 });
      const lst = document.getElementById('item-list');
      if (lst) lst.innerHTML = itemsListHtml(draft);
      refreshTotals();
    },

    removeQuoteItem: function (el) {
      if (!draft || !draft.items) return;
      draft.items.splice(Number(el.dataset.id), 1);
      const lst = document.getElementById('item-list');
      if (lst) lst.innerHTML = itemsListHtml(draft);
      refreshTotals();
    },

    quoteSave: function () {
      if (!draft) { toast('Primero crea la cotización'); return; }
      if (!draft.clientId) { toast('Selecciona un cliente', false); return; }
      if (!draft.items || !draft.items.length || !draft.items.some(function (i) { return i.desc && Number(i.price) > 0; })) { toast('Agrega al menos un concepto válido', false); return; }
      if (!draft.id) {
        const num = DB.incr('job');
        draft.id = 'j' + num;
        draft.number = num;
        draft.code = (DB.state.settings.quotePrefix || 'COT') + '-' + String(num).padStart(4, '0');
      }
      DB.saveJob(draft);
      DB.captureClient(draft);
      const id = draft.id;
      toast('Cotización guardada', true);
      go('#/trabajo/' + id);
    },

    editQuote: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      draft = JSON.parse(JSON.stringify(j));
      draftEntryMode = 'edit';
      go('#/cotizacion/editar/' + j.id);
    },

    duplicateJob: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      const copy = JSON.parse(JSON.stringify(j));
      copy.id = undefined;
      copy.number = undefined;
      copy.code = undefined;
      copy.date = new Date().toISOString();
      copy.status = 'COTIZADO';
      copy.payments = [];
      draft = copy;
      draftEntryMode = 'edit';
      go('#/cotizacion/editar/' + j.id);
    },

    deleteJob: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      if (!confirmar('¿Eliminar la cotización ' + j.code + '?')) return;
      try { Reminders.cancelForJob(j.id); } catch (e) {}
      DB.remove('jobs', j.id);
      go('#/trabajos');
    },

    setStatus: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      const st = el.dataset.status;
      if (st === 'COBRADO' && j.status !== 'COBRADO') {
        const t = DB.jobTotals(j);
        if (t.balance > 0.005) {
          if (!confirmar('Marcar como Cobrado registrará el cobro de ' + money(t.balance) + ' (saldo restante). ¿Continuar?')) return;
          const amt = Math.round(t.balance * 100) / 100;
          j.payments.push({ id: 'p' + DB.incr('payment'), note: 'Cobro total', amount: amt, date: new Date().toISOString() });
          j.status = st;
          DB.save();
          render();
          toast('Cobro de ' + money(amt) + ' registrado. Trabajo cobrado', true);
          return;
        }
      }
      DB.update('jobs', el.dataset.id, { status: st });
      render();
      toast('Estado actualizado', true);
    },

    pdfDownload: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      PDF.download(j).then(function (ok) {
        console.log('PDFDL_OK ' + ok);
        if (ok) toast('PDF listo: elige dónde guardarlo', true);
      }).catch(function (e) {
        console.error('PDFDL_ERR ' + (e && e.message));
        toast('PDF: ' + (e && e.message ? e.message : 'no se pudo generar'), false);
      });
    },

    pdfShare: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      PDF.share(j).then(function (shared) {
        console.log('PDFSH_OK ' + shared);
        if (shared) toast('PDF listo: elige dónde guardarlo', true);
      }).catch(function (e) {
        console.error('PDFSH_ERR ' + (e && e.message));
        const m = (e && e.message) || '';
        const cancel = /cancel/i.test(m);
        toast(cancel ? 'Compartir cancelado' : 'PDF: ' + (m ? m : 'no se pudo generar'), false);
      });
    },

    whatsapp: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      const phone = (j.clientPhone || '').replace(/[^\d]/g, '');
      let digits = phone;
      if (digits.length === 10) digits = '1' + digits;
      if (digits.length !== 11 && digits.length !== 12) {
        const p = window.prompt('Los datos del cliente no tienen un teléfono válido. Escribe el número del cliente (solo dígitos):');
        if (!p) return;
        digits = p.replace(/[^\d]/g, '');
        if (digits.length === 10) digits = '1' + digits;
        if (digits.length < 8) return;
      }
      const msg = waMessage(j);
      const url = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
      if (isNativeEnv()) {
        const B = capacitorPlugin('Browser');
        if (B) { B.open({ url: url }); return; }
      }
      window.open(url, '_blank');
    },

    removeExpense: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      j.expenses = j.expenses.filter(function (e) { return String(e.id) !== String(el.dataset.ex); });
      DB.save();
      render();
    },

    removePayment: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      j.payments = j.payments.filter(function (p) { return String(p.id) !== String(el.dataset.pay); });
      DB.save();
      render();
    },

    removeLogo: function () {
      DB.state.settings.logo = null;
      DB.save();
      render();
    },

    createBackup: function () { exportBackup(); },

    restoreBackup: function () {
      const f = document.getElementById('backup-file');
      if (f) f.click();
    },

    signTech: function () { openSignSheet('tech', null); },
    signJob: function (el) { openSignSheet('job', el.dataset.id); },
    signClear: function () { clearSignCanvas(); },
    signSave: function (el) { saveSign(el.dataset.target, el.dataset.id); },
    removeTechSignature: function () {
      DB.state.settings.signature = null;
      DB.save();
      render();
      toast('Firma quitada', true);
    },
    removeJobSignature: function (el) {
      const j = DB.find('jobs', el.dataset.id);
      if (!j) return;
      j.signature = null;
      DB.save();
      render();
      toast('Firma quitada', true);
    },

    saveResetPassword: function () {
      const inp = document.getElementById('reset-pwd-set');
      const v = (inp ? inp.value : '') || '';
      if (v.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', false); return; }
      const self = this;
      DB.setEncryption(v).then(function (ok) {
        if (!ok) { toast('No se pudo activar la protección', false); return; }
        DB.state.settings.resetPassword = hashVal(v);
        DB.state.settings.lockOnStart = true;
        DB.state.settings.relockOnResume = true;
        DB.save();
        render();
        toast('Contraseña guardada. Datos cifrados.', true);
      });
    },

    removeResetPassword: function () {
      const self = this;
      if (!confirmar('¿Quitar la contraseña? Los datos volverán a guardarse sin cifrar.')) return;
      DB.state.settings.resetPassword = '';
      DB.disableEncryption().then(function () {
        DB.save();
        render();
        toast('Contraseña quitada. Cifrado desactivado.', true);
      });
    },

    enableProtection: function () {
      const self = this;
      DB.bioAvailable().then(function (bio) {
        if (!bio) { toast('Este equipo no tiene huella disponible. Usa una contraseña de respaldo en la zona de riesgo.', false); return; }
        DB.setEncryption('').then(function (ok) {
          if (!ok) { toast('No se pudo activar la protección', false); return; }
          DB.state.settings.lockOnStart = true;
          DB.state.settings.relockOnResume = true;
          DB.save();
          render();
          toast('Protección activada: se desbloquea con tu huella.', true);
        });
      });
    },

    disableProtection: function () {
      const self = this;
      if (!confirmar('¿Desactivar la protección? Tus datos volverán a guardarse sin cifrar.')) return;
      DB.state.settings.resetPassword = '';
      DB.disableEncryption().then(function () {
        DB.save();
        render();
        toast('Protección desactivada. Datos sin cifrar.', true);
      });
    },

    saveBackupPassword: function () {
      const inp = document.getElementById('backup-pwd-set');
      const v = (inp ? inp.value : '') || '';
      if (v.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', false); return; }
      const self = this;
      DB.setEncryption(v).then(function (ok) {
        if (!ok) { toast('No se pudo guardar la contraseña de respaldo', false); return; }
        DB.state.settings.resetPassword = hashVal(v);
        DB.save();
        render();
        toast('Contraseña de respaldo guardada.', true);
      });
    },

    removeBackupPassword: function () {
      const self = this;
      if (!confirmar('¿Quitar la contraseña de respaldo? Solo quedará la huella.')) return;
      DB.removePassword().then(function (ok) {
        if (!ok) { toast('No se pudo quitar: no hay huella configurada.', false); return; }
        DB.state.settings.resetPassword = '';
        DB.save();
        render();
        toast('Contraseña de respaldo quitada.', true);
      });
    },

    resetData: function () {
      const pwd = DB.state.settings.resetPassword;
      if (pwd) { openSheet(resetPassSheet()); return; }
      if (!confirmar('¿Seguro que quieres borrar TODOS los datos y comenzar de nuevo?')) return;
      doReset();
    },

    confirmResetData: function () {
      const inp = document.getElementById('reset-pass-verify');
      const v = (inp ? inp.value : '') || '';
      if (hashVal(v) !== DB.state.settings.resetPassword) { toast('Contraseña incorrecta', false); return; }
      const holder = document.getElementById('sheet-holder');
      if (holder) holder.remove();
      doReset();
    },

    bioUnlock: function () {
      const bio = bioApi();
      if (!bio) { toast('Huella no disponible en este equipo', false); showPasswordField(); return; }
      biometricPromptActive = true;
      if (DB.isProtected()) {
        DB.unlockFingerprint().then(function (ok) {
          if (!ok) { toast('No se pudo desbloquear con huella', false); showPasswordField(); return; }
          const o = document.getElementById('lock-screen');
          if (o) o.remove();
          unlockApp();
          toast('¡Bienvenido!', true);
        }).finally(function () {
          setTimeout(function () { biometricPromptActive = false; }, 1500);
        });
        return;
      }
      bio.verifyIdentity({
        reason: 'Para desbloquear CotizaTec',
        title: 'Desbloquear CotizaTec',
        subtitle: 'Usa la huella para continuar',
        negativeButtonText: 'Usar contraseña'
      }).then(function () {
        unlockApp();
        toast('¡Bienvenido!', true);
      }).catch(function (e) {
        const code = e && e.code;
        if (code === 16 || code === 17 || code === 11 || code === 15) { showPasswordField(); return; }
        toast('No se pudo desbloquear con huella', false);
        showPasswordField();
      }).finally(function () {
        setTimeout(function () { biometricPromptActive = false; }, 1500);
      });
    },

    togglePwd: function () { showPasswordField(); },

    passwordUnlock: function () {
      const inp = document.getElementById('lock-pwd-input');
      const v = (inp ? inp.value : '') || '';
      if (DB.isProtected()) {
        DB.unlock(v).then(function (ok) {
          if (!ok) { toast('Contraseña incorrecta', false); return; }
          const o = document.getElementById('lock-screen');
          if (o) o.remove();
          unlockApp();
          init();
          toast('¡Bienvenido!', true);
        });
        return;
      }
      if (hashVal(v) !== DB.state.settings.resetPassword) { toast('Contraseña incorrecta', false); return; }
      unlockApp();
      toast('¡Bienvenido!', true);
    },

    firstBioUnlock: function () {
      biometricPromptActive = true;
      DB.unlockFingerprint().then(function (ok) {
        if (!ok) { toast('No se pudo desbloquear con huella', false); return; }
        const o = document.getElementById('lock-screen');
        if (o) o.remove();
        unlockApp();
        init();
        toast('¡Bienvenido!', true);
      }).finally(function () {
        setTimeout(function () { biometricPromptActive = false; }, 1500);
      });
    },

    firstTogglePwd: function () {
      const b = document.getElementById('lock-first-bio');
      if (b) b.style.display = 'none';
      const t = document.getElementById('lock-first-toggle');
      if (t) t.style.display = 'none';
      const w = document.getElementById('lock-first-pwd-wrap');
      if (w) w.style.display = 'block';
      const inp = document.getElementById('lock-first-pwd');
      if (inp) inp.focus();
    },

    firstUnlock: function () {
      const inp = document.getElementById('lock-first-pwd');
      const v = (inp ? inp.value : '') || '';
      DB.unlock(v).then(function (ok) {
        if (!ok) { toast('Contraseña incorrecta', false); return; }
        const o = document.getElementById('lock-screen');
        if (o) o.remove();
        unlockApp();
        init();
        toast('¡Bienvenido!', true);
      });
    },

    forceUnlock: function () {
      unlockApp();
    }
  };

  document.addEventListener('click', function (e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const fn = ACTIONS[el.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn(el);
  });

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    const form = e.target;
    const dataForm = form.dataset.form;

    if (dataForm === 'expense' || dataForm === 'payment') {
      const jobId = form.dataset.job;
      const j = DB.find('jobs', jobId);
      if (!j) return;
      const note = (form.elements.note || {}).value || '';
      const label = (form.elements.label || {}).value || '';
      const amount = (form.elements.amount || {}).value || '';
      if (dataForm === 'expense') {
        if (!label || Number(amount) <= 0) { toast('Escribe nombre y monto del gasto', false); return; }
        j.expenses.push({ id: 'e' + DB.incr('expense'), name: label, amount: Number(amount), date: new Date().toISOString() });
        toast('Gasto registrado', true);
      } else {
        if (Number(amount) <= 0) { toast('Escribe el monto del abono', false); return; }
        j.payments.push({ id: 'p' + DB.incr('payment'), note: note || 'Abono', amount: Number(amount), date: new Date().toISOString() });
        if (DB.jobTotals(j).balance <= 0.005) { try { Reminders.cancelForJob(j.id); } catch (e) {} }
        toast('Abono registrado', true);
      }
      DB.save();
      render();
      return;
    }

    if (routeName === 'cliente') {
      const name = form.elements.name.value.trim();
      if (!name) { toast('El nombre es obligatorio', false); return; }
      if (params.id && params.id !== 'nuevo') {
        DB.update('clients', params.id, { name: name, phone: form.elements.phone.value.trim(), address: form.elements.address.value.trim() });
        toast('Cliente actualizado', true);
      } else {
        DB.push('clients', { id: 'c' + DB.incr('client'), name: name, phone: form.elements.phone.value.trim(), address: form.elements.address.value.trim() });
        toast('Cliente agregado', true);
      }
      if (pendingClientFor === 'quote') {
        const cl = DB.state.clients[DB.state.clients.length - 1];
        if (cl) {
          draft = DB.newJob(cl);
          pendingClientFor = null;
          go('#/cotizacion/nueva');
          return;
        }
      }
      pendingClientFor = null;
      go('#/clientes');
      return;
    }

    if (routeName === 'catalogo-item') {
      const name = form.elements.name.value.trim();
      const price = Number(form.elements.price.value);
      if (!name || isNaN(price) || price < 0) { toast('Nombre y precio obligatorios', false); return; }
      const patch = { name: name, type: form.elements.type.value, price: price };
      if (form.elements.unit) patch.unit = form.elements.unit.value.trim();
      const packQty = form.elements.packQty ? (Number(form.elements.packQty.value) || 0) : 0;
      patch.packQty = packQty > 0 ? packQty : null;
      patch.packPrice = (packQty > 0 && form.elements.packPrice && Number(form.elements.packPrice.value) > 0) ? Number(form.elements.packPrice.value) : null;
      if (params.id && params.id !== 'nuevo') {
        DB.update('catalog', params.id, patch);
      } else {
        patch.id = 'c' + DB.incr('catalog');
        DB.push('catalog', patch);
      }
      go('#/catalogo');
      return;
    }

    if (routeName === 'ajustes') {
      const s = DB.state.settings;
      s.businessName = form.elements.businessName.value.trim() || s.businessName;
      s.phone = form.elements.phone.value.trim();
      s.address = form.elements.address.value.trim();
      s.itbis = Number(form.elements.itbis.value) || 0;
      s.validityDays = Number(form.elements.validityDays.value) || 15;
      s.quotePrefix = form.elements.quotePrefix.value.trim() || 'COT';
      if (form.elements.docTitle) s.docTitle = form.elements.docTitle.value.trim() || 'COTIZACIÓN';
      s.watermarkEnabled = form.elements.watermarkEnabled.checked;
      s.watermark = form.elements.watermark.value.trim();
      s.lockOnStart = form.elements.lockOnStart.checked;
      s.relockOnResume = form.elements.relockOnResume.checked;
      DB.save();
      toast('Ajustes guardados', true);
      render();
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'backup-file') {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) importBackupFile(f);
      return;
    }
    const up = e.target.closest('[data-upload]');
    if (!up) return;
    const f = up.files && up.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = function (ev) {
      compressImage(ev.target.result, 400, function (compressed) {
        DB.state.settings.logo = compressed;
        DB.save();
        toast('Logo guardado', true);
        render();
      });
    };
    r.readAsDataURL(f);
  });

  document.addEventListener('input', function (e) {
    const f = e.target.closest('[data-qf]');
    if (!f || !draft) return;
    const idx = Number(f.dataset.qi);
    const key = f.dataset.qf;
    const items = draft.items;
    if (!items || !items[idx]) return;
    if (key === 'qty') items[idx].qty = Number(f.value) || 0;
    if (key === 'desc') items[idx].desc = f.value;
    if (key === 'price') items[idx].price = Number(f.value) || 0;
    const sub = document.getElementById('qi-sub-' + idx);
    if (sub) sub.textContent = money(items[idx].qty * items[idx].price);
    refreshTotals();
  });

  document.addEventListener('input', function (e) {
    const sr = e.target.closest('[data-search]');
    if (!sr) return;
    const q = sr.value.toLowerCase();
    document.querySelectorAll('[data-search-item="' + sr.dataset.search + '"]').forEach(function (row) {
      if (q && row.textContent.toLowerCase().indexOf(q) < 0) row.setAttribute('hidden', '');
      else row.removeAttribute('hidden');
    });
  });

  function waMessage(j) {
    const t = DB.jobTotals(j);
    const s = DB.state.settings;
    let m = [];
    m.push('*' + (s.businessName || 'Mi Negocio') + '*');
    m.push('');
    m.push('COTIZACIÓN ' + j.code);
    m.push('Fecha: ' + DB.date(j.date));
    m.push('Cliente: ' + (j.clientName || ''));
    m.push('');
    (j.items || []).forEach(function (i) {
      const line = i.desc || '';
      m.push((i.qty > 1 ? '✓ ' + i.qty + ' × ' : '✓ ') + line + ' — ' + money((i.qty || 0) * (i.price || 0)));
    });
    m.push('');
    m.push('Subtotal: ' + money(t.subtotal));
    if (t.discount > 0) m.push('Descuento: -' + money(t.discount));
    m.push('ITBIS (' + (j.itbis || 0) + '%): ' + money(t.tax));
    m.push('*TOTAL: ' + money(t.total) + '*');
    if (j.payments && j.payments.length) {
      m.push('');
      m.push('Abonado: ' + money(t.collected));
      m.push('Saldo pendiente: ' + money(t.balance));
    }
    if (s.validityDays) m.push('');
    m.push('Válida por ' + (s.validityDays || 15) + ' días');
    if (s.watermarkEnabled && s.watermark) {
      m.push('');
      m.push(s.watermark);
    }
    return m.join('\n');
  }

  window.addEventListener('hashchange', render);

  // Pantalla inicial cuando los datos están cifrados: ofrece la huella como
  // método principal y la contraseña como respaldo opcional.
  function showLicenseScreen(st) {
    const d = document.createElement('div');
    d.id = 'license-screen';
    let msg = '', sub = '';
    if (st.status === 'none') {
      msg = 'Licencia no activada';
      sub = 'Esta copia de CotizaTec aún no está activada. Envía tu código de dispositivo al administrador para activarla.';
    } else if (st.status === 'blocked') {
      msg = 'Dispositivo bloqueado';
      sub = 'Contacta al administrador para restablecer tu acceso.';
    } else if (st.status === 'expired') {
      msg = 'Tu suscripción venció';
      sub = 'El período de gracia se agotó. Renueva tu suscripción para seguir usando CotizaTec.';
    } else {
      msg = 'Revisando licencia';
      sub = 'No se pudo verificar la licencia en este momento.';
    }
    const deviceId = License.getDeviceId();
    let contactHtml = '';
    if (st.status === 'blocked') contactHtml = '<button class="btn primary block" id="license-contact" data-action="contactSupport">' + WA_ICON + ' Contactar por WhatsApp</button>';
    let html = '<div class="lock-card">' + LOCK_ICON +
      '<b>CotizaTec</b><p class="muted">' + msg + '</p>' +
      '<p class="muted">' + sub + '</p>' +
      '<div class="license-code" id="license-code">Código de dispositivo:<br>cargando…</div>' +
      contactHtml +
      '<button class="btn primary block" data-action="licenseRetry">' + CHECK_ICON + ' Volver a verificar</button>';
    html += '</div>';
    d.innerHTML = html;
    document.body.appendChild(d);
    deviceId.then(function (id) {
      const el = document.getElementById('license-code');
      if (el) el.innerHTML = 'Código de dispositivo:<br><b>' + id + '</b>';
    });
  }

  function contactSupportAction() {
    License.getDeviceId().then(function (id) {
      const phone = ((DB.state && DB.state.settings && DB.state.settings.phone) || '').replace(/[^\d]/g, '');
      let digits = phone;
      if (digits.length === 10) digits = '1' + digits;
      if (digits.length !== 11 && digits.length !== 12) {
        const p = window.prompt('Escribe el teléfono de WhatsApp del administrador (solo dígitos):');
        if (!p) return;
        digits = p.replace(/[^\d]/g, '');
        if (digits.length < 8) return;
      }
      const msg = 'Hola, mi dispositivo CotizaTec fue bloqueado. Código: ' + (id || 'desconocido') + '. Por favor restablece mi acceso.';
      const url = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(msg);
      if (isNativeEnv()) {
        const B = capacitorPlugin('Browser');
        if (B) { B.open({ url: url }); return; }
      }
      window.open(url, '_blank');
    });
  }

  function showLockFirst() {
    const d = document.createElement('div');
    d.id = 'lock-screen';
    const hasBio = DB.hasFingerprint();
    const hasPwd = DB.canUnlockByPassword();
    let html = '<div class="lock-card">' + LOCK_ICON +
      '<b>CotizaTec</b><p class="muted">Los datos están protegidos.</p>';
    if (hasBio) {
      html += '<button class="btn primary block" data-action="firstBioUnlock" id="lock-first-bio">' + LOCK_ICON + ' Desbloquear con huella</button>';
      if (hasPwd) html += '<button class="btn ghost block" data-action="firstTogglePwd" id="lock-first-toggle">Usar contraseña</button>';
    }
    html += '<div id="lock-first-pwd-wrap"' + (hasPwd ? (hasBio ? ' style="display:none"' : '') : ' style="display:none"') + '>';
    if (hasPwd) {
      html += '<input id="lock-first-pwd" class="sheet-input" type="password" placeholder="Contraseña" autocomplete="off">' +
        '<button class="btn primary block" data-action="firstUnlock">' + CHECK_ICON + ' Desbloquear</button>';
    } else if (!hasBio) {
      html += '<p class="muted">No hay huella ni contraseña configuradas para este equipo. Tus datos están protegidos en este dispositivo; contacta al propietario.</p>';
    }
    html += '</div></div>';
    d.innerHTML = html;
    document.body.appendChild(d);
    if (hasBio) {
      document.getElementById('lock-first-bio').focus();
    } else {
      const inp = document.getElementById('lock-first-pwd');
      if (inp) inp.focus();
    }
  }

  function init() {
    render();
    recompressExisting();
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
    applyLockScreen();
    const ap = appPlugin();
    if (ap && typeof ap.addListener === 'function') {
      ap.addListener('appStateChange', function (s) {
        if (s && s.isActive === false) {
          DB.fsFlush();
          if (!DB.state.settings.lockOnStart || !DB.state.settings.relockOnResume) return;
          if (!biometricPromptActive) resetLock();
        } else if (s && s.isActive === true) {
          setTimeout(function () {
            if (biometricPromptActive) return;
            if (DB.state.settings.lockOnStart && DB.state.settings.relockOnResume) {
              applyLockScreen(true);
            } else {
              applyLockScreen();
            }
          }, 400);
        }
      });
    }
  }

  return { init: init, applyLockScreen: applyLockScreen, compressImage: compressImage, showLockFirst: showLockFirst, showLicenseScreen: showLicenseScreen };
})();

document.addEventListener('DOMContentLoaded', function () {
    License.requestNotificationPermission();
    License.check().then(function (st) {
      if (st.status === 'active' || st.status === 'grace') {
        licenseStatus = st;
        return DB.boot().then(function (mode) {
          if (mode === 'locked') { UI.showLockFirst(); return; }
          return License.getDeviceId().then(function (deviceId) {
            if (mode === 'blank') {
              return Backups.pullFromCloud(deviceId).then(function (restored) {
                UI.init();
                if (restored) Util.toast('Datos restaurados desde la nube', true);
                else Util.toast('No hay datos en la nube para restaurar', false);
                Backups.pushToCloud(deviceId);
                try { Reminders.scheduleToday(); } catch (e) {}
              });
            }
            UI.init();
            Backups.pushToCloud(deviceId);
            try { Reminders.scheduleToday(); } catch (e) {}
          });
        });
      }
      UI.showLicenseScreen(st);
    });
    startLicenseWatch();
  });

  // Verificación periódica: si el admin bloquea el dispositivo mientras la app
  // está abierta, se bloquea en el momento (cada 30s) sin esperar a reabrir.
  function startLicenseWatch() {
    setInterval(function () {
      License.refresh().then(function (st) {
        if (!st) return;
        if (st.status === 'blocked') {
          licenseStatus = st;
          const scr = document.getElementById('license-screen');
          if (!scr) UI.showLicenseScreen(st);
          return;
        }
        if (st.status === 'none') {
          licenseStatus = st;
          const scr = document.getElementById('license-screen');
          if (!scr) UI.showLicenseScreen(st);
          return;
        }
        licenseStatus = st;
      }).catch(function () {});
    }, 30000);
  }