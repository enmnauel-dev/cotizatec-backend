var Media = (function () {
  function compressImage(dataUrl, maxW, cb) {
    const img = new Image();
    img.onload = function () {
      try {
        const w = img.width || 0;
        const h = img.height || 0;
        if (!w || !h) { cb(dataUrl); return; }
        const scale = Math.min(1, maxW / w);
        const tw = Math.max(1, Math.round(w * scale));
        const th = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = tw;
        c.height = th;
        const ctx = c.getContext('2d');
        if (!ctx) { cb(dataUrl); return; }
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, tw, th);
        ctx.drawImage(img, 0, 0, tw, th);
        let out = null;
        try { out = c.toDataURL('image/webp', 0.7); } catch (e) {}
        if (!out || out.length >= dataUrl.length) {
          try { out = c.toDataURL('image/jpeg', 0.75); } catch (e2) { out = null; }
        }
        if (out && out.length < dataUrl.length) cb(out); else cb(dataUrl);
      } catch (e) { cb(dataUrl); }
    };
    img.onerror = function () { cb(dataUrl); };
    img.src = dataUrl;
  }

  function recompressExisting() {
    const s = DB.state.settings;
    if (s.logo && s.logo.length > 30000) {
      compressImage(s.logo, 400, function (r) {
        if (r !== s.logo) { s.logo = r; DB.save(); }
      });
    }
    if (s.signature && s.signature.length > 30000) {
      compressImage(s.signature, 360, function (r) {
        if (r !== s.signature) { s.signature = r; DB.save(); }
      });
    }
  }

  const api = {};
  Object.assign(api, { compressImage, recompressExisting });
  return api;
})();