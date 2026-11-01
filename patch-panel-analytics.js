// patch-panel-analytics.js — Fase 2: pestana "Analiticas" en el panel web
const fs = require('fs');
const ARCHIVO = 'backend/public/panel.html';
let s = fs.readFileSync(ARCHIVO, 'utf8');
const eraCRLF = s.indexOf('\r\n') >= 0;
if (eraCRLF) s = s.replace(/\r\n/g, '\n');
let fails = 0;

function patch(name, from, to) {
  const i = s.indexOf(from);
  if (i < 0) { console.log('MISS : ' + name); fails++; return; }
  if (s.indexOf(from, i + 1) >= 0) { console.log('DUP  : ' + name); fails++; return; }
  s = s.slice(0, i) + to + s.slice(i + from.length);
  console.log('OK   : ' + name);
}

// A) contenedor HTML de la pestana (antes de mod-mov)
patch('A: panel HTML',
'      <div class="mod-panel" id="mod-mov">',
`      <div class="mod-panel" id="mod-analytics">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px">
            <div style="font-weight:700">\u{1F4C8} Anal\u00EDticas \u2014 rotaci\u00F3n y alertas</div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
              <button class="btn small ghost" onclick="loadAnalytics(30)">30 d</button>
              <button class="btn small ghost" onclick="loadAnalytics(60)">60 d</button>
              <button class="btn small ghost" onclick="loadAnalytics(90)">90 d</button>
              <button class="btn small ghost" onclick="anPrefs()">\u2699 Umbrales</button>
            </div>
          </div>
          <div class="muted" style="font-size:12px;margin-bottom:8px">Ventas top, productos "muertos" (capital parado), stock bajo y cobertura. Solo lectura: no altera cotizaciones ni la app.</div>
          <div id="an-body"><div class="muted">Abre esta pesta\u00F1a para cargar\u2026</div></div>
        </div>
      </div>

      <div class="mod-panel" id="mod-mov">`);

// B) entrada en MOD_DEFS (pestana antes de Movimientos)
patch('B: MOD_DEFS',
"  { key: 'mov', icon: '\\ud83d\\udccb', label: 'Movimientos', render: renderMovContent },",
"  { key: 'analytics', icon: '\u{1F4C8}', label: 'Anal\u00EDticas', render: renderAnalyticsContent },\n  { key: 'mov', icon: '\\ud83d\\udccb', label: 'Movimientos', render: renderMovContent },");

// C) visibilidad: solo owner
patch('C: filtro owner',
"    if (m.key === 'mov') return mods.indexOf('reportes') !== -1 || mods.indexOf('ventas') !== -1;",
"    if (m.key === 'mov') return mods.indexOf('reportes') !== -1 || mods.indexOf('ventas') !== -1;\n    if (m.key === 'analytics') return myRole === 'owner';");

// D) arranque perezoso al abrir la pestana
patch('D1: lazy en tabs',
"  if (activeMod === 'mov') mvLazy();",
"  if (activeMod === 'mov') mvLazy();\n  if (activeMod === 'analytics') anLazy();");
patch('D2: lazy en switch',
"  if (key === 'mov') mvLazy();",
"  if (key === 'mov') mvLazy();\n  if (key === 'analytics') anLazy();");

