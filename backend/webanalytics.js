// webanalytics.js - Analiticas, rotacion de inventario y alertas (solo lectura).
// No toca cotizaciones ni la app: trabaja sobre el estado ya descifrado del respaldo.
'use strict';

function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function money(v) { return Math.round(num(v) * 100) / 100; }

// Normalizador para emparejar por nombre (sin acentos, minusculas, espacios colapsados)
function normName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Dia calendario en America/Santo_Domingo como numero de dias desde el epoch
function dayNumRD(x) {
  const d = (x instanceof Date) ? x : new Date(x);
  if (isNaN(d.getTime())) return null;
  try {
    const p = d.toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' }).split('-');
    return Math.floor(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 86400000);
  } catch (e) {
    return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  }
}

function isSaleStatus(j) {
  const st = String(j.status || 'COTIZADO').toUpperCase();
  return st !== 'COTIZADO' && st !== 'CANCELADO';
}

function computeAnalytics(state, opts) {
  opts = opts || {};
  const deadDays = Math.min(3650, Math.max(7, num(opts.deadDays) || 60));
  const lowDefault = Math.min(999, Math.max(0, opts.lowStockDefault == null ? 3 : num(opts.lowStockDefault)));
  const minStockMap = (opts.minStock && typeof opts.minStock === 'object') ? opts.minStock : {};

  const today = dayNumRD(new Date());
  const jobs = state.jobs || [];
  const catalog = state.catalog || [];

  // Indice del catalogo: por id y por nombre normalizado (para items con catalogId null)
  const byId = {};
  const byName = {};
  catalog.forEach(function (p) {
    byId[String(p.id)] = p;
    const k = normName(p.name);
    if (k && !byName[k]) byName[k] = p;
  });

  // --- Pasada: ventas declaradas de TODO el historial (ultima venta por producto) ---
  const sold = {}; // id -> {units, lastSale, cogsKnown, costUnknown}
  const unmatched = {}; // desc normalizada -> {name, units, revenue, lastSale}
  let unidadesPeriodo = 0, facturadoProductos = 0, unidadesProducto = 0, unidadesServicio = 0;
  const winStart = today - deadDays;

  jobs.forEach(function (j) {
    if (!isSaleStatus(j)) return;
    const jd = dayNumRD(j.date);
    (j.items || []).forEach(function (i) {
      const q = num(i.qty);
      if (q <= 0) return;
      const rev = q * num(i.price);
      let p = byId[String(i.catalogId || '')];
      if (!p) p = byName[normName(i.desc || i.name || '')];
      if (String(i.type || (p && p.type) || '').toUpperCase() === 'SERVICIO') {
        unidadesServicio += q;
        return;
      }
      unidadesProducto += q;
      if (p) {
        const id = String(p.id);
        if (!sold[id]) sold[id] = { units: 0, lastSale: null, cogsKnown: 0, costUnknown: false };
        const s = sold[id];
        s.units += q;
        const unitCost = num(i.cost) || num(p.cost);
        if (unitCost > 0) s.cogsKnown += q * unitCost; else s.costUnknown = true;
        if (jd != null && (s.lastSale == null || jd > s.lastSale)) s.lastSale = jd;
      } else {
        const key = normName(i.desc || 'SIN NOMBRE');
        if (!unmatched[key]) unmatched[key] = { name: String(i.desc || 'Sin nombre'), units: 0, revenue: 0, lastSale: null };
        const u = unmatched[key];
        u.units += q; u.revenue += rev;
        if (jd != null && (u.lastSale == null || jd > u.lastSale)) u.lastSale = jd;
      }
      if (jd != null && jd >= winStart) { unidadesPeriodo += q; facturadoProductos += rev; }
    });
  });

  // --- Productos (mercancias; los servicios quedan fuera del stock) ---
  const productos = [];
  let agotados = 0, bajos = 0, muertos = 0;
  let valorInventario = 0, itemsSinCosto = 0;
  catalog.forEach(function (p) {
    const type = String(p.type || '').toUpperCase();
    if (type === 'SERVICIO') return;
    const stockNum = (p.stock == null || p.stock === '') ? null : num(p.stock);
    const id = String(p.id);
    const s = sold[id] || { units: 0, lastSale: null, cogsKnown: 0, costUnknown: false };
    const daysSinceSale = (s.lastSale == null) ? null : (today - s.lastSale);
    const enVentana = s.lastSale != null && s.lastSale >= winStart;
    const minEfectivo = (minStockMap[id] != null && isFinite(Number(minStockMap[id]))) ? num(minStockMap[id]) : lowDefault;

    let dead = false, low = false, out = false;
    const unitCost = num(p.cost) || 0;
    if (unitCost <= 0) itemsSinCosto++;   // margen ciego: sin costo, tenga o no stock
    if (stockNum != null) {
      if (stockNum <= 0) { out = true; agotados++; }
      else {
        if (stockNum <= minEfectivo) { low = true; bajos++; }
        if (!enVentana && (daysSinceSale == null || daysSinceSale >= deadDays)) { dead = true; muertos++; }
        if (unitCost > 0) valorInventario += stockNum * unitCost;
      }
    }

    const unitsPerDay = (enVentana && s.units > 0) ? s.units / deadDays : 0;
    productos.push({
      id: id, name: p.name, type: p.type || 'PRODUCTO',
      stock: stockNum, price: money(p.price), cost: money(p.cost),
      unitsWindow: enVentana ? s.units : 0,
      unitsAll: s.units,
      daysSinceSale: daysSinceSale,
      daysCover: (stockNum != null && stockNum > 0 && unitsPerDay > 0) ? Math.round(stockNum / unitsPerDay) : null,
      dead: dead, low: low, out: out,
      noCost: unitCost <= 0,
      marginUnknown: !!s.costUnknown
    });
  });

  // --- Top ventas de la ventana (por unidades) ---
  const top = productos
    .filter(function (x) { return x.unitsWindow > 0; })
    .sort(function (a, b) { return b.unitsWindow - a.unitsWindow; })
    .slice(0, 12)
    .map(function (x) {
      const s = sold[x.id];
      const rev = x.unitsWindow * x.price;
      const unitCostKnown = s && s.units > 0 && !s.costUnknown ? s.cogsKnown / s.units : null;
      return {
        id: x.id, name: x.name, units: x.unitsWindow,
        revenue: money(rev),
        margin: unitCostKnown != null ? money(rev - x.unitsWindow * unitCostKnown) : null,
        marginUnknown: unitCostKnown == null
      };
    });

  const sinCatalogo = Object.keys(unmatched)
    .map(function (k) { const u = unmatched[k]; return { name: u.name, units: u.units, revenue: money(u.revenue), lastSaleDaysAgo: u.lastSale == null ? null : (today - u.lastSale) }; })
    .sort(function (a, b) { return b.units - a.units; })
    .slice(0, 12);

  productos.sort(function (a, b) { return (b.stock || 0) - (a.stock || 0); });

  return {
    window: { days: deadDays, label: 'Ultimos ' + deadDays + ' dias' },
    alerts: { agotados: agotados, bajos: bajos, muertos: muertos, sinCatalogo: sinCatalogo.length },
    kpis: {
      valorInventario: money(valorInventario),
      itemsSinCosto: itemsSinCosto,
      unidadesPeriodo: unidadesPeriodo,
      facturadoProductos: money(facturadoProductos)
    },
    mix: { unidadesProducto: unidadesProducto, unidadesServicio: unidadesServicio },
    top: top,
    sinCatalogo: sinCatalogo,
    productos: productos
  };
}

module.exports = { computeAnalytics: computeAnalytics, normName: normName };