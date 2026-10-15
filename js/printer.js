// Impresion de tickets en impresoras termicas por Bluetooth (ESC/POS).
// Requiere el plugin nativo "BluetoothPrinter" (android/app/src/main/java/.../BluetoothPrinterPlugin.java).
var Printer = (function () {
  function plugin() {
    try {
      if (!window.Capacitor) return null;
      if (window.Capacitor.Plugins && window.Capacitor.Plugins.BluetoothPrinter) return window.Capacitor.Plugins.BluetoothPrinter;
      if (window.Capacitor.registerPlugin) return window.Capacitor.registerPlugin('BluetoothPrinter');
    } catch (e) {}
    return null;
  }

  function isNative() {
    try { return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); } catch (e) { return false; }
  }

  function available() { return isNative() && !!plugin(); }

  // La mayoria de impresoras termicas no manejan acentos bien sin configurar code page.
  function normalize(s) {
    var out = String(s == null ? '' : s);
    if (out.normalize) out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    out = out
      .replace(/[\u2018\u2019\u201B]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2022/g, '*')
      .replace(/\u00A0/g, ' ');
    return out;
  }

  function money(n) { return DB.money(n); }

  // Arma una fila de dos columnas: texto a la izquierda, valor a la derecha.
  function row(left, right, cols) {
    left = normalize(left);
    right = normalize(right);
    var maxLeft = cols - right.length - 1;
    if (maxLeft < 1) maxLeft = 1;
    if (left.length > maxLeft) left = left.slice(0, maxLeft);
    var pad = cols - left.length - right.length;
    if (pad < 1) pad = 1;
    return left + new Array(pad + 1).join(' ') + right;
  }

  // Parte un texto largo en lineas de ancho "cols".
  function wrap(text, cols) {
    text = normalize(text).replace(/\s+/g, ' ').trim();
    if (!text) return [''];
    var words = text.split(' ');
    var lines = [], cur = '';
    words.forEach(function (w) {
      while (w.length > cols) {
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, cols));
        w = w.slice(cols);
      }
      if (!cur) cur = w;
      else if ((cur + ' ' + w).length <= cols) cur += ' ' + w;
      else { lines.push(cur); cur = w; }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  // ---- Constructor de bytes ESC/POS ----
  function Builder(cols) {
    this.b = [];
    this.cols = cols || 32;
  }
  Builder.prototype.raw = function () {
    for (var i = 0; i < arguments.length; i++) this.b.push(arguments[i] & 0xFF);
    return this;
  };
  Builder.prototype.init = function () { return this.raw(0x1B, 0x40); };
  Builder.prototype.align = function (a) { return this.raw(0x1B, 0x61, a); }; // 0 izq, 1 centro, 2 der
  Builder.prototype.bold = function (on) { return this.raw(0x1B, 0x45, on ? 1 : 0); };
  Builder.prototype.size = function (which) {
    // 0 normal, 1 doble alto, 2 doble ancho, 3 doble ambos
    var n = which === 3 ? 0x11 : which === 2 ? 0x10 : which === 1 ? 0x01 : 0x00;
    return this.raw(0x1D, 0x21, n);
  };
  Builder.prototype.text = function (s) {
    s = normalize(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      this.b.push(c < 256 ? c : 63);
    }
    return this;
  };
  Builder.prototype.lf = function () { this.b.push(0x0A); return this; };
  Builder.prototype.line = function (ch) {
    var s = '';
    for (var i = 0; i < this.cols; i++) s += (ch || '-');
    return this.text(s);
  };
  Builder.prototype.feed = function (n) { return this.raw(0x1B, 0x64, n || 1); };
  Builder.prototype.cut = function () { return this.raw(0x1D, 0x56, 0x42, 0x00); };

  function buildTicket(job, cols) {
    cols = cols || 32;
    var st = DB.state.settings;
    var t = DB.jobTotals(job);
    var B = new Builder(cols);

    B.init();
    B.align(1).bold(true).size(3).text(st.businessName || 'Mi Negocio').lf().size(0).bold(false);
    if (st.phone) B.text('Tel: ' + st.phone).lf();
    if (st.address) B.text(st.address).lf();
    B.line('-');

    B.align(0).bold(true).text((st.docTitle || 'COTIZACION') + '  ' + (job.code || '')).lf().bold(false);
    B.text('Fecha: ' + DB.date(job.date, true)).lf();
    B.text('Cliente: ' + (job.clientName || '-')).lf();
    if (job.clientPhone) B.text('Tel cliente: ' + job.clientPhone).lf();
    B.line('-');

    (job.items || []).forEach(function (it) {
      var qty = Number(it.qty) || 0;
      var sub = qty * (Number(it.price) || 0);
      var totalStr = money(sub);
      var leftW = cols - totalStr.length - 1;
      if (leftW < 1) leftW = 1;
      var lines = wrap(qty + ' x ' + (it.desc || ''), leftW);
      lines.forEach(function (ln, i) {
        B.text(ln);
        if (i === lines.length - 1) {
          var pad = cols - ln.length - totalStr.length;
          if (pad < 1) pad = 1;
          B.text(new Array(pad + 1).join(' ')).text(totalStr);
        }
        B.lf();
      });
    });
    B.line('-');

    B.text(row('Subtotal', money(t.subtotal), cols)).lf();
    if (t.discount > 0) B.text(row('Descuento', '-' + money(t.discount), cols)).lf();
    if (t.tax > 0) B.text(row('ITBIS (' + t.itbis + '%)', money(t.tax), cols)).lf();
    B.bold(true).size(1).text(row('TOTAL', money(t.total), cols)).lf().size(0).bold(false);
    if (t.collected > 0) {
      B.text(row('Abonado', money(t.collected), cols)).lf();
      B.text(row('Saldo', money(t.balance), cols)).lf();
    }

    if ((job.notes || '').trim()) {
      B.line('-');
      wrap(job.notes, cols).forEach(function (l) { B.text(l).lf(); });
    }

    B.line('-');
    B.align(1).text('Gracias por su preferencia').lf().text('CotizaTec').lf().align(0);
    B.feed(3).cut();
    return B.b;
  }

  function toBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function checkReady() {
    return plugin().checkPermissions().then(function (st) {
      if (!st) throw new Error('Bluetooth no disponible');
      if (!st.supported) throw new Error('Este dispositivo no tiene Bluetooth');
      if (!st.enabled) throw new Error('Activa el Bluetooth en tu telefono');
      if (!st.granted) {
        return plugin().requestPermissions().then(function (st2) {
          if (!st2 || !st2.granted) throw new Error('Concede el permiso de Bluetooth a CotizaTec');
          return st2;
        });
      }
      return st;
    });
  }

  function listDevices() {
    return checkReady().then(function () {
      return plugin().listDevices();
    }).then(function (r) {
      return (r && r.devices) || [];
    });
  }

  function getSaved() {
    var s = (DB.state && DB.state.settings) || {};
    var cols = parseInt(s.printerCols, 10);
    return {
      address: s.printerAddress || '',
      name: s.printerName || '',
      cols: cols === 48 ? 48 : 32
    };
  }

  function setSaved(dev, cols) {
    var s = DB.state.settings;
    s.printerAddress = dev.address || '';
    s.printerName = dev.name || '';
    if (cols) s.printerCols = cols;
    DB.save();
  }

  function printBytes(bytes) {
    return checkReady().then(function () {
      var sv = getSaved();
      if (!sv.address) throw new Error('Primero selecciona tu impresora en Ajustes');
      return plugin().connect({ address: sv.address });
    }).then(function () {
      return plugin().print({ data: toBase64(bytes) });
    }).then(function () {
      return plugin().disconnect().catch(function () {});
    }).catch(function (e) {
      try { plugin().disconnect(); } catch (x) {}
      throw new Error((e && e.message) ? e.message : 'No se pudo imprimir');
    });
  }

  function printTicket(job) {
    if (!available()) return Promise.reject(new Error('La impresion solo funciona en la app instalada'));
    return printBytes(buildTicket(job, getSaved().cols));
  }

  function testPrint() {
    if (!available()) return Promise.reject(new Error('La impresion solo funciona en la app instalada'));
    var cols = getSaved().cols;
    var B = new Builder(cols);
    B.init().align(1).bold(true).size(3).text('CotizaTec').lf().size(0).bold(false);
    B.text('Prueba de impresora').lf();
    B.text(normalize(new Date().toLocaleString())).lf();
    B.line('-').text('Si ves este ticket, todo funciona!').lf();
    B.feed(3).cut();
    return printBytes(B.b);
  }

  return {
    available: available,
    isNative: isNative,
    getSaved: getSaved,
    setSaved: setSaved,
    listDevices: listDevices,
    checkReady: checkReady,
    printTicket: printTicket,
    testPrint: testPrint,
    buildTicket: buildTicket
  };
})();
