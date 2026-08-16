// Tests automatizados de la lógica de la app (db.js + backup.js)
// Ejecutar: node test-app/run-tests.js
const s = require('./load');

const DB = s.DB;
const Backups = s.Backups;

let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FALLA: ' + label); }
}

function section(t) { console.log('\n' + t); }

async function main() {
  // ============ 1. BUG CATÁLOGO: itemTypes legacy (objeto) -> array ============
  section('1) normalize(): itemTypes legacy {MO,REP} se convierte a array');
  {
    const legacyState = {
      format: 'cotizatec-backup',
      version: 1,
      data: {
        settings: {
          itemTypes: { MO: 'SERVICIO', REP: 'PRODUCTO' },
          businessName: 'Taller Test',
          docTitle: 'COTIZACIÓN'
        },
        catalog: [
          { id: 'c1', name: 'Servicio instalación', price: 1500, type: 'MO' },
          { id: 'c2', name: 'Producto muestra', price: 2500, type: 'REP' }
        ],
        clients: [],
        jobs: [],
        seq: { client: 0, catalog: 2, job: 0, expense: 0, payment: 0 }
      }
    };
    const d = DB.parseBackup(JSON.stringify(legacyState));
    ok(!!d, 'parseBackup acepta el respaldo legacy');
    DB.applyBackup(d);
    ok(Array.isArray(DB.state.settings.itemTypes), 'itemTypes quedó como array');
    ok(Array.isArray(DB.state.settings.itemTypes) && DB.state.settings.itemTypes.length > 0, 'array itemTypes no vacío');
    const cat = DB.state.catalog;
    ok(cat.length === 2, 'catálogo conserva sus 2 ítems');
    ok(cat.every(function (i) { return i.type === 'SERVICIO' || i.type === 'PRODUCTO'; }), 'los tipos legacy MO/REP se mapearon a SERVICIO/PRODUCTO');
    ok(DB.state.settings.itemTypes.every(function (t) { return typeof t.label === 'string' && t.id; }), 'cada tipo tiene id y label (estructura correcta para renderizar chips)');
  }

  // ============ 2. doReset: borra los 3 almacenes ============
  section('2) doReset(): borra localStorage y deja arrancar en blanco');
  {
    // Guardar algo primero
    DB.state = {
      settings: { itemTypes: [{ id: 'SERVICIO', label: 'Servicio', icon: 'tools' }], docTitle: 'X', businessName: 'Y' },
      catalog: [{ id: 'c1', name: 'A', price: 1, type: 'SERVICIO' }],
      clients: [{ id: 'cl1', name: 'Cliente' }],
      jobs: [],
      seq: { client: 1, catalog: 1, job: 0, expense: 0, payment: 0 }
    };
    DB.save(true);
    ok(!!global.localStorage.getItem(DB.KEY), 'estado guardado en localStorage antes del reset');

    Backups.doReset();
    ok(!global.localStorage.getItem(DB.KEY), 'localStorage KEY vacío tras doReset');
    ok(!global.localStorage.getItem(DB.BAK_KEY), 'localStorage BAK vacío tras doReset');
    ok(!global.localStorage.getItem(DB.TS_KEY), 'localStorage TS vacío tras doReset');
    ok(!global.localStorage.getItem(DB.ENC_META), 'localStorage ENC_META vacío tras doReset');
  }

  // ============ 3. Cifrado del respaldo manual con contraseña ============
  section('3) encryptBackupJson / decryptBackupJson');
  {
    const json = JSON.stringify({ data: 'hola', n: 42, arr: [1, 2, 3] });
    const enc = await DB.encryptBackupJson(json, 'clave123');
    ok(typeof enc === 'string', 'encryptBackupJson devuelve texto');
    const parsed = JSON.parse(enc);
    ok(parsed.format === 'cotizatec-backup-enc', 'formato es cotizatec-backup-enc');
    ok(parsed.salt && parsed.iv && parsed.ct, 'tiene salt, iv y ct');
    const dec = await DB.decryptBackupJson(enc, 'clave123');
    ok(dec === json, 'descifra y recupera el JSON original');
    let badPass = false;
    try { await DB.decryptBackupJson(enc, 'clave-incorrecta'); } catch (e) { badPass = (e && e.message === 'bad-pass'); }
    ok(badPass, 'contraseña incorrecta lanza bad-pass');
  }

  // ============ 4. Ciclo completo backup manual ============
  section('4) buildBackup -> encrypt -> decrypt -> parseBackup');
  {
    const json = DB.buildBackup();
    ok(typeof json === 'string' && json.length > 50, 'buildBackup genera JSON');
    const enc = await DB.encryptBackupJson(json, 'mi-clave');
    const dec = await DB.decryptBackupJson(enc, 'mi-clave');
    const d = DB.parseBackup(dec);
    ok(!!d, 'el respaldo cifrado/descifrado se parsea correctamente');
    ok(Array.isArray(d.catalog) && Array.isArray(d.clients) && Array.isArray(d.jobs), 'estructura del backup válida');
  }

  summary();
}

function summary() {
  console.log('\n==================================');
  console.log('RESULTADO: ' + passed + ' pasaron, ' + failed + ' fallaron');
  console.log('==================================');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('\n⏰ ERROR NO ESPERADO: ' + (e && e.stack || e));
  process.exit(1);
});