// E) logica de la pestana, tras renderMovContent
patch('E: JS analiticas',
"function renderMovContent(report) { /* carga perezosa: mvLazy() al abrir la pestana */ }",
`function renderMovContent(report) { /* carga perezosa: mvLazy() al abrir la pestana */ }

// ===== Analiticas / rotacion / alertas (Fase 2) =====
let _anDays = 0, _anPrefs = null, _anData = null, _anChartBound = false, _anFilter = 'todos';
function renderAnalyticsContent(report) { /* carga perezosa: anLazy() al abrir la pestana */ }
function anLazy() { if (window._anBoot) return; window._anBoot = true; loadAnalytics(0); }
function anMoney(v) { const n = Number(v) || 0; return 'RD$ ' + n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function anCard(t, v) { return '<div style="border:1px solid rgba(0,240,255,.18);border-radius:14px;padding:10px 12px;margin:0 6px 6px 0;display:inline-block;min-width:140px;vertical-align:top"><div class="muted" style="font-size:11px">' + esc(t) + '</div><div style="font-weight:800;font-size:15px">' + v + '</div></div>'; }
function anMin(p) {
  if (_anPrefs && _anPrefs.minStock && _anPrefs.minStock[p.id] != null) return _anPrefs.minStock[p.id];
  return (_anPrefs && _anPrefs.lowStock != null) ? _anPrefs.lowStock : 3;
}
function loadAnalytics(days) {
  if (days) _anDays = Number(days) || 0;
  const body = document.getElementById('an-body');
  if (body) body.innerHTML = '<div class="muted">Cargando anal\u00EDticas\u2026</div>';
  api('/api/client/analytics' + (_anDays ? ('?days=' + _anDays) : '')).then(function (d) {
    if (!d || !d.ok) { if (body) body.innerHTML = '<div class="muted">No se pudieron cargar las anal\u00EDticas.</div>'; return; }
    if (!d.hasData) { if (body) body.innerHTML = '<div class="muted">Todav\u00EDa no hay datos sincronizados del negocio.</div>'; return; }
    _anPrefs = d.prefs || {};
    _anData = d.analytics || {};
    renderAnalytics();
  }).catch(function (e) { if (body) body.innerHTML = '<div class="muted">Error: ' + esc(String((e && e.message) || '')) + '</div>'; });
}
function renderAnalytics() {
  const body = document.getElementById('an-body');
  if (!body || !_anData) return;
  const a = _anData, al = a.alerts || {}, kp = a.kpis || {};
  const win = (a.window && a.window.days) || 60;
  let h = '';
  const alertCount = (al.agotados || 0) + (al.bajos || 0) + (al.muertos || 0);
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px">';
  if (!alertCount) h += '<span style="border:1px solid #22c55e;color:#86efac;border-radius:10px;padding:6px 10px;font-size:12px">\u2705 Sin alertas de inventario</span>';
  if (al.agotados) h += '<button class="btn small ghost" style="border-color:#ef4444;color:#fca5a5" onclick="anSetFilter(\'agotados\')">\u{1F534} ' + al.agotados + ' agotado(s)</button>';
  if (al.bajos) h += '<button class="btn small ghost" style="border-color:#f59e0b;color:#fbbf24" onclick="anSetFilter(\'bajos\')">\u{1F7E1} ' + al.bajos + ' stock bajo</button>';
  if (al.muertos) h += '<button class="btn small ghost" style="border-color:#64748b;color:#cbd5e1" onclick="anSetFilter(\'muertos\')">\u26AB ' + al.muertos + ' muerto(s)</button>';
  h += '<span class="muted" style="font-size:11px;align-self:center">Ventana: ' + win + ' d\u00EDas</span>';
  h += '</div>';
  h += '<div style="margin-bottom:12px">' +
    anCard('Capital en inventario', anMoney(kp.valorInventario || 0)) +
    anCard('Unidades vendidas', String(kp.unidadesPeriodo || 0)) +
    anCard('Facturado en mercanc\u00EDa', anMoney(kp.facturadoProductos || 0)) +
    anCard('Productos sin costo', String(kp.itemsSinCosto || 0)) +
    '</div>';
  h += '<div style="font-weight:700;font-size:13px;margin:2px 0 6px">Top ventas \u2014 unidades (' + win + ' d\u00EDas)</div>';
  h += '<canvas id="an-chart" style="width:100%;height:190px;display:block;margin-bottom:12px"></canvas>';
  h += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">';
  h += '<label class="muted" style="font-size:12px">Ver:</label>';
  h += '<select id="an-filter" style="padding:6px" onchange="anSetFilter(this.value)">';
  [['todos','Todos con stock'],['alertas','Con alerta'],['muertos','Muertos'],['bajos','Bajos'],['agotados','Agotados'],['sinmov','Sin ventas nunca']].forEach(function (o) {
    h += '<option value="' + o[0] + '"' + (_anFilter === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
  });
  h += '</select>';
  h += '<span class="muted" style="font-size:11px">Muerto = sin ventas hace m\u00E1s de ' + win + ' d\u00EDas \u00B7 Cobertura = d\u00EDas de stock al ritmo actual \u00B7 El bot\u00F3n "m\u00EDn" fija el piso de alerta por producto</span>';
  h += '</div>';
  h += '<div id="an-table"></div>';
  if ((a.sinCatalogo || []).length) h += '<div style="font-weight:700;font-size:13px;margin:14px 0 6px">Ventas sin producto del cat\u00E1logo (revisa nombres)</div><div class="muted" style="font-size:12px">' + a.sinCatalogo.slice(0, 8).map(function (u) { return esc(u.name) + ' \u00D7' + u.units; }).join(' \u00B7 ') + '</div>';
  body.innerHTML = h;
  anDrawChart();
  anRenderTable();
}
function anSetFilter(v) { _anFilter = v; const sel = document.getElementById('an-filter'); if (sel) sel.value = v; anRenderTable(); }
function anBadge(p) {
  if (p.out) return '<span style="color:#fca5a5;font-weight:700">\u{1F534} agotado</span>';
  if (p.dead && p.low) return '<span style="color:#fbbf24;font-weight:700">\u{1F7E1}\u26AB bajo+muerto</span>';
  if (p.dead) return '<span style="color:#cbd5e1;font-weight:700">\u26AB muerto</span>';
  if (p.low) return '<span style="color:#fbbf24;font-weight:700">\u{1F7E1} bajo</span>';
  return '<span class="muted">ok</span>';
}
function anRenderTable() {
  const el = document.getElementById('an-table');
  if (!el || !_anData) return;
  const win = (_anData.window && _anData.window.days) || 60;
  let ps = (_anData.productos || []).filter(function (p) { return p.stock != null; });
  const f = _anFilter;
  if (f === 'muertos') ps = ps.filter(function (p) { return p.dead; });
  else if (f === 'bajos') ps = ps.filter(function (p) { return p.low; });
  else if (f === 'agotados') ps = ps.filter(function (p) { return p.out; });
  else if (f === 'sinmov') ps = ps.filter(function (p) { return p.unitsAll === 0 && !p.out; });
  else if (f === 'alertas') ps = ps.filter(function (p) { return p.out || p.low || p.dead; });
  ps.sort(function (a, b) {
    const rank = function (p) { return p.out ? 0 : (p.dead ? 1 : (p.low ? 2 : 3)); };
    return rank(a) - rank(b) || (b.stock || 0) - (a.stock || 0);
  });
  if (!ps.length) {
    el.innerHTML = '<div class="muted" style="font-size:12px">Nada que mostrar con este filtro. Si la lista general est\u00E1 vac\u00EDa, es porque los productos a\u00FAn no tienen un n\u00FAmero en el campo <b>Stock</b> (sin stock no hay rotaci\u00F3n ni capital parado que medir).</div>';
    return;
  }
  let rows = '';
  ps.forEach(function (p) {
    const last = p.daysSinceSale == null ? 'nunca' : (p.daysSinceSale + ' d');
    const cover = p.daysCover == null ? '\u221E' : (p.daysCover + ' d');
    rows += '<tr><td>' + esc(p.name) + ' <span class="muted" style="font-size:10px">\u00B7 m\u00EDn ' + anMin(p) + '</span></td>' +
      '<td style="text-align:right">' + (p.stock || 0) + '</td>' +
      '<td style="text-align:right">' + p.unitsWindow + '</td>' +
      '<td style="text-align:right">' + last + '</td>' +
      '<td style="text-align:right">' + cover + '</td>' +
      '<td>' + anBadge(p) + '</td>' +
      '<td style="text-align:right"><button class="btn small ghost an-min" data-id="' + esc(String(p.id)) + '">m\u00EDn</button></td></tr>';
  });
  el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>Producto</th><th style="text-align:right">Stock</th><th style="text-align:right">Vend ' + win + 'd</th><th style="text-align:right">\u00DAlt venta</th><th style="text-align:right">Cobertura</th><th>Alerta</th><th style="text-align:right">M\u00EDn</th></tr></thead><tbody>' + rows + '</tbody></table>';
  el.querySelectorAll('.an-min').forEach(function (btn) {
    btn.addEventListener('click', function () { anSetMin(btn.getAttribute('data-id')); });
  });
}
function anSetMin(id) {
  if (!_anPrefs) _anPrefs = {};
  if (!_anPrefs.minStock) _anPrefs.minStock = {};
  const cur = _anPrefs.minStock[id] != null ? _anPrefs.minStock[id] : '';
  const v = window.prompt('Stock m\u00EDnimo para este producto (alerta "bajo" desde este n\u00FAmero). Vac\u00EDo = usar el umbral general.', String(cur));
  if (v === null) return;
  const t = String(v).trim();
  if (t === '') delete _anPrefs.minStock[id];
  else { const n = Number(t); if (!isFinite(n) || n < 0) return; _anPrefs.minStock[id] = Math.round(n); }
  anSavePrefs(_anPrefs);
}
function anPrefs() {
  if (!_anPrefs) _anPrefs = { deadDays: 60, lowStock: 3, minStock: {} };
  const dd = window.prompt('D\u00EDas sin venta para considerar un producto "muerto" (por defecto 60):', String(_anPrefs.deadDays != null ? _anPrefs.deadDays : 60));
  if (dd === null) return;
  const ls = window.prompt('Stock m\u00E1ximo que dispara la alerta "bajo" (por defecto 3):', String(_anPrefs.lowStock != null ? _anPrefs.lowStock : 3));
  if (ls === null) return;
  const a = Number(dd), b = Number(ls);
  if (!isFinite(a) || a < 7 || !isFinite(b) || b < 0) { alert('Valores no v\u00E1lidos.'); return; }
  _anPrefs.deadDays = Math.round(a);
  _anPrefs.lowStock = Math.round(b);
  _anDays = 0;
  anSavePrefs(_anPrefs);
}
function anSavePrefs(p) {
  api('/api/client/analytics-prefs', { method: 'PUT', body: JSON.stringify(p) }).then(function (d) {
    if (d && d.ok) { _anPrefs = d.prefs || p; loadAnalytics(0); }
    else alert('No se pudo guardar: ' + ((d && d.error) || 'sin respuesta'));
  }).catch(function (e) { alert('Error al guardar umbrales: ' + e.message); });
}
function anDrawChart() {
  const cv = document.getElementById('an-chart');
  if (!cv) return;
  if (!_anChartBound) { _anChartBound = true; window.addEventListener('resize', function () { if (_anData) anDrawChart(); }); }
  const w = Math.round(cv.clientWidth || 0);
  if (!w) { setTimeout(anDrawChart, 150); return; }
  const dpr = window.devicePixelRatio || 1;
  const h = 190;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const top = ((_anData && _anData.top) || []).slice(0, 10);
  if (!top.length) {
    ctx.fillStyle = '#a8b8cd';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sin ventas de mercanc\u00EDa en la ventana', Math.round(w / 2), Math.round(h / 2));
    return;
  }
  const max = Math.max.apply(null, top.map(function (t) { return t.units; }).concat([1]));
  const padL = 8, padR = 8, padT = 14, padB = 24;
  const cw = (w - padL - padR) / top.length;
  top.forEach(function (t, i) {
    const bh = Math.max(2, Math.round((t.units / max) * (h - padT - padB)));
    const x = Math.round(padL + i * cw + cw * 0.18);
    const bw = Math.max(2, Math.round(cw * 0.64));
    const y = h - padB - bh;
    ctx.fillStyle = i === 0 ? '#6366f1' : '#c7d2fe';
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(String(t.units), x + bw / 2, y - 4);
    ctx.fillStyle = '#a8b8cd';
    const nm = String(t.name || '');
    ctx.fillText(nm.length > 14 ? nm.slice(0, 13) + '\u2026' : nm, x + bw / 2, h - padB + 14);
  });
}`);

if (fails > 0) {
  console.log('ABORTADO: ' + fails + ' fallos. Archivo NO modificado.');
  process.exit(1);
}
if (eraCRLF) s = s.replace(/\n/g, '\r\n');
fs.writeFileSync(ARCHIVO, s, 'utf8');
console.log('Pestana Analiticas agregada. Guardado: ' + ARCHIVO);
