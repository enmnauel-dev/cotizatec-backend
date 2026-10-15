// Impresion de tickets en impresoras termicas por Bluetooth (ESC/POS).
// Usa window.NativeBridge (MainActivity) expuesto a la app instalada de Android.
var Printer = (function () {
  function bridge() {
    try {
      if (window.NativeBridge && typeof window.NativeBridge.btPrint === 'function') return window.NativeBridge;
    } catch (e) {}
    return null;
  }

  function isNative() { return !!bridge(); }

  function available() { return !!bridge(); }

  function status() {
    var b = bridge();
    if (!b) return { supported: false, enabled: false, granted: false };
    try { return JSON.parse(b.btStatus() || '{}'); } catch (e) { return { supported: false, enabled: false, granted: false }; }
  }

  function ensureReady() {
    var b = bridge();
    if (!b) return Promise.reject(new Error('La impresion solo funciona en la app instalada'));
    var st = status();
    if (!st.supported) return Promise.reject(new Error('Este telefono no tiene Bluetooth'));
    if (!st.enabled) return Promise.reject(new Error('Activa el Bluetooth en tu telefono'));
    if (st.granted) return Promise.resolve();
    try { b.btRequestPermission(); } catch (e) {}
    return new Promise(function (resolve, reject) {
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        var s2 = status();
        if (s2.granted) { clearInterval(iv); resolve(); }
        else if (tries >= 15) { clearInterval(iv); reject(new Error('Concede el permiso de Bluetooth a CotizaTec y vuelve a intentar')); }
      }, 400);
    });
  }

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
    return this.text(s).lf();
  };
  Builder.prototype.feed = function (n) { return this.raw(0x1B, 0x64, n || 1); };
  Builder.prototype.cut = function () { return this.raw(0x1D, 0x56, 0x42, 0x00); };

  function buildTicket(job, cols) {
    cols = cols || 32;
    var st = DB.state.settings;
    var t = DB.jobTotals(job);
    var B = new Builder(cols);

    B.init();
    B.align(1).bold(true);
    var bn = normalize(st.businessName || 'Mi Negocio');
    var bnSize = bn.length <= Math.floor(cols / 2) ? 3 : (bn.length <= cols ? 1 : 0);
    if (bnSize) B.size(bnSize);
    B.text(bn).lf();
    B.size(0).bold(false);
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
    B.text(row('TOTAL', money(t.total), cols)).lf();
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

  function listDevices() {
    return ensureReady().then(function () {
      var b = bridge();
      var raw = b.btList() || '[]';
      if (raw.indexOf('ERR:') === 0) throw new Error(raw.slice(4));
      return JSON.parse(raw);
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
    return ensureReady().then(function () {
      var sv = getSaved();
      if (!sv.address) throw new Error('Primero selecciona tu impresora en Ajustes');
      var res = bridge().btPrint(sv.address, toBase64(bytes));
      if (res !== 'OK') {
        var msg = (res && res.indexOf('ERR:') === 0) ? res.slice(4) : (res || 'No se pudo imprimir');
        throw new Error(msg);
      }
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
    status: status,
    getSaved: getSaved,
    setSaved: setSaved,
    listDevices: listDevices,
    printTicket: printTicket,
    testPrint: testPrint,
    buildTicket: buildTicket
  };
})();
