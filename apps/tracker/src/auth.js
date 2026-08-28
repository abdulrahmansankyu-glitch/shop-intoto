/**
 * Accounts, sessions and permissions.
 *
 * Passwords are hashed with scrypt from Node's own crypto — no dependency, and a
 * deliberately slow function, so a stolen database is not a list of passwords.
 * Sessions are signed tokens rather than server-side session rows: this app runs
 * as a single free-tier process that sleeps and restarts, and a restart should
 * not sign the whole team out.
 *
 * Three roles, because a plant team is not an org chart:
 *
 *   viewer  — read the registers and export them
 *   editor  — everything a viewer can do, plus add, edit, delete and import
 *   admin   — everything, plus managing who has an account and what they can do
 *
 * On top of the role, an account can be limited to particular registers. Someone
 * who only ever touches IWS and Action Notice should not be able to replace the
 * whole PDM register with a mis-picked sheet.
 */

import {
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export const ROLES = ['viewer', 'editor', 'admin'];

/** What each role is allowed to do. Higher roles include everything below. */
const CAPABILITIES = {
  viewer: new Set(['read']),
  editor: new Set(['read', 'write']),
  admin: new Set(['read', 'write', 'manage']),
};

export const ROLE_DESCRIPTIONS = {
  viewer: 'Can see every register and export to Excel. Cannot change anything.',
  editor: 'Can add, edit and delete entries, and import Excel files.',
  admin: 'Everything an editor can do, plus managing accounts and permissions.',
};

export function can(user, capability) {
  if (!user || user.active === false) return false;
  return CAPABILITIES[user.role]?.has(capability) ?? false;
}

/**
 * Whether `user` may touch `registerId`.
 *
 * An empty `registers` list means every register — the common case, and the
 * default for a new account, so restriction is something you opt into.
 */
export function canUseRegister(user, registerId) {
  if (!user) return false;
  if (!registerId) return true;
  const allowed = user.registers ?? [];
  return allowed.length === 0 || allowed.includes(registerId);
}

/** The registers this account may work with, resolved against the full list. */
export function visibleRegisters(user, allRegisterIds) {
  const allowed = user?.registers ?? [];
  return allowed.length === 0 ? allRegisterIds : allRegisterIds.filter((id) => allowed.includes(id));
}

// ------------------------------------------------------------- passwords ---

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;

  const candidate = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  const known = Buffer.from(expected, 'hex');
  // Length check first: timingSafeEqual throws on a mismatch rather than returning false.
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}

/** Minimum that is worth enforcing without becoming the reason people write it on a note. */
export function passwordProblem(password) {
  const value = String(password ?? '');
  if (value.length < 8) return 'Use at least 8 characters.';
  if (/^\d+$/.test(value)) return 'Use something other than only digits.';
  if (['password', '12345678', 'qwertyui'].includes(value.toLowerCase())) {
    return 'That password is too common — pick another.';
  }
  return null;
}

// ---------------------------------------------------------------- tokens ---

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * How long a password confirmation lasts before Settings asks again.
 *
 * Short on purpose: the point is that an unattended, still-signed-in browser
 * cannot be used to change who has access. Long enough to finish adding a few
 * accounts without retyping between each one.
 */
export const CONFIRM_TTL_MS = 15 * 60 * 1000;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * `purpose` keeps the two kinds of token apart. A session token must not be
 * usable as a password confirmation — otherwise merely being signed in would
 * satisfy the check that exists precisely because being signed in is not enough.
 */
export function signToken(userId, secret, ttlMs = TOKEN_TTL_MS, purpose = 'session') {
  const body = b64url(JSON.stringify({ sub: userId, exp: Date.now() + ttlMs, pur: purpose }));
  return `${body}.${sign(body, secret)}`;
}

/** Returns the user id, or null when the token is absent, forged, expired or of the wrong kind. */
export function verifyToken(token, secret, purpose = 'session') {
  const [body, signature] = String(token ?? '').split('.');
  if (!body || !signature) return null;

  const expected = sign(body, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload?.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    if ((payload.pur ?? 'session') !== purpose) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- users ---

export const normaliseEmail = (email) => String(email ?? '').trim().toLowerCase();

/**
 * Build a user row. Never returns the password in a shape that can leak.
 *
 * `phone` arrives already in E.164 — the caller normalises it, because turning
 * `055 123 4567` into `966551234567` needs to know which country to assume and
 * that is a deployment's decision, not this module's.
 */
export function buildUser({ name, email, phone = null, password, role = 'viewer', registers = [] }) {
  return {
    id: randomUUID(),
    name: String(name ?? '').trim().slice(0, 80),
    email: normaliseEmail(email),
    phone: phone || null,
    password_hash: hashPassword(password),
    role: ROLES.includes(role) ? role : 'viewer',
    registers,
    active: true,
    created_at: new Date().toISOString(),
    last_login_at: null,
  };
}

/** The shape sent to the browser — never includes the hash. */
export function toUserApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone ?? null,
    role: row.role,
    registers: row.registers ?? [],
    active: row.active !== false,
    createdAt: row.created_at ?? row.createdAt ?? null,
    lastLoginAt: row.last_login_at ?? row.lastLoginAt ?? null,
  };
}
