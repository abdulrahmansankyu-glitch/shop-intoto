/**
 * Engineering Activity Tracker — HTTP server.
 *
 * One process serves both the API and the browser app, so the team gets a single
 * URL to share and there is no cross-origin configuration to get wrong.
 *
 * Access is per-person: everyone signs in, and an admin decides what each account
 * may do — read only, edit, or administer — and which registers it may open.
 * Every change is recorded against the account that made it.
 *
 * A deployment with no accounts yet falls back to the shared `TRACKER_ACCESS_CODE`,
 * which is also what authorises creating the first admin. That keeps an existing
 * deployment working through the upgrade and stops whoever finds the URL first
 * from claiming it.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import multer from 'multer';

import {
  CONFIRM_TTL_MS,
  ROLES,
  ROLE_DESCRIPTIONS,
  buildUser,
  can,
  canUseRegister,
  hashPassword,
  normaliseEmail,
  passwordProblem,
  signToken,
  toUserApi,
  verifyPassword,
  verifyToken,
} from './auth.js';
import { buildWorkbook, inspectWorkbook, readSheet } from './excel.js';
import { buildReport } from './report.js';
import { nextRef } from './autonumber.js';
import { createMailer } from './mailer.js';
import {
  DEFAULT_REMINDER_CONFIG,
  WEEKDAYS,
  bandsSendingOn,
  normaliseConfig,
  planRun,
} from './reminders.js';
import { sanitiseData, summarise } from './query.js';
import {
  calendarOf,
  currentWeek,
  defaultRota,
  fillRota,
  normaliseRota,
  unfilledCount,
} from './rota.js';
import {
  AREA_OPTIONS,
  DUE_SOON_DAYS,
  PRIORITY_VALUES,
  REGISTERS,
  STATUSES,
  deriveRecord,
  getRegister,
  registerCatalogue,
} from './registers.js';
import { createStore, toRow } from './store.js';

// Re-exported so tests and the standalone build have one import for the dashboard.
export { summarise };

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

/** Uploaded workbooks awaiting confirmation, held between inspect and commit. */
const PENDING_UPLOADS = new Map();
const UPLOAD_TTL_MS = 30 * 60 * 1000;

function stashUpload(filename, buffer) {
  const token = randomUUID();
  PENDING_UPLOADS.set(token, { filename, buffer, at: Date.now() });
  for (const [key, value] of PENDING_UPLOADS) {
    if (Date.now() - value.at > UPLOAD_TTL_MS) PENDING_UPLOADS.delete(key);
  }
  return token;
}

/**
 * Who is doing this.
 *
 * The account on the request, once there is one. Before accounts existed the
 * name came from a header the browser filled in, which was fine when the only
 * gate was a shared code and nobody could be held to anything anyway.
 */
const actorOf = (req) => req.user?.name || String(req.get('x-user-name') ?? '').trim() || 'Unknown';

function asError(res, status, message) {
  return res.status(status).json({ error: message });
}

/**
 * Keep only real register ids. An empty list means "all registers", so a typo
 * that silently dropped every entry would read as unrestricted rather than as
 * the restriction somebody meant to apply.
 */
function sanitiseRegisters(input) {
  if (!Array.isArray(input)) return [];
  const known = new Set(REGISTERS.map((r) => r.id));
  return [...new Set(input.filter((id) => known.has(id)))];
}

