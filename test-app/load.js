// Carga db.js y backup.js en Node usando el entorno simulado.
require('./env');
const fs = require('fs');
const path = require('path');

const JS_DIR = path.join(__dirname, '..', 'js');
function load(name) {
  const code = fs.readFileSync(path.join(JS_DIR, name), 'utf8');
  const fn = new Function(code);
  fn();
  return global;
}

// db.js define `DB` como variable local del IIFE... en realidad usa `var DB = (function(){...})()`.
// Con new Function, el `var DB` queda en el scope de esa función, no global. Para exponerlo,
// db.js debe ser ejecutado de forma que su `var` se cree en el ámbito global. Usamos vm.
const vm = require('vm');
const crypto = require('crypto').webcrypto;
const sandbox = {
  window: null,
  document: global.document,
  localStorage: global.localStorage,
  indexedDB: global.indexedDB,
  location: { hash: '', reload: function () {} },
  navigator: global.navigator,
  console: console,
  crypto: crypto,
  btoa: global.btoa,
  atob: global.atob,
  TextEncoder: global.TextEncoder,
  TextDecoder: global.TextDecoder,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Promise: Promise,
  Date: Date,
  Math: Math,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Boolean: Boolean,
  Error: Error,
  RegExp: RegExp,
  Buffer: Buffer,
  process: process,
  Util: global.Util,
  Media: global.Media,
  License: global.License,
  fetch: global.fetch,
  require: require
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'db.js'), 'utf8'), sandbox, { filename: 'db.js' });
vm.runInContext(fs.readFileSync(path.join(JS_DIR, 'backup.js'), 'utf8'), sandbox, { filename: 'backup.js' });

module.exports = sandbox;