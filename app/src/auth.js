// Login de un único usuario admin. Contraseña hasheada con scrypt (crypto nativo).
// Formato del hash: scrypt$N$r$p$salt_b64$hash_b64
import crypto from 'node:crypto';
import { getDb } from './db.js';
import { settings } from './settings.js';

const KEYLEN = 64;
const SESSION_TTL_MS = 12 * 3600_000;
export const COOKIE = 'bn_sid';

export function hashPassword(password, { N = 32768, r = 8, p = 1 } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return ['scrypt', N, r, p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    // Igual gastamos tiempo para no filtrar si el hash está configurado.
    crypto.scryptSync('x', 'y', KEYLEN);
    return false;
  }
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password).normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2,
  });
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

function safeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function checkCredentials(user, password) {
  const userOk = safeEqualStr(user, settings.adminUser);
  const passOk = verifyPassword(password, settings.adminPasswordHash);
  return userOk && passOk;
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

export function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  getDb().prepare('INSERT INTO sessions(token_hash, expires_at) VALUES(?, ?)').run(sha(token), Date.now() + SESSION_TTL_MS);
  return { token, maxAge: SESSION_TTL_MS / 1000 };
}

export function validSession(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return false;
  const row = getDb().prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha(token));
  return Boolean(row && row.expires_at > Date.now());
}

export function destroySession(token) {
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

// ---------- límite de intentos de login (en memoria, por IP) ----------
const attempts = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

export function loginBlocked(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) {
    attempts.delete(ip);
    return false;
  }
  return a.count >= MAX_ATTEMPTS;
}

export function loginFailed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
  if (attempts.size > 10_000) attempts.clear();
}

export function loginSucceeded(ip) {
  attempts.delete(ip);
}
