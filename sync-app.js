// sync-app.js — regenera www/ (artefacto de build) desde la raiz (la fuente real)
const fs = require('fs');
const path = require('path');
const DEST = process.argv[2] || 'www';
const SRC = __dirname;
const files = ['index.html', 'manifest.json', 'sw.js'];
const dirs = [['css', 'css'], ['js', 'js'], ['lib', 'lib'], ['icon', 'icon']];
let copied = 0, equal = 0, missing = 0;
function syncFile(a, b) {
  const srcPath = path.join(SRC, a);
  const dstPath = path.join(DEST, b);
  if (!fs.existsSync(srcPath)) { console.log('SIN ORIGEN : ' + a); missing++; return; }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const srcBuf = fs.readFileSync(srcPath);
  if (fs.existsSync(dstPath) && fs.readFileSync(dstPath).equals(srcBuf)) { equal++; return; }
  fs.writeFileSync(dstPath, srcBuf);
  console.log('COPIADO    : ' + a + ' -> ' + b);
  copied++;
}
files.forEach(function (f) { syncFile(f, f); });
dirs.forEach(function (d) {
  const dir = path.join(SRC, d[0]);
  if (!fs.existsSync(dir)) { console.log('SIN CARPETA: ' + d[0]); missing++; return; }
  fs.readdirSync(dir).forEach(function (name) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) syncFile(path.join(d[0], name), path.join(d[1], name));
  });
});
console.log('---');
console.log('Copiados: ' + copied + ' | Iguales (no tocados): ' + equal + ' | Sin origen: ' + missing);
