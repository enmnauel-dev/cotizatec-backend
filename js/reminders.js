// Recordatorios de cobros pendientes.
// Cada vez que se abre la app (y diariamente a las 9:00), revisa los trabajos
// con saldo pendiente y agenda una notificación única por trabajo según la
// antigüedad del saldo (7, 15, 30, 60 días...). Los IDs son estables por
// trabajo y por hito, de modo que un recordatorio ya notificado no se repite
// en el mismo día, pero sí en el siguiente hito.
var Reminders = (function () {
  var LS_KEY = 'cotizatec_reminders';
  var DAY = 86400000;

  // Hidratación base: cada recordatorio se agenda con estos hitos desde el
  // inicio del saldo (fecha del trabajo). Si ya se notificó un hito menor,
  // el siguiente se agenda en su propio día.
  var HITOS = [
    { days: 7, title: 'Cobro pendiente', body: 'Recuerda cobrar a {cliente}: debe {monto} desde hace 7 días.' },
    { days: 15, title: 'Cobro pendiente (15 días)', body: 'El cliente {cliente} debe {monto} desde hace 15 días.' },
    { days: 30, title: 'Cobro pendiente (30 días)', body: '{cliente} acumula un saldo de {monto} desde hace 30 días.' },
    { days: 60, title: 'Cobro pendiente (60 días)', body: 'Llevas 60 días sin cobrar {monto} a {cliente}. ¡Cóbralo!' },
    { days: 90, title: 'Cobro pendiente (90 días)', body: 'El saldo de {cliente} ({monto}) lleva 90 días sin cobrarse.' }
  ];

  function notifPlugin() {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  }

  function readState() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }

  function writeState(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch (e) {}
  }

  function money(n) {
    var c = (DB.state && DB.state.settings && DB.state.settings.currency) || 'RD$';
    var v = Number(n || 0);
    return c + ' ' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Devuelve la fecha de inicio del saldo del trabajo: la más antigua entre la
  // fecha del trabajo y la del primer pago (los abonos posteriores no reinician).
  function saldoInicio(j) {
    var base = j.date ? new Date(j.date).getTime() : Date.now();
    var pay = (j.payments || []);
    if (pay.length) {
      pay.forEach(function (p) {
        var t = p.date ? new Date(p.date).getTime() : Date.now();
        if (t < base) base = t;
      });
    }
    return base;
  }

  function pendientes() {
    if (typeof DB === 'undefined' || !DB.state) return [];
    return (DB.state.jobs || []).filter(function (j) {
      if (!j || j.status === 'CANCELADO') return false;
      return DB.jobTotals(j).balance > 0.005;
    });
  }

  // Agenda (o reprograma) los recordatorios de hoy. Devuelve el número agendado.
  function scheduleToday() {
    var n = notifPlugin();
    if (!n || !n.schedule) return 0;
    var now = new Date();
    var todayStr = now.toISOString().slice(0, 10);
    var state = readState();
    var today = (state.days || {})[todayStr] || {};
    var agendados = 0;

    pendientes().forEach(function (j) {
      var start = saldoInicio(j);
      var ageDays = Math.floor((Date.now() - start) / DAY);
      var balance = DB.jobTotals(j).balance;
      var client = j.clientName || 'el cliente';

      // El primer recordatorio es a los 7 días; si el saldo es más nuevo no agenda.
      HITOS.forEach(function (h) {
        if (ageDays < h.days) return;
        var key = String(j.id) + ':' + h.days;
        if (today[key]) return; // ya notificado hoy
        var when = new Date(now);
        when.setHours(9, 0, 0, 0);
        when.setDate(now.getDate() + 1); // mañana a las 9:00
        n.schedule({
          notifications: [{
            id: h.days * 1000 + (Number(String(j.id).replace(/\D/g, '').slice(0, 6)) || 0),
            title: h.title,
            body: h.body.replace('{cliente}', client).replace('{monto}', money(balance)),
            schedule: { at: when },
            sound: 'default'
          }]
        }).catch(function () {});
        today[key] = when.getTime();
        agendados++;
      });
    });

    state.days = state.days || {};
    state.days[todayStr] = today;
    writeState(state);
    return agendados;
  }

  // Cancela las notificaciones programadas de un trabajo (útil cuando el saldo
  // se salda o el trabajo se cancela). Devuelve true si había algo que cancelar.
  function cancelForJob(jobId) {
    var n = notifPlugin();
    if (!n || !n.cancel) return false;
    var ids = [];
    HITOS.forEach(function (h) {
      ids.push(h.days * 1000 + (Number(String(jobId).replace(/\D/g, '').slice(0, 6)) || 0));
    });
    n.cancel({ notifications: ids.map(function (id) { return { id: id }; }) }).catch(function () {});
    // limpia el estado del día actual para este trabajo
    var state = readState();
    var todayStr = new Date().toISOString().slice(0, 10);
    var today = (state.days || {})[todayStr] || {};
    HITOS.forEach(function (h) { delete today[String(jobId) + ':' + h.days]; });
    state.days = state.days || {};
    state.days[todayStr] = today;
    writeState(state);
    return true;
  }

  return { scheduleToday: scheduleToday, cancelForJob: cancelForJob, pendientes: pendientes, HITOS: HITOS, LS_KEY: LS_KEY };
})();