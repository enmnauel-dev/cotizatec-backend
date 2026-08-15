const crypto = require('crypto');

let PRIVATE_KEY = process.env.LICENSE_PRIVATE_KEY || '';
let PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY || '';

function setKeys(pub, priv) {
  if (pub) PUBLIC_KEY = normalizePem(pub);
  if (priv) PRIVATE_KEY = normalizePem(priv);
}

function normalizePem(pem) {
  if (!pem) return '';
  return String(pem)
    .replace(/^["']|["']$/g, '')
    .replace(/\\n/g, '\n')
    .trim();
}

function loadKeysFromFile() {
  try {
    const fs = require('fs');
    const path = require('path');
    const k = JSON.parse(fs.readFileSync(path.join(__dirname, 'keys.json'), 'utf8'));
    PUBLIC_KEY = k.publicKey;
    PRIVATE_KEY = k.privateKey;
    return true;
  } catch (e) {
    return false;
  }
}

function tryLoadKeys() {
  if (PRIVATE_KEY && PUBLIC_KEY) return true;
  if (loadKeysFromFile()) return true;
  return false;
}

function signLicense(payload) {
  const data = JSON.stringify(payload);
  let sig;
  try {
    sig = crypto.sign(null, Buffer.from(data), PRIVATE_KEY).toString('base64');
  } catch (e) {
    if (tryLoadKeys()) {
      sig = crypto.sign(null, Buffer.from(data), PRIVATE_KEY).toString('base64');
    } else {
      throw e;
    }
  }
  return Buffer.from(JSON.stringify({ d: data, s: sig })).toString('base64');
}

function verifyLicense(token) {
  try {
    const { d, s } = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    const ok = crypto.verify(null, Buffer.from(d), PUBLIC_KEY, Buffer.from(s, 'base64'));
    if (!ok) return null;
    return JSON.parse(d);
  } catch (e) {
    return null;
  }
}

module.exports = { setKeys, loadKeysFromFile, tryLoadKeys, signLicense, verifyLicense };