export async function createApp(env = process.env, overrides = {}) {
  const store = await createStore(env);
  // Overridable so the reminder tests can assert on what would have been sent
  // without an SMTP server, and without a "pretend to send" branch inside the
  // route that production would then be running a variant of.
  const mailer = overrides.mailer ?? createMailer(env);
  const app = express();

  /**
   * The shared secret the scheduler presents to trigger a reminder run.
   *
   * The run endpoint cannot use a session: it is called by a cron job with no
   * browser and no password. Without a secret set, the endpoint stays closed to
   * unauthenticated callers rather than defaulting to open — an open trigger is
   * a way for anyone who finds the URL to email the whole team.
   */
  const reminderSecret = String(env.TRACKER_REMINDER_SECRET ?? '').trim();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '5mb' }));

  const accessCode = String(env.TRACKER_ACCESS_CODE ?? '').trim();
  const accessHash = accessCode
    ? createHash('sha256').update(accessCode).digest('hex')
    : null;

  /** Constant-time-ish comparison via hashing, so the code is never echoed back. */
  const codeMatches = (candidate) =>
    !accessHash ||
    createHash('sha256').update(String(candidate ?? '').trim()).digest('hex') === accessHash;

  /**
   * The secret that signs sessions.
   *
   * Taken from the environment when the operator sets one; otherwise generated
   * once and kept in the database. Generating it per boot would sign the whole
   * team out on every redeploy and every wake from sleep, which on a free
   * instance is several times a day.
   */
  let sessionSecret = String(env.TRACKER_SESSION_SECRET ?? '').trim();
  if (!sessionSecret) {
    sessionSecret = await store.getSetting('session_secret');
    if (!sessionSecret) {
      sessionSecret = randomUUID() + randomUUID();
      await store.setSetting('session_secret', sessionSecret);
    }
  }

  /** An admin seeded from the environment, for a deployment that starts locked. */
  if (env.TRACKER_ADMIN_EMAIL && env.TRACKER_ADMIN_PASSWORD && (await store.countUsers()) === 0) {
    await store.insertUser(
      buildUser({
        name: env.TRACKER_ADMIN_NAME || 'Administrator',
        email: env.TRACKER_ADMIN_EMAIL,
        password: env.TRACKER_ADMIN_PASSWORD,
        role: 'admin',
      }),
    );
    console.log('[tracker] created the first admin account from the environment');
  }

  /** Attach the signed-in account to the request, when there is a valid token. */
  const withUser = async (req, _res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token ? verifyToken(token, sessionSecret) : null;
    if (userId) {
      const found = await store.findUserById(userId);
      if (found && found.active !== false) req.user = toUserApi(found);
    }
    next();
  };
  app.use(withUser);

  /**
   * Require an account, unless nobody has created one yet.
   *
   * Before the first account exists the app is open, so the first person can set
   * themselves up; the setup route itself is what is guarded, by the team access
   * code. After that, everything needs a session.
   */
  const requireAccess = (capability) => async (req, res, next) => {
    if ((await store.countUsers()) === 0) {
      // No accounts yet: fall back to the shared code, so an existing deployment
      // keeps working right up until its owner creates the first login.
      if (!accessHash || codeMatches(req.get('x-access-code'))) return next();
      return asError(res, 401, 'Wrong or missing team access code.');
    }

    if (!req.user) return asError(res, 401, 'Please sign in.');
    if (capability && !can(req.user, capability)) {
      return asError(
        res,
        403,
        capability === 'manage'
          ? 'Only an admin can change accounts and permissions.'
          : 'Your account has view-only access. Ask an admin if you need to make changes.',
      );
    }

    // Managing accounts needs the password again, recently.
    //
    // Being signed in is not enough for the one screen that decides who gets in:
    // an admin who walks away from an unlocked browser would otherwise be leaving
    // the permissions open to whoever sits down next.
    if (capability === 'manage') {
      const confirmed = verifyToken(req.get('x-confirm-token'), sessionSecret, 'confirm');
      if (confirmed !== req.user.id) {
        return res.status(403).json({
          error: 'Confirm your password to open Settings.',
          needsConfirmation: true,
        });
      }
    }

    next();
  };

  /** Narrow a records query to the registers this account may see. */
  const scopeQuery = (req, query) => {
    const allowed = req.user?.registers ?? [];
    return allowed.length ? { ...query, registers: allowed.join(',') } : query;
  };

  const scopeRecords = (req, records) => {
    const allowed = req.user?.registers ?? [];
    return allowed.length ? records.filter((r) => allowed.includes(r.register)) : records;
  };

  /**
   * Whether this request may touch a register.
   *
   * No signed-in account means the deployment has no accounts yet — the shared
   * code is still the gate, and register restrictions have nobody to apply to.
   * Asking `canUseRegister` directly gets this wrong: with no user it answers
   * "no", which locked the pre-accounts path out of every register.
   */
  const mayUseRegister = (req, registerId) => !req.user || canUseRegister(req.user, registerId);

  /**
   * Who may see the change log.
   *
   * "Recent changes" is a supervision record — who edited what and when, across
   * the whole department. The team can already see the work itself in the
   * registers; what they do not need is each other's editing history. Admins
   * only, then.
   *
   * As elsewhere, no signed-in account means the deployment has no accounts yet
   * and there are no roles to apply.
   */
  const maySeeActivity = (req) => !req.user || can(req.user, 'manage');

  /** Refuse a register this account is not allowed to touch, and say so. */
  const allowRegister = (req, res, registerId) => {
    if (mayUseRegister(req, registerId)) return true;
    asError(res, 403, 'Your account does not have access to that register.');
    return false;
  };

  // ---- Open endpoints -----------------------------------------------------

  app.get('/api/health', async (_req, res) => {
    res.json({
      ok: true,
      storage: store.kind,
      registers: REGISTERS.length,
      // Named capabilities rather than a version string: this answers "is the
      // thing I just deployed actually running?" without anyone reading a log.
      features: [
        'accounts',
        'register-permissions',
        'settings-password-confirm',
        'pdf-report',
        'email-reminders',
      ],
      accounts: await store.countUsers(),
      mail: mailer.provider,
    });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      requiresAccessCode: Boolean(accessHash),
      storage: store.kind,
      dueSoonDays: DUE_SOON_DAYS,
      priorities: PRIORITY_VALUES,
      statuses: STATUSES,
      areas: AREA_OPTIONS,
      registers: registerCatalogue(),
    });
  });

  app.post('/api/session', (req, res) => {
    if (!codeMatches(req.body?.accessCode)) {
      return asError(res, 401, 'That team access code is not right.');
    }
    res.json({ ok: true });
  });

  // ---- Accounts -----------------------------------------------------------

  const issue = async (user) => {
    await store.updateUser(user.id, { last_login_at: new Date().toISOString() });
    return { token: signToken(user.id, sessionSecret), user: toUserApi(user) };
  };

  app.get('/api/auth/state', async (_req, res, next) => {
    try {
      res.json({
        needsSetup: (await store.countUsers()) === 0,
        // The first account is created with the team access code, so somebody who
        // merely finds the URL before its owner does cannot make themselves admin.
        requiresSetupCode: Boolean(accessHash),
        roles: ROLES.map((role) => ({ value: role, description: ROLE_DESCRIPTIONS[role] })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/setup', async (req, res, next) => {
    try {
      if ((await store.countUsers()) > 0) {
        return asError(res, 409, 'This tracker already has accounts. Sign in instead.');
      }
      if (!codeMatches(req.body?.accessCode)) {
        return asError(res, 401, 'That team access code is not right.');
      }

      const email = normaliseEmail(req.body?.email);
      if (!email.includes('@')) return asError(res, 400, 'Enter a valid email address.');

      const problem = passwordProblem(req.body?.password);
      if (problem) return asError(res, 400, problem);

      const user = await store.insertUser(
        buildUser({ name: req.body?.name, email, password: req.body.password, role: 'admin' }),
      );

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: user.name,
        action: 'account',
        register: null,
        recordId: null,
        summary: `${user.name} created the first admin account`,
        detail: {},
      });

      res.status(201).json(await issue(user));
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body?.email);
      const found = await store.findUserByEmail(email);

      // One message for a wrong email and a wrong password: telling them apart
      // turns the login form into a way to enumerate who works here.
      if (!found || !verifyPassword(req.body?.password ?? '', found.password_hash)) {
        return asError(res, 401, 'That email and password do not match.');
      }
      if (found.active === false) {
        return asError(res, 403, 'That account has been switched off. Ask an admin.');
      }

      res.json(await issue(found));
    } catch (error) {
      next(error);
    }
  });

  /** Re-check the signed-in account's own password, for Settings. */
  app.post('/api/auth/confirm', requireAccess('read'), async (req, res, next) => {
    try {
      if (!req.user) return asError(res, 401, 'Please sign in.');

      const found = await store.findUserById(req.user.id);
      if (!verifyPassword(req.body?.password ?? '', found.password_hash)) {
        return asError(res, 401, 'That password is not right.');
      }

      res.json({
        confirmToken: signToken(found.id, sessionSecret, CONFIRM_TTL_MS, 'confirm'),
        expiresInMs: CONFIRM_TTL_MS,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/auth/me', requireAccess('read'), (req, res) => {
    res.json({ user: req.user ?? null });
  });

  app.post('/api/auth/password', requireAccess('read'), async (req, res, next) => {
    try {
      if (!req.user) return asError(res, 401, 'Please sign in.');

      const found = await store.findUserById(req.user.id);
      if (!verifyPassword(req.body?.currentPassword ?? '', found.password_hash)) {
        return asError(res, 401, 'Your current password is not right.');
      }

      const problem = passwordProblem(req.body?.newPassword);
      if (problem) return asError(res, 400, problem);

      await store.updateUser(found.id, { password_hash: hashPassword(req.body.newPassword) });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ---- Managing the team --------------------------------------------------

  app.get('/api/users', requireAccess('manage'), async (_req, res, next) => {
    try {
      res.json({ users: (await store.listUsers()).map(toUserApi) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/users', requireAccess('manage'), async (req, res, next) => {
    try {
      const email = normaliseEmail(req.body?.email);
      if (!email.includes('@')) return asError(res, 400, 'Enter a valid email address.');
      if (await store.findUserByEmail(email)) {
        return asError(res, 409, 'Somebody already has an account with that email.');
      }

      const problem = passwordProblem(req.body?.password);
      if (problem) return asError(res, 400, problem);

      const user = await store.insertUser(
        buildUser({
          name: req.body?.name,
          email,
          password: req.body.password,
          role: req.body?.role,
          registers: sanitiseRegisters(req.body?.registers),
        }),
      );

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'account',
        register: null,
        recordId: null,
        summary: `Added ${user.name} as ${user.role}`,
        detail: {},
      });

      res.status(201).json(toUserApi(user));
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/users/:id', requireAccess('manage'), async (req, res, next) => {
    try {
      const found = await store.findUserById(req.params.id);
      if (!found) return asError(res, 404, 'That account no longer exists.');

      const patch = {};
      if (typeof req.body?.name === 'string') patch.name = req.body.name.trim().slice(0, 80);
      if (ROLES.includes(req.body?.role)) patch.role = req.body.role;
      if (Array.isArray(req.body?.registers)) patch.registers = sanitiseRegisters(req.body.registers);
      if (typeof req.body?.active === 'boolean') patch.active = req.body.active;

      if (req.body?.password) {
        const problem = passwordProblem(req.body.password);
        if (problem) return asError(res, 400, problem);
        patch.password_hash = hashPassword(req.body.password);
      }

      // Locking out the last admin would leave nobody able to unlock it — the one
      // change that cannot be undone from inside the app.
      const losingAdmin =
        found.role === 'admin' && (patch.role === 'viewer' || patch.role === 'editor' || patch.active === false);
      if (losingAdmin && (await countActiveAdmins(found.id)) === 0) {
        return asError(res, 400, 'This is the only admin. Make somebody else an admin first.');
      }

      const saved = await store.updateUser(found.id, patch);
      res.json(toUserApi(saved));
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/users/:id', requireAccess('manage'), async (req, res, next) => {
    try {
      const found = await store.findUserById(req.params.id);
      if (!found) return asError(res, 404, 'That account no longer exists.');
      if (found.id === req.user?.id) {
        return asError(res, 400, 'You cannot delete the account you are signed in with.');
      }
      if (found.role === 'admin' && (await countActiveAdmins(found.id)) === 0) {
        return asError(res, 400, 'This is the only admin. Make somebody else an admin first.');
      }

      await store.deleteUser(found.id);
      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'account',
        register: null,
        recordId: null,
        summary: `Removed the account for ${found.name}`,
        detail: {},
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  /** Active admins other than `excludeId`. */
  async function countActiveAdmins(excludeId) {
    const users = await store.listUsers();
    return users.filter((u) => u.role === 'admin' && u.active !== false && u.id !== excludeId).length;
  }

  // ---- Records ------------------------------------------------------------

  app.get('/api/records', requireAccess('read'), async (req, res, next) => {
    try {
      if (req.query.register && !allowRegister(req, res, req.query.register)) return;
      res.json(await store.list(scopeQuery(req, req.query)));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/records/:id', requireAccess('read'), async (req, res, next) => {
    try {
      const record = await store.get(req.params.id);
      if (!record) return asError(res, 404, 'That entry no longer exists.');
      res.json(record);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/records', requireAccess('write'), async (req, res, next) => {
    try {
      const register = getRegister(req.body?.register);
      if (!register) return asError(res, 400, 'Choose a register for this entry.');
      if (!allowRegister(req, res, register.id)) return;

      const data = sanitiseData(register, req.body?.data);
      if (!Object.keys(data).length) return asError(res, 400, 'Fill in at least one field.');

      const actor = actorOf(req);

      /**
       * Issue the number inside the same turn as the insert.
       *
       * The form shows the next number when it opens, but that is a preview,
       * not a reservation — somebody else may have saved in between. So the
       * number is worked out again here unless the person typed their own,
       * which the form reports by clearing `autoRef`.
       */
      const auto = register.autoNumber;
      const wantsAuto =
        auto && (req.body?.autoRef === true || !String(data[auto.field] ?? '').trim());

      const row = await allocateRef(async () => {
        if (wantsAuto) data[auto.field] = await suggestRef(register);
        const built = toRow({
          register: register.id,
          data,
          derived: deriveRecord(register, data),
          source: 'manual',
          actor,
        });
        await store.insertMany([built]);
        return built;
      });

      const saved = await store.get(row.id);

      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor,
        action: 'create',
        register: register.id,
        recordId: row.id,
        summary: `Added ${register.name}: ${saved?.title ?? saved?.ref ?? 'new entry'}`,
        detail: {},
      });

      res.status(201).json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/records/:id', requireAccess('write'), async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');

      const register = getRegister(existing.register);
      if (!register) return asError(res, 400, 'That entry belongs to an unknown register.');
      if (!allowRegister(req, res, register.id)) return;

      // A PATCH carries only the fields that changed, so unmentioned columns keep
      // their imported values. An explicit empty string clears a field.
      const incoming = req.body?.data ?? {};
      const merged = { ...existing.data };
      for (const [key, value] of Object.entries(incoming)) {
        if (value === null || value === '') delete merged[key];
        else merged[key] = value;
      }

      const data = sanitiseData(register, merged);
      const actor = actorOf(req);

      const row = toRow({
        id: existing.id,
        register: register.id,
        data,
        derived: deriveRecord(register, data),
        source: existing.source,
        actor,
        createdAt: existing.createdAt,
        createdBy: existing.createdBy,
      });

      const saved = await store.updateRow(row);

      const changed = Object.keys(incoming).filter(
        (key) => String(existing.data?.[key] ?? '') !== String(incoming[key] ?? ''),
      );

      if (changed.length) {
        await store.logActivity({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'update',
          register: register.id,
          recordId: existing.id,
          summary: `Updated ${register.name}: ${saved?.title ?? saved?.ref ?? existing.id}`,
          detail: { fields: changed },
        });
      }

      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/records/:id', requireAccess('write'), async (req, res, next) => {
    try {
      const existing = await store.get(req.params.id);
      if (!existing) return asError(res, 404, 'That entry no longer exists.');
      if (!allowRegister(req, res, existing.register)) return;

      await store.remove(req.params.id);
      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'delete',
        register: existing.register,
        recordId: existing.id,
        summary: `Deleted: ${existing.title ?? existing.ref ?? existing.id}`,
        detail: {},
      });

      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ---- Dashboard ----------------------------------------------------------

  app.get('/api/dashboard', requireAccess('read'), async (req, res, next) => {
    try {
      const registerFilter = req.query.register || null;
      if (registerFilter && !allowRegister(req, res, registerFilter)) return;
      const records = scopeRecords(req, await store.all(registerFilter));
      const summary = summarise(records);

      // A restricted account gets cards only for its own registers. Leaving the
      // others in showed a row of empty rings for work the reader cannot open,
      // which reads as "there is nothing there" rather than "this is not yours".
      summary.byRegister = summary.byRegister.filter((r) => mayUseRegister(req, r.id));

      res.json({
        ...summary,
        // Omitted rather than hidden in the browser: a payload that carries what
        // the reader may not see is one screenshot of the network tab away from
        // not being hidden at all.
        activity: maySeeActivity(req) ? await store.recentActivity(15) : [],
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/filters', requireAccess('read'), async (req, res, next) => {
    try {
      const records = scopeRecords(req, await store.all(req.query.register || null));
      const distinct = (key) =>
        [...new Set(records.map((r) => r[key]).filter(Boolean))].sort((a, b) =>
          String(a).localeCompare(String(b)),
        );
      res.json({
        actionBy: distinct('actionBy'),
        initiator: distinct('initiator'),
        area: distinct('area'),
        discipline: distinct('discipline'),
      });
    } catch (error) {
      next(error);
    }
  });

  // ---- Excel import -------------------------------------------------------

  app.post('/api/import/inspect', requireAccess('write'), upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) return asError(res, 400, 'Attach an .xlsx file to upload.');

      const inspection = await inspectWorkbook(req.file.buffer);
      const token = stashUpload(req.file.originalname, req.file.buffer);

      // Last month's choices for a file of this name, so a recurring upload does
      // not mean re-picking every sheet. Only a suggestion — the confirm step still
      // shows what will happen and the user can change any of it.
      const remembered = await store.findMapping(req.file.originalname);

      res.json({ token, filename: req.file.originalname, remembered, ...inspection });
    } catch (error) {
      if (error?.message?.match(/zip|corrupt|end of central directory/i)) {
        return asError(res, 400, 'That file could not be read as an Excel workbook (.xlsx).');
      }
      next(error);
    }
  });

  app.post('/api/import/commit', requireAccess('write'), async (req, res, next) => {
    try {
      const pending = PENDING_UPLOADS.get(req.body?.token);
      if (!pending) {
        return asError(res, 410, 'That upload has expired — please choose the file again.');
      }

      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      if (!selections.length) return asError(res, 400, 'Choose at least one sheet to import.');

      const actor = actorOf(req);
      const results = [];
      const cleared = new Set();

      for (const selection of selections) {
        const register = getRegister(selection.register);
        if (!register) {
          results.push({ sheet: selection.sheet, error: `Unknown register: ${selection.register}` });
          continue;
        }
        if (!mayUseRegister(req, register.id)) {
          results.push({ sheet: selection.sheet, error: `No access to ${register.name}` });
          continue;
        }

        let extracted;
        try {
          extracted = await readSheet(pending.buffer, selection.sheet, register.id);
        } catch (error) {
          results.push({ sheet: selection.sheet, error: error.message });
          continue;
        }

        // "Replace" clears the register once per upload, not once per sheet.
        // A workbook can carry several sheets for the same register — SHP and DCU
        // master sheets both feeding IWS — and clearing per sheet meant the second
        // one deleted the rows the first had just imported, leaving only the last
        // sheet's rows behind. The intent of "replace" is that this file is the
        // master copy for that register, so its sheets land together.
        let replaced = 0;
        if (selection.mode === 'replace' && !cleared.has(register.id)) {
          replaced = await store.clearRegister(register.id);
          cleared.add(register.id);
        }

        const source = `import:${pending.filename}`;
        const rows = extracted.rows.map((data) =>
          toRow({
            register: register.id,
            data,
            derived: deriveRecord(register, data),
            source,
            actor,
          }),
        );

        await store.insertMany(rows);

        results.push({
          sheet: selection.sheet,
          register: register.id,
          registerName: register.name,
          imported: rows.length,
          skippedBlankRows: extracted.skipped,
          replaced,
          mode: selection.mode === 'replace' ? 'replace' : 'append',
          undated: rows.filter((r) => !r.due_date).length,
        });

        await store.logActivity({
          id: randomUUID(),
          at: new Date().toISOString(),
          actor,
          action: 'import',
          register: register.id,
          recordId: null,
          summary: `Imported ${rows.length} rows into ${register.name} from ${pending.filename}`,
          detail: { sheet: selection.sheet, replaced, mode: selection.mode ?? 'append' },
        });
      }

      // The uploaded workbook is kept so anyone can download exactly what was
      // imported — the record the team asked for — along with the choices made,
      // which is what makes the next upload of the same file one click.
      try {
        await store.saveImport({
          id: randomUUID(),
          filename: pending.filename,
          uploadedAt: new Date().toISOString(),
          uploadedBy: actor,
          sizeBytes: pending.buffer.length,
          sheetNames: selections.map((sel) => sel.sheet),
          mapping: selections,
          results,
          content: pending.buffer,
        });
      } catch (error) {
        // A failure to archive the file must not undo an import that succeeded.
        console.error('[tracker] could not store the uploaded file:', error);
      }

      res.json({ results });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/imports', requireAccess('read'), async (req, res, next) => {
    try {
      const all = await store.listImports();
      // Each register page shows the files that landed in it, so "where did this
      // row come from?" is answered on the page holding the row.
      const register = req.query.register ? String(req.query.register) : null;
      const imports = register
        ? all.filter((entry) => (entry.results ?? []).some((r) => r.register === register))
        : all;
      res.json({ imports });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/imports/:id/file', requireAccess('read'), async (req, res, next) => {
    try {
      const file = await store.getImportFile(req.params.id);
      if (!file) return asError(res, 404, 'That file is no longer stored.');

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.send(Buffer.from(file.content));
    } catch (error) {
      next(error);
    }
  });

  // ---- PDF report ---------------------------------------------------------

  app.get('/api/report.pdf', requireAccess('read'), async (req, res, next) => {
    try {
      const records = scopeRecords(req, await store.all(null));
      const summary = summarise(records);
      summary.byRegister = summary.byRegister.filter((r) => mayUseRegister(req, r.id));

      const allowed = req.user?.registers ?? [];
      const pdf = await buildReport({
        summary,
        // Short codes: the attention table's register column is narrow, and
        // "CTS Recommendation" wrapped to three lines in it.
        registerNames: new Map(REGISTERS.map((r) => [r.id, r.short])),
        logo: (await store.getSetting('report_logo')) || null,
        logoRight: (await store.getSetting('report_logo_right')) || null,
        generatedBy: req.user?.name ?? null,
        // A restricted account's report must say what it covers, or it reads as
        // the whole department's position when it is only part of it.
        scopeNote: allowed.length
          ? `Covers ${allowed.map((id) => getRegister(id)?.name ?? id).join(', ')} only.`
          : null,
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="Engineering_Department_Updates_${new Date().toISOString().slice(0, 10)}.pdf"`,
      );
      res.send(pdf);
    } catch (error) {
      next(error);
    }
  });

  /**
   * The two logos printed on everything that leaves the app.
   *
   * Two, because these documents carry both the contractor's mark and the
   * client's — SANKYU at the left, Yasref at the right, as the team's own
   * workbooks do.
   *
   * They are uploaded rather than shipped in the repository. Nobody's trademark
   * belongs in somebody else's source tree, the files here are then whatever the
   * brand team actually issued rather than something redrawn from a screenshot,
   * and the next site to use this app supplies its own two without a code change.
   */
  const LOGO_SLOTS = { left: 'report_logo', right: 'report_logo_right' };

  const readLogos = async () => ({
    left: (await store.getSetting(LOGO_SLOTS.left)) || null,
    right: (await store.getSetting(LOGO_SLOTS.right)) || null,
  });

  app.get('/api/report/logo', requireAccess('read'), async (_req, res, next) => {
    try {
      const logos = await readLogos();
      // `logo` repeats the left slot so a browser still running the previous
      // build, which knows only about one, keeps working until it reloads.
      res.json({ ...logos, logo: logos.left });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/report/logo', requireAccess('manage'), async (req, res, next) => {
    try {
      const slot = req.body?.slot === 'right' ? 'right' : 'left';
      const key = LOGO_SLOTS[slot];
      const logo = req.body?.logo;

      if (logo === null || logo === '') {
        await store.setSetting(key, '');
        return res.json({ ok: true, slot, logo: null });
      }

      // A data URI, so a report needs nothing from the network when it prints.
      if (typeof logo !== 'string' || !/^data:image\/(png|jpeg|jpg);base64,/.test(logo)) {
        return asError(res, 400, 'Upload a PNG or JPG image.');
      }
      if (logo.length > 600_000) {
        return asError(res, 400, 'That image is too large — use one under about 400 KB.');
      }

      await store.setSetting(key, logo);
      res.json({ ok: true, slot });
    } catch (error) {
      next(error);
    }
  });

  // ---- Reference numbers --------------------------------------------------

  /**
   * Work out the next reference for a register that issues its own.
   *
   * Reads what has actually been stored rather than keeping a counter, so a row
   * imported from the sheet with a higher number is taken into account and the
   * app cannot drift out of step with the workbook.
   */
  const suggestRef = async (register, period) => {
    const rows = await store.all(register.id);
    const field = register.autoNumber.field;
    return nextRef(
      rows.map((row) => row.data?.[field]).filter(Boolean),
      { prefix: register.autoNumber.prefix, ...(period ? { period } : {}) },
    );
  };

  /**
   * Allocation is serialised, one at a time.
   *
   * "Read the highest, add one, insert" is a race: two people pressing Save in
   * the same second both read 18 and both write 19. Chaining the allocations
   * means the second read happens after the first insert has landed.
   *
   * This holds because the app runs as a single process. If it is ever scaled
   * to more than one instance, this needs a unique index on the number and a
   * retry — a promise chain cannot see across processes.
   */
  let refQueue = Promise.resolve();
  const allocateRef = (task) => {
    const result = refQueue.then(task, task);
    // Kept from rejecting so one failed allocation does not poison the queue.
    refQueue = result.catch(() => {});
    return result;
  };

  app.get('/api/registers/:id/next-ref', requireAccess('write'), async (req, res, next) => {
    try {
      const register = getRegister(req.params.id);
      if (!register?.autoNumber) return asError(res, 400, 'That register does not issue its own numbers.');
      if (!allowRegister(req, res, register.id)) return;
      res.json({ ref: await suggestRef(register), field: register.autoNumber.field });
    } catch (error) {
      next(error);
    }
  });

  // ---- Email reminders ----------------------------------------------------

  const loadReminderConfig = async () => {
    const raw = await store.getSetting('reminder_config');
    try {
      return normaliseConfig(raw ? JSON.parse(raw) : {});
    } catch {
      // Unparseable settings must not stop the app booting or the cron running;
      // the defaults are safe because `enabled` is false among them.
      return normaliseConfig({});
    }
  };

  const loadRuns = async () => {
    const raw = await store.getSetting('reminder_runs');
    try {
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  /** Newest first, and only the last twenty — this is a log, not an archive. */
  const recordRun = async (entry) => {
    const runs = [entry, ...(await loadRuns())].slice(0, 20);
    await store.setSetting('reminder_runs', JSON.stringify(runs));
    return runs;
  };

  /**
   * What would be sent today.
   *
   * Every reminder path goes through this — the preview, the scheduled run and
   * the manual run alike — so what the Settings screen shows is the computation
   * that sends, rather than a second implementation that can drift from it.
   */
  const buildPlan = async (config, today) =>
    planRun({
      records: await store.all(null),
      users: (await store.listUsers()).map(toUserApi),
      config,
      today,
    });

  /** Config, plus the transport's state — never its credentials. */
  app.get('/api/reminders', requireAccess('manage'), async (_req, res, next) => {
    try {
      const config = await loadReminderConfig();
      res.json({
        config,
        weekdays: WEEKDAYS,
        defaults: DEFAULT_REMINDER_CONFIG,
        bandsToday: bandsSendingOn(config),
        mail: {
          provider: mailer.provider,
          configured: mailer.configured,
          from: mailer.from || null,
          problem: mailer.problem,
        },
        scheduleConfigured: Boolean(reminderSecret),
        runs: await loadRuns(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/reminders', requireAccess('manage'), async (req, res, next) => {
    try {
      const config = normaliseConfig({ ...(await loadReminderConfig()), ...(req.body ?? {}) });
      await store.setSetting('reminder_config', JSON.stringify(config));
      await store.logActivity({
        id: randomUUID(),
        at: new Date().toISOString(),
        actor: actorOf(req),
        action: 'reminders',
        register: null,
        recordId: null,
        summary: config.enabled ? 'Turned daily reminders on' : 'Turned daily reminders off',
        detail: config,
      });
      res.json({ ok: true, config, bandsToday: bandsSendingOn(config) });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Exactly who would be emailed, and what each of them would get.
   *
   * `?date=` lets an admin ask "what goes out on Sunday?" without waiting for
   * Sunday — the weekly band is invisible on any other day, so without it the
   * feature cannot be checked on the day it is set up.
   */
  app.get('/api/reminders/preview', requireAccess('manage'), async (req, res, next) => {
    try {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date ?? ''))
        ? String(req.query.date)
        : undefined;
      const plan = await buildPlan(await loadReminderConfig(), date);
      res.json({
        date: plan.date,
        weekday: plan.weekday,
        bands: plan.bands,
        recipients: plan.recipients,
        skipped: plan.skipped,
        // The bodies are megabytes across a whole team; the preview needs the
        // shape of each message, and one sample to look at.
        messages: plan.messages.map(({ to, name, kind, counts, subject, registers }) => ({
          to,
          name,
          kind,
          counts,
          subject,
          registers,
        })),
        sample: plan.messages[0]?.html ?? null,
      });
    } catch (error) {
      next(error);
    }
  });

  /** One digest to the admin asking, whatever the schedule says — a smoke test. */
  app.post('/api/reminders/test', requireAccess('manage'), async (req, res, next) => {
    try {
      if (!mailer.configured) return asError(res, 400, mailer.problem);
      if (!req.user?.email) return asError(res, 400, 'Your account has no email address.');

      const config = await loadReminderConfig();
      // Forced on, so a test does not silently do nothing on a day when nothing
      // is due — "no email arrived" would be indistinguishable from a failure.
      const plan = await buildPlan({ ...config, sendWhenEmpty: true });
      const mine = plan.messages.find((m) => m.to === req.user.email.toLowerCase());
      if (!mine) return asError(res, 400, 'Your account is not among the reminder recipients.');

      try {
        await mailer.send({
          to: mine.to,
          subject: `[Test] ${mine.subject}`,
          html: mine.html,
          text: mine.text,
        });
      } catch (failure) {
        // Answered here rather than handed to `next()`. A mail server's refusal
        // is the entire result of pressing this button — the generic handler
        // turned "535 5.7.139, SMTP AUTH is off for this mailbox" into
        // "Something went wrong on the server", which is the one thing it
        // cannot afford to say while somebody is trying credentials.
        return asError(res, 502, String(failure?.message ?? failure));
      }
      res.json({ ok: true, to: mine.to, counts: mine.counts });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Send today's reminders.
   *
   * Called by the scheduler with the shared secret, or by an admin from
   * Settings. It is a POST because it sends mail — a GET would be run by every
   * link-preview crawler that ever saw the URL.
   *
   * Refuses to run twice on the same date unless forced, since a cron that
   * double-fires, or an admin pressing the button after the schedule already
   * ran, would otherwise send the team the same digest again.
   */
  app.post('/api/reminders/run', async (req, res, next) => {
    try {
      const presented = String(req.get('x-reminder-secret') ?? '').trim();
      const bySecret = Boolean(reminderSecret) && presented === reminderSecret;

      if (!bySecret) {
        if (presented) return asError(res, 401, 'Wrong reminder secret.');
        if (!req.user || !can(req.user, 'manage')) {
          return asError(res, 401, 'This endpoint needs the reminder secret, or an admin session.');
        }
        if (verifyToken(req.get('x-confirm-token'), sessionSecret, 'confirm') !== req.user.id) {
          return res.status(403).json({ error: 'Confirm your password first.', needsConfirmation: true });
        }
      }

      const config = await loadReminderConfig();
      if (!config.enabled && !req.body?.force) {
        return res.json({ ok: true, skipped: 'reminders are switched off', sent: 0 });
      }
      if (!mailer.configured) return asError(res, 400, mailer.problem);

      const plan = await buildPlan(config);
      const runs = await loadRuns();
      if (!req.body?.force && runs.some((r) => r.date === plan.date && r.sent > 0)) {
        return res.json({ ok: true, skipped: 'already sent today', date: plan.date, sent: 0 });
      }

      const { sent, failed } = await mailer.sendAll(plan.messages);
      const entry = {
        at: new Date().toISOString(),
        date: plan.date,
        weekday: plan.weekday,
        bands: plan.bands,
        trigger: bySecret ? 'schedule' : (req.user?.name ?? 'manual'),
        sent: sent.length,
        failed: failed.length,
        recipients: sent,
        errors: failed.slice(0, 5),
      };
      await recordRun(entry);
      await store.logActivity({
        id: randomUUID(),
        at: entry.at,
        actor: entry.trigger,
        action: 'reminders',
        register: null,
        recordId: null,
        summary: `Sent ${sent.length} reminder email${sent.length === 1 ? '' : 's'}${
          failed.length ? `, ${failed.length} failed` : ''
        }`,
        detail: entry,
      });

      res.json({ ok: true, ...entry, skippedRecipients: plan.skipped });
    } catch (error) {
      next(error);
    }
  });

  // ---- Excel export -------------------------------------------------------

  app.get('/api/export', requireAccess('read'), async (req, res, next) => {
    try {
      const requested = req.query.register ? String(req.query.register) : null;
      if (requested && !allowRegister(req, res, requested)) return;
      const registers = (requested ? [getRegister(requested)].filter(Boolean) : REGISTERS).filter(
        (r) => mayUseRegister(req, r.id),
      );
      if (!registers.length) return asError(res, 400, 'Unknown register.');

      const groups = [];
      for (const register of registers) {
        groups.push({ register, records: await store.all(register.id) });
      }

      const buffer = await buildWorkbook(groups, await readLogos());
      const stamp = new Date().toISOString().slice(0, 10);
      const name = requested
        ? `${registers[0].name.replace(/\s+/g, '_')}_${stamp}.xlsx`
        : `Engineering_Tracker_${stamp}.xlsx`;

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.send(Buffer.from(buffer));
    } catch (error) {
      next(error);
    }
  });

  /** An empty workbook with the right headers — the fastest way to start a register. */
  app.get('/api/template', requireAccess('read'), async (req, res, next) => {
    try {
      const register = getRegister(req.query.register);
      if (!register) return asError(res, 400, 'Unknown register.');

      const buffer = await buildWorkbook([{ register, records: [] }]);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${register.name.replace(/\s+/g, '_')}_template.xlsx"`,
      );
      res.send(Buffer.from(buffer));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/activity', requireAccess('read'), async (req, res, next) => {
    try {
      // Not `requireAccess('manage')`: that also demands the recent password
      // confirmation, which is right for changing who has access and far too
      // much for reading a list.
      if (!maySeeActivity(req)) {
        return asError(res, 403, 'Only an admin can see the change log.');
      }
      res.json({ activity: await store.recentActivity(60) });
    } catch (error) {
      next(error);
    }
  });


  // ---- Safety duty rota ---------------------------------------------------
  //
  // One JSON document in `tracker.settings`, read and written whole. It is the
  // shared answer to "who is on this week?" — the reason it lives on the server
  // at all rather than in each browser, which is where the spreadsheet it
  // replaces effectively lived.

  /** The stored rota, or a seeded one the first time anybody opens the page. */
  const loadRota = async () => {
    const raw = await store.getSetting('rota');
    if (!raw) return defaultRota();
    try {
      return normaliseRota(JSON.parse(raw));
    } catch {
      // A settings row that will not parse is not worth taking the page down for.
      return defaultRota();
    }
  };

  const saveRota = async (doc, req, summary) => {
    const saved = {
      ...doc,
      rev: (doc.rev ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: actorOf(req),
    };
    await store.setSetting('rota', JSON.stringify(saved));
    await store.logActivity({
      id: randomUUID(),
      at: saved.updatedAt,
      actor: saved.updatedBy,
      action: 'rota',
      register: null,
      recordId: null,
      summary,
      detail: { weeks: saved.weeks, startISO: saved.startISO, people: saved.people.length },
    });
    return saved;
  };

  const rotaPayload = (doc) => ({
    rota: doc,
    calendar: calendarOf(doc),
    thisWeek: currentWeek(doc),
    unfilled: unfilledCount(doc),
  });

  app.get('/api/rota', requireAccess('read'), async (_req, res, next) => {
    try {
      res.json(rotaPayload(await loadRota()));
    } catch (error) {
      next(error);
    }
  });

  /**
   * Save the whole document.
   *
   * Two people editing the rota in different tabs is normal — one is moving a
   * name, the other is adding somebody to the team. The revision the browser last
   * read comes back with the save; if the stored one has moved on since, the write
   * is refused and the current document is returned, so the browser shows their
   * colleague's change rather than silently overwriting it.
   */
  app.put('/api/rota', requireAccess('write'), async (req, res, next) => {
    try {
      const current = await loadRota();
      const sent = req.body ?? {};
      if (Number(sent.rev) !== current.rev) {
        return res.status(409).json({
          error: 'Somebody else changed the rota while this page was open. Reloaded their version.',
          conflict: true,
          ...rotaPayload(current),
        });
      }
      const doc = normaliseRota({ ...sent, rev: current.rev });
      res.json(rotaPayload(await saveRota(doc, req, 'Updated the safety duty rota')));
    } catch (error) {
      next(error);
    }
  });

  /** Share the duties out again, leaving hand-edited groups where they are. */
  app.post('/api/rota/fill', requireAccess('write'), async (req, res, next) => {
    try {
      const current = await loadRota();
      const sent = req.body ?? {};
      if (sent.rev !== undefined && Number(sent.rev) !== current.rev) {
        return res.status(409).json({
          error: 'Somebody else changed the rota while this page was open. Reloaded their version.',
          conflict: true,
          ...rotaPayload(current),
        });
      }

      const parts = sent.parts ?? {};
      const which = ['kpi', 'wt', 'we'].filter((part) => parts[part] !== false);
      const filled = fillRota(current, parts);
      const label =
        which.length === 3
          ? 'Filled the whole safety duty rota'
          : `Filled the duty rota (${which.join(', ')})`;
      res.json(rotaPayload(await saveRota(filled, req, label)));
    } catch (error) {
      next(error);
    }
  });

  // ---- Static app ---------------------------------------------------------

  /**
   * Serve the app so a deploy is visible on the next reload.
   *
   * These files were cached for an hour, which meant a fix could be deployed,
   * confirmed running in the logs, and still not reach anybody's browser until
   * the hour was up — indistinguishable from the deploy not having worked.
   * `maxAge: 0` with ETags means each load revalidates and gets a 304 when the
   * file has not changed, so the cost is a header exchange rather than the file.
   */
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      etag: true,
      maxAge: 0,
      setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return asError(res, 404, 'Unknown endpoint.');
    // The shell is never cached: it is what points at everything else.
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(join(PUBLIC_DIR, 'index.html'), (error) => (error ? next(error) : undefined));
  });

  app.use((error, _req, res, _next) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return asError(res, 413, 'That file is larger than the 25 MB limit.');
    }
    console.error('[tracker]', error);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return { app, store, mailer };
}

// Started directly (not imported by a test), so `node src/server.js` just works.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 4100);
  createApp()
    .then(({ app, store }) => {
      // Bound to 0.0.0.0 — the default localhost bind makes a hosted service
      // unreachable from outside, which is indistinguishable from a crash.
      app.listen(port, '0.0.0.0', () => {
        console.log(`[tracker] listening on http://0.0.0.0:${port} (storage: ${store.kind})`);
      });
    })
    .catch((error) => {
      console.error('[tracker] failed to start:', error);
      process.exit(1);
    });
}
