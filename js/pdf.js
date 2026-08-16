var PDF = (function () {
  const M = 15;
  const W = 210;
  const H = 297;
  const COL = [31, 41, 55];
  const ACCENT = [245, 158, 11];

  function money(n) {
    return DB.money(n);
  }

  function generate(job) {
    const st = DB.state.settings;
    const t = DB.jobTotals(job);
    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4' });

    let y = M;

    if (st.logo) {
      try {
        const prop = doc.getImageProperties(st.logo);
        const h = 20;
        const w = h * (prop.width / prop.height);
        if (w < W - M * 2) {
          doc.addImage(st.logo, 'PNG', M, y, w, h);
          y += h + 3;
        }
      } catch (e) {}
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    doc.text(st.businessName || 'Mi Negocio', M, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(110);
    const contact = [];
    if (st.phone) contact.push('Tel: ' + st.phone);
    if (st.address) contact.push(st.address);
    if (contact.length) {
      doc.text(contact.join('  •  '), M, y);
      y += 5;
    }

    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(M, y, W - M * 2, 0.6, 'F');
    y += 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.text(st.docTitle || 'COTIZACIÓN', M, y);
    doc.setFontSize(11);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    doc.text(job.code || '', W - M, y, { align: 'right' });
    y += 7;

    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.setFont('helvetica', 'bold');
    doc.text('Fecha:', M, y);
    doc.setFont('helvetica', 'normal');
    doc.text(DB.date(job.date, true), M + 13, y);
    doc.text('Válida por ' + (st.validityDays || 15) + ' días', M + 65, y);
    y += 6;

    doc.setFont('helvetica', 'bold');
    doc.text('Cliente:', M, y);
    doc.setFont('helvetica', 'normal');
    y += 4.5;
    doc.text(job.clientName || '—', M, y);
    y += 4.5;
    if (job.clientPhone) {
      doc.text('Tel: ' + job.clientPhone, M, y);
      y += 4.5;
    }
    y += 5;

    const head = [['Cant.', 'Descripción', 'Precio', 'Subtotal']];
    const body = (job.items || []).map(it => {
      const sub = (Number(it.qty) || 0) * (Number(it.price) || 0);
      return [
        String(Number(it.qty) || 0),
        String(it.desc || ''),
        money(it.price),
        money(sub)
      ];
    });

    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: head,
      body: body,
      theme: 'grid',
      styles: { fontSize: 9, cellPadding: 2.4, textColor: [55, 65, 81] },
      headStyles: { fillColor: COL, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      columnStyles: {
        0: { cellWidth: 14 },
        2: { cellWidth: 30, halign: 'right' },
        3: { cellWidth: 34, halign: 'right' }
      }
    });

    let yy = doc.lastAutoTable.finalY + 6;

    const lines = [];
    lines.push(['Subtotal', money(t.subtotal)]);
    if (t.discount > 0) lines.push(['Descuento', '-' + money(t.discount)]);
    lines.push(['ITBIS (' + t.itbis + '%)', money(t.tax)]);
    lines.push(['TOTAL', money(t.total)]);

    lines.forEach((ln, i) => {
      const isTotal = i === lines.length - 1;
      doc.setFont('helvetica', isTotal ? 'bold' : 'normal');
      doc.setFontSize(isTotal ? 13 : 10);
      doc.setTextColor(isTotal ? ACCENT[0] : 90, isTotal ? ACCENT[1] : 90, isTotal ? ACCENT[2] : 90);
      doc.text(ln[0], W - M - 55, yy);
      doc.text(ln[1], W - M, yy, { align: 'right' });
      yy += isTotal ? 7 : 5;
    });

    y = yy + 8;

    if (job.payments && job.payments.length) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(COL[0], COL[1], COL[2]);
      doc.text('Abonos / Pagos', M, y);
      y += 5;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(90);
      job.payments.forEach(function (p) {
        const label = (p.note ? String(p.note) + ' — ' : '') + DB.date(p.date);
        doc.text(label, M, y);
        doc.text(money(p.amount), W - M, y, { align: 'right' });
        y += 4.5;
      });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(COL[0], COL[1], COL[2]);
      doc.text('Total abonado', M, y);
      doc.text(money(t.collected), W - M, y, { align: 'right' });
      y += 4.5;
      doc.text('Saldo pendiente', M, y);
      doc.text(money(t.balance), W - M, y, { align: 'right' });
      y += 6;
    }

    if ((job.notes || '').trim()) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(COL[0], COL[1], COL[2]);
      doc.text('Notas:', M, y);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(90);
      const noteLines = doc.splitTextToSize(job.notes, W - M * 2);
      doc.text(noteLines, M, y + 4.5);
      y += 4.5 + noteLines.length * 4.5 + 4;
    }

    const fY = Math.min(H - 45, y + 26);
    doc.setDrawColor(150);
    doc.setLineWidth(0.3);
    doc.line(M, fY, 70, fY);
    doc.line(W - M - 55, fY, W - M, fY);

    function putSignature(dataUrl, x, maxW) {
      if (!dataUrl) return;
      try {
        const prop = doc.getImageProperties(dataUrl);
        if (!prop || !prop.width || !prop.height) return;
        let w = Math.min(maxW, 48);
        let h = w * (prop.height / prop.width);
        if (h > 12) { const k = 12 / h; h = 12; w = w * k; }
        doc.addImage(dataUrl, 'PNG', x, fY - h - 1.5, w, h, undefined, 'FAST');
      } catch (e) {}
    }
    putSignature(st.signature, M, 70 - M);
    putSignature(job.signature, W - M - 55, 55);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(120);
    doc.text('Firma del técnico', M, fY + 4);
    doc.text('Firma del cliente', W - M - 55, fY + 4);

    doc.setFontSize(8);
    doc.setTextColor(160);
    doc.text('Creado con CotizaTec — App de cotizaciones y gestión', W / 2, H - 10, { align: 'center' });

    return doc;
  }

  function report(opts) {
    const st = DB.state.settings;
    const r = opts.totals;
    const doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4' });

    let y = M;

    if (st.logo) {
      try {
        const prop = doc.getImageProperties(st.logo);
        const h = 18;
        const w = h * (prop.width / prop.height);
        if (w < W - M * 2) {
          doc.addImage(st.logo, 'PNG', M, y, w, h);
          y += h + 3;
        }
      } catch (e) {}
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(20);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    doc.text(st.businessName || 'Mi Negocio', M, y);
    y += 6;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(110);
    const contact = [];
    if (st.phone) contact.push('Tel: ' + st.phone);
    if (st.address) contact.push(st.address);
    if (contact.length) {
      doc.text(contact.join('  •  '), M, y);
      y += 5;
    }

    doc.setFillColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.rect(M, y, W - M * 2, 0.6, 'F');
    y += 6;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(ACCENT[0], ACCENT[1], ACCENT[2]);
    doc.text('REPORTE MENSUAL', M, y);
    doc.setFontSize(11);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    doc.text(opts.label || '', W - M, y, { align: 'right' });
    y += 8;

    doc.setFontSize(9);
    doc.setTextColor(90);
    doc.setFont('helvetica', 'bold');
    doc.text('Generado: ' + DB.date(new Date().toISOString(), true), M, y);
    y += 8;

    doc.setFillColor(245, 158, 11);
    doc.rect(M, y, W - M * 2, 0.6, 'F');
    y += 7;

    const rows = r.jobs.map(function (j) {
      const t = DB.jobTotals(j);
      return [j.code || '—', j.clientName || '—', DB.date(j.date), money(t.total), money(t.collected), money(t.balance)];
    });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    doc.text('Trabajos (' + r.count + ')', M, y);
    y += 4;

    doc.autoTable({
      startY: y,
      margin: { left: M, right: M },
      head: [['Código', 'Cliente', 'Fecha', 'Total', 'Cobrado', 'Debe']],
      body: rows,
      theme: 'grid',
      headStyles: { fillColor: [31, 41, 55], textColor: 255, fontSize: 8 },
      bodyStyles: { fontSize: 8, textColor: [31, 41, 55] },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      styles: { cellPadding: 1.5 }
    });

    y = doc.lastAutoTable.finalY + 10;

    doc.setFillColor(245, 158, 11);
    doc.rect(M, y, W - M * 2, 0.6, 'F');
    y += 7;

    const totales = [
      ['Facturado', money(r.facturado)],
      ['Cobrado en el mes', money(r.cobrado)],
      ['Por cobrar (debe)', money(r.porCobrar)],
      ['Gastado en materiales', money(r.gastado)],
      ['Ganancia', money(r.ganancia)]
    ];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(COL[0], COL[1], COL[2]);
    totales.forEach(function (row, i) {
      doc.text(row[0], M + 4, y);
      doc.setFont('helvetica', i === 4 ? 'bold' : 'normal');
      doc.text(row[1], W - M - 4, y, { align: 'right' });
      doc.setFont('helvetica', 'bold');
      y += 7;
    });

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(160);
    doc.text('Creado con CotizaTec — App de cotizaciones y gestión', W / 2, H - 10, { align: 'center' });

    return doc;
  }

  function reportBlob(opts) {
    const blob = report(opts).output('blob');
    blob.name = 'reporte-' + opts.month + '.pdf';
    return blob;
  }

  async function reportShare(opts) {
    if (isNative()) {
      return await saveNative(report(opts), 'reporte-' + opts.month + '.pdf');
    }
    const blob = reportBlob(opts);
    const file = new File([blob], blob.name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: blob.name });
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return true;
      }
    }
    const doc = report(opts);
    doc.save(blob.name);
    return false;
  }

  function toBlob(job) {
    const blob = generate(job).output('blob');
    blob.name = (job.code || 'cotizacion') + '.pdf';
    return blob;
  }

  function isNative() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }

  function nativePlugin(name) {
    return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) ||
      (window.Capacitor && window.Capacitor.registerPlugin ? window.Capacitor.registerPlugin(name) : null);
  }

  async function saveNative(doc, fname) {
    try {
      console.log('PDFSAVE_START ' + fname);
      const FS = nativePlugin('Filesystem');
      const SHARE = nativePlugin('Share');
      if (!FS || !SHARE) throw new Error('plugins Filesystem/Share no disponibles (' + !!FS + '/' + !!SHARE + ')');
      const b64 = doc.output('datauristring').split(',')[1];
      console.log('PDFSAVE_B64 len=' + (b64 ? b64.length : 0));
      await FS.writeFile({ path: fname, data: b64, directory: 'CACHE', recursive: false });
      const u = await FS.getUri({ path: fname, directory: 'CACHE' });
      console.log('PDFSAVE_URI ' + (u && u.uri));
      if (!u || !u.uri) throw new Error('no se obtuvo la URI del archivo');
      await SHARE.share({ title: fname, files: [u.uri], dialogTitle: 'CotizaTec — Guardar o compartir PDF' });
      console.log('PDFSAVE_DONE');
      return true;
    } catch (e) {
      console.error('PDFSAVE_ERR ' + (e && e.message) + '\n' + (e && e.stack));
      throw e;
    }
  }

  function download(job) {
    const doc = generate(job);
    const fname = (job.code || 'cotizacion') + '.pdf';
    if (isNative()) return saveNative(doc, fname);
    doc.save(fname);
    return Promise.resolve(true);
  }

  async function share(job) {
    if (isNative()) {
      return await saveNative(generate(job), (job.code || 'cotizacion') + '.pdf');
    }
    const blob = toBlob(job);
    const file = new File([blob], blob.name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: blob.name });
        return true;
      } catch (e) {
        if (e && e.name === 'AbortError') return true;
      }
    }
    download(job);
    return false;
  }

  return { generate, download, share, toBlob, report, reportShare, reportBlob };
})();