const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const out = { publicKey: pub, privateKey: priv };
fs.writeFileSync(path.join(__dirname, '..', 'keys.json'), JSON.stringify(out, null, 2));

console.log('Claves Ed25519 generadas en backend/keys.json');
console.log('Copia sus valores a .env como LICENSE_PUBLIC_KEY y LICENSE_PRIVATE_KEY');
console.log('');
console.log('LICENSE_PUBLIC_KEY=' + JSON.stringify(pub.replace(/\n/g, '\\n')));
console.log('LICENSE_PRIVATE_KEY=' + JSON.stringify(priv.replace(/\n/g, '\\n')));