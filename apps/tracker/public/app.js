/*
 * Engineering Activity Tracker — browser app.
 *
 * Plain ES modules with no build step and no framework, so the app that runs is
 * the file in the repository. Whoever maintains this after us can open app.js,
 * read it, change it, and reload — no toolchain to install first.
 *
 * The register definitions come from the server (`/api/config`), never from a
 * copy here: the columns, their labels and their types have exactly one source of
 * truth, and adding a register needs no change to this file.
 */

// ---------------------------------------------------------------- helpers --

/** Minimal hyperscript. `h('div', {class: 'x'}, 'text', child)` */
function h(tag, props = null, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'value') el.value = value;
    else if (key === 'checked' || key === 'disabled' || key === 'selected') el[key] = Boolean(value);
    else el.setAttribute(key, value);
  }

  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return el;
}

const $ = (selector, scope = document) => scope.querySelector(selector);

const TODAY = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function daysUntil(iso) {
  if (!iso) return null;
  const a = Date.parse(`${TODAY()}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const CLOSED = new Set(['Completed', 'Cancelled', 'Archived']);

function dueState(dueDate, status) {
  if (CLOSED.has(status)) return 'closed';
  if (!dueDate) return 'undated';
  const days = daysUntil(dueDate);
  if (days === null) return 'undated';
  if (days < 0) return 'overdue';
  if (days <= (state.config?.dueSoonDays ?? 30)) return 'due-soon';
  return 'scheduled';
}

function dueLabel(record) {
  const st = dueState(record.dueDate, record.status);
  if (st === 'closed') return 'Closed';
  if (st === 'undated') return record.dueText ? record.dueText : 'No date';
  const days = daysUntil(record.dueDate);
  if (days < 0) return `${Math.abs(days)}d late`;
  if (days === 0) return 'Today';
  return `in ${days}d`;
}

const fmtDate = (iso) => (iso ? iso : '—');

function fmtWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  if (mins < 10080) return `${Math.round(mins / 1440)}d ago`;
  return then.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ state --

const state = {
  config: null,
  view: 'dashboard',
  registerId: null,
  user: localStorage.getItem('tracker.user') ?? '',
  accessCode: localStorage.getItem('tracker.code') ?? '',
  token: localStorage.getItem('tracker.token') ?? '',
  me: null, // the signed-in account
  authState: null, // { needsSetup, requiresSetupCode, roles, disabled }
  users: null, // the team, for admins
  confirmToken: '', // password re-confirmation for Settings — memory only, on purpose
  confirmExpires: 0,
  confirmPrompt: null, // { error } while asking
  logos: { left: null, right: null }, // the two brand logos, once loaded
  reminders: null, // { config, mail, runs, weekdays } for admins
  reminderPreview: null, // who today's digest would go to, before sending
  reminderTest: null, // { ok, message } from the last test send — kept on screen
  theme: localStorage.getItem('tracker.theme') ?? 'auto',
  gate: null, // 'setup' | 'login' | 'name' | null
  dashboard: null,
  list: null,
  filterOptions: { actionBy: [], initiator: [], area: [] },
  query: {},
  drawer: null, // { record, registerId, isNew }
  importState: null,
  imports: null,
  importsScope: null,
  activity: null,
  rota: null, // { rota, calendar, thisWeek, unfilled } — the shared duty rota
  rotaTab: 'kpi',
  rotaPerson: null,
  busy: false,
  error: null,
  toast: null,
};

const defaultQuery = () => ({
  search: '',
  priority: '',
  status: '',
  actionBy: '',
  due: '',
  open: true,
  sort: 'dueDate',
  direction: 'asc',
  page: 1,
  pageSize: 50,
});

// -------------------------------------------------------------------- api --

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (state.user) headers['x-user-name'] = state.user;
  if (state.accessCode) headers['x-access-code'] = state.accessCode;
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (state.confirmToken) headers['x-confirm-token'] = state.confirmToken;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.json);
    options.method = options.method ?? 'POST';
  }

  // The standalone single-file build has no server behind it. It installs a local
  // handler that answers these same paths out of browser storage and returns real
  // `Response` objects, so everything below — and the whole UI — runs unchanged
  // against either transport.
  const response = globalThis.__trackerLocalApi
    ? await globalThis.__trackerLocalApi(path, { ...options, headers })
    : await fetch(path, { ...options, headers });

  // The sign-in routes are the one place a 401 is an answer rather than a
  // problem — bouncing somebody back to the form they are already looking at
  // would replace "that password is wrong" with something vaguer.
  // `/api/auth/confirm` belongs here too: a 401 from it means "that password is
  // wrong", not "your session ended". Treating it as the latter signed the admin
  // out for one mistyped character.
  const isAuthRoute = [
    '/api/session',
    '/api/auth/login',
    '/api/auth/setup',
    '/api/auth/password',
    '/api/auth/confirm',
  ].includes(path);
  if (response.status === 401 && !isAuthRoute) {
    signOut({ silent: true });
    throw new Error('Please sign in.');
  }

  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!response.ok) {
    const body = isJson ? await response.json().catch(() => ({})) : {};
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }

  return isJson ? response.json() : response;
}

/** Downloads need the auth header, so they go through fetch rather than a bare link. */
async function download(path) {
  try {
    toast('Preparing the file…');
    const response = await api(path);
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') ?? '';
    const name = disposition.match(/filename="(.+?)"/)?.[1] ?? 'export.xlsx';

    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast(`Downloaded ${name}`);
  } catch (error) {
    toast(error.message);
  }
}

let toastTimer = null;
function toast(message) {
  state.toast = message;
  render();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    render();
  }, 3600);
}

// ------------------------------------------------------------------ chrome --

const registerById = (id) => state.config?.registers.find((r) => r.id === id) ?? null;

const ROLE_LABELS = { viewer: 'Viewer', editor: 'Editor', admin: 'Admin' };
const roleLabel = (role) => ROLE_LABELS[role] ?? role;

const PRIORITY_CLASS = {
  Critical: 'p-critical',
  High: 'p-high',
  Medium: 'p-medium',
  Low: 'p-low',
  Planned: 'p-planned',
};

const priorityChip = (priority) =>
  h('span', { class: `chip ${PRIORITY_CLASS[priority] ?? 'p-medium'}` }, priority ?? 'Medium');

const dueChip = (record) =>
  h('span', { class: `chip s-${dueState(record.dueDate, record.status)}` }, dueLabel(record));

/**
 * One table cell, rendered according to the job that column does.
 *
 * Values come from the record's own stored columns, except priority and status,
 * which come from the derived values — the sheets spell those a dozen ways ("P1",
 * "Alarm", "On going", "Close") and a table that prints each spelling verbatim
 * cannot be scanned. The date column carries its lateness chip so a register that
 * shows no explicit status still shows what is late.
 */
function cell(register, record, field) {
  const roles = register.roles;
  const raw = record.data?.[field.key];

  // The normalised value, and underneath it the word the sheet actually used
  // when they differ. QC's "Finding Classification" reads `Execution`, which
  // becomes High — showing only "High" in a column headed Finding
  // Classification looks like the wrong data rather than a derived one. The
  // same goes for PDM's `Alarm` and IWS's `P1`.
  if (field.key === roles.priority) {
    return h(
      'td',
      null,
      priorityChip(record.priority),
      raw && String(raw) !== record.priority ? h('div', { class: 'hint' }, String(raw)) : null,
    );
  }

  if (field.key === roles.status) {
    return h('td', null, record.status, raw && record.status !== raw ? h('div', { class: 'hint' }, raw) : null);
  }

  if (field.key === roles.due) {
    return h('td', null, dueChip(record), record.dueDate && h('div', { class: 'hint' }, record.dueDate));
  }

  if (raw === undefined || raw === null || raw === '') return h('td', { class: 'muted' }, '—');

  if (field.type === 'longtext') {
    return h('td', null, h('span', { class: 'cell-title', title: String(raw) }, String(raw)));
  }

  if (field.type === 'number') return h('td', { class: 'num' }, String(raw));

  // Stored as a whole number of percent, so the sign belongs with it.
  if (field.type === 'percent') return h('td', { class: 'num' }, `${raw}%`);

  if (field.key === roles.ref) return h('td', null, h('span', { class: 'cell-ref' }, String(raw)));

  return h('td', null, String(raw));
}

/**
 * A horizontal bar. `segments` are drawn in order with a 2px surface gap, and the
 * total is always printed at the end so the value never depends on reading colour.
 */
function barRow(label, segments, max, note = null) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const scale = max > 0 ? max : 1;

  return h(
    'div',
    { class: 'bar-row' },
    h('div', { class: 'b-label', title: label }, label),
    h(
      'div',
      { class: 'bar-track' },
      segments
        .filter((s) => s.value > 0)
        .map((s) =>
          h('div', {
            class: 'bar-fill',
            style: `width: ${(s.value / scale) * 100}%; background: ${s.color}`,
            title: `${s.label}: ${s.value}`,
          }),
        ),
    ),
    h('div', { class: 'b-value' }, note ?? total),
  );
}

/**
 * A ring showing how one register's work divides up.
 *
 * Four segments that sum to the register's total, so the ring is genuinely
 * part-to-whole rather than a pie of unrelated numbers. Every segment is also
 * printed as a labelled figure beside it — the ring shows the shape at a glance,
 * the numbers carry the meaning, and nothing depends on telling two colours apart.
 */
function donut(segments, total, size = 104) {
  const stroke = 15;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = total > 0 ? s.value / total : 0;
      // A 1.5px gap between arcs keeps neighbouring segments from reading as one.
      const length = Math.max(0, fraction * circumference - 1.5);
      const circle = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}"
        fill="none" stroke="${s.color}" stroke-width="${stroke}"
        stroke-dasharray="${length} ${circumference - length}"
        stroke-dashoffset="${-offset}" stroke-linecap="butt"
        transform="rotate(-90 ${size / 2} ${size / 2})"><title>${s.label}: ${s.value}</title></circle>`;
      offset += fraction * circumference;
      return circle;
    })
    .join('');

  const ring = h('div', {
    class: 'donut',
    html: `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img"
      aria-label="${segments.map((s) => `${s.label} ${s.value}`).join(', ')}">
      <circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none"
        stroke="var(--plane)" stroke-width="${stroke}"/>
      ${arcs}
    </svg>`,
  });

  return h(
    'div',
    { class: 'donut-wrap' },
    ring,
    h('div', { class: 'donut-centre' }, h('strong', null, total), h('span', null, 'total')),
  );
}

const legend = (items) =>
  h(
    'div',
    { class: 'legend' },
    items.map((item) =>
      h('span', null, h('i', { style: `background: ${item.color}` }), item.label),
    ),
  );

const COLOR = {
  overdue: 'var(--critical)',
  dueSoon: 'var(--warning)',
  later: 'var(--accent)',
  bin: ['var(--critical)', 'var(--bin-1)', 'var(--bin-2)', 'var(--bin-3)', 'var(--bin-4)', 'var(--line)'],
  priority: {
    Critical: 'var(--critical)',
    High: 'var(--serious)',
    Medium: 'var(--warning)',
    Low: 'var(--accent)',
    Planned: 'var(--line)',
  },
};

// ----------------------------------------------------------------- loaders --

async function loadDashboard() {
  state.busy = true;
  render();
  try {
    state.dashboard = await api('/api/dashboard');
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

async function loadList() {
  state.busy = true;
  render();
  try {
    const params = new URLSearchParams();
    params.set('register', state.registerId);
    for (const [key, value] of Object.entries(state.query)) {
      if (value === '' || value === false || value === null) continue;
      params.set(key, String(value));
    }
    const [list, filters] = await Promise.all([
      api(`/api/records?${params}`),
      api(`/api/filters?register=${state.registerId}`),
    ]);
    state.list = list;
    state.filterOptions = filters;
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

function go(view, registerId = null) {
  state.view = view;
  state.registerId = registerId;
  state.drawer = null;

  // Coming back to Import after a finished run means starting another one, so the
  // last run's summary steps aside. A half-finished run is left alone — someone who
  // clicked away mid-confirm should find their sheet choices where they left them.
  if (view === 'import' && ['done', 'error'].includes(state.importState?.stage)) {
    state.importState = null;
  }

  // Settings asks for the password first. The view stays where it was, so the
  // page behind the prompt is the one they were on — cancelling leaves them
  // there rather than on a Settings page they never got into.
  if (view === 'settings' && !hasConfirmation()) {
    state.view = 'dashboard';
    state.confirmPrompt = { error: null };
    render();
    return;
  }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'rota') loadRota();
  else if (view === 'register') {
    state.query = defaultQuery();
    state.list = null;
    loadList();
  } else if (view === 'settings') {
    state.users = null;
    render();
  } else if (view === 'activity') {
    api('/api/activity')
      .then((data) => {
        state.activity = data.activity;
        render();
      })
      .catch((error) => toast(error.message));
    render();
  } else render();
}

// ------------------------------------------------------------------- gates --

/** What the signed-in account may do. Offline builds behave as a lone admin. */
const canWrite = () => ['editor', 'admin'].includes(state.me?.role);
// Managing accounts only means something where accounts exist. The offline build
// treats its holder as an admin so nothing is hidden from them, but there is
// nobody to administer.
const canManage = () => state.me?.role === 'admin' && !state.authState?.disabled;

/** The registers this account may open, in the catalogue's order. */
function myRegisters() {
  const all = state.config?.registers ?? [];
  const allowed = state.me?.registers ?? [];
  return allowed.length ? all.filter((r) => allowed.includes(r.id)) : all;
}

/** Is the password confirmation still fresh? */
const hasConfirmation = () => Boolean(state.confirmToken) && Date.now() < state.confirmExpires;

/**
 * Ask for the signed-in account's own password before opening Settings.
 *
 * Being signed in is not enough for the screen that decides who gets in: an admin
 * who steps away from an unlocked browser would otherwise be leaving the team's
 * permissions open to whoever sits down next. The confirmation lives in memory
 * only and lasts fifteen minutes, so closing the tab ends it.
 */
function renderConfirmPrompt() {
  let password = '';

  const close = () => {
    state.confirmPrompt = null;
    render();
  };

  return h(
    'div',
    {
      class: 'scrim modal-centre',
      onclick: (event) => {
        if (event.target === event.currentTarget) close();
      },
    },
    h(
      'form',
      {
        class: 'modal',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const result = await api('/api/auth/confirm', { json: { password } });
            state.confirmToken = result.confirmToken;
            state.confirmExpires = Date.now() + result.expiresInMs - 5000;
            state.confirmPrompt = null;
            go('settings');
          } catch (error) {
            state.confirmPrompt = { error: error.message };
            render();
          }
        },
      },
      h('h2', null, 'Confirm your password'),
      h(
        'p',
        { class: 'hint', style: 'margin: 8px 0 16px' },
        'Settings decides who can open this tracker and what they can change, so it asks again even though you are signed in.',
      ),
      state.confirmPrompt?.error &&
        h('div', { class: 'banner error', style: 'margin-bottom: 12px' }, state.confirmPrompt.error),
      h(
        'label',
        { class: 'field' },
        h('span', null, `Password for ${state.me?.email ?? 'your account'}`),
        h('input', {
          type: 'password',
          id: 'confirm-password',
          autocomplete: 'current-password',
          autofocus: 'autofocus',
          oninput: (e) => {
            password = e.target.value;
          },
        }),
      ),
      h(
        'div',
        { style: 'margin-top: 18px; display: flex; gap: 8px; justify-content: flex-end' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Open Settings'),
      ),
    ),
  );
}

function signOut({ silent = false } = {}) {
  state.token = '';
  state.me = null;
  state.users = null;
  state.confirmToken = '';
  state.confirmExpires = 0;
  state.confirmPrompt = null;
  localStorage.removeItem('tracker.token');
  state.gate = 'login';
  state.dashboard = null;
  state.list = null;
  render();
  if (!silent) toast('Signed out.');
}

/** A labelled input that keeps its value in `form` and its focus across redraws. */
const formField = (form, key, label, { type = 'text', placeholder = '', autofocus = false } = {}) =>
  h(
    'label',
    { class: 'field' },
    h('span', null, label),
    h('input', {
      type,
      id: `auth-${key}`,
      value: form[key] ?? '',
      placeholder,
      autofocus: autofocus ? 'autofocus' : null,
      autocomplete: type === 'password' ? 'current-password' : 'on',
      oninput: (e) => {
        form[key] = e.target.value;
      },
    }),
  );

const authForm = {};

function renderGate() {
  // ---- first run: nobody has an account yet ------------------------------
  if (state.gate === 'setup') {
    return h(
      'div',
      { class: 'scrim modal-centre' },
      h(
        'form',
        {
          class: 'modal',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              const result = await api('/api/auth/setup', { json: { ...authForm } });
              acceptSession(result);
            } catch (error) {
              state.error = error.message;
              render();
            }
          },
        },
        h('h2', null, 'Create the first account'),
        h(
          'p',
          { class: 'hint', style: 'margin: 8px 0 16px' },
          'This account is the administrator — it can add the rest of your team and choose what each person may do.',
        ),
        state.error && h('div', { class: 'banner error', style: 'margin-bottom: 12px' }, state.error),
        h(
          'div',
          { style: 'display: flex; flex-direction: column; gap: 12px' },
          state.authState?.requiresSetupCode &&
            formField(authForm, 'accessCode', 'Team access code', {
              type: 'password',
              autofocus: true,
            }),
          formField(authForm, 'name', 'Your name', { placeholder: 'e.g. Abdul Rahman' }),
          formField(authForm, 'email', 'Email', { type: 'email', placeholder: 'you@company.com' }),
          formField(authForm, 'password', 'Password', {
            type: 'password',
            placeholder: 'At least 8 characters',
          }),
        ),
        h(
          'div',
          { style: 'margin-top: 18px; display: flex; justify-content: flex-end' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Create account'),
        ),
      ),
    );
  }

  // ---- offline build: no accounts, just a name for the audit trail -------
  if (state.gate === 'name') {
    let value = state.user;
    return h(
      'div',
      { class: 'scrim modal-centre' },
      h(
        'form',
        {
          class: 'modal',
          onsubmit: (event) => {
            event.preventDefault();
            const name = value.trim();
            if (!name) return;
            state.user = name;
            localStorage.setItem('tracker.user', name);
            state.me = { id: 'local', name, role: 'admin', registers: [] };
            state.gate = null;
            go('dashboard');
          },
        },
        h('h2', null, 'Who are you?'),
        h(
          'p',
          { class: 'hint', style: 'margin: 8px 0 16px' },
          'This offline copy has no accounts. Your name is recorded against everything you change.',
        ),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Your name'),
          h('input', {
            type: 'text',
            id: 'gate-name',
            value: state.user,
            placeholder: 'e.g. Abdul Rahman',
            autofocus: 'autofocus',
            oninput: (e) => {
              value = e.target.value;
            },
          }),
        ),
        h(
          'div',
          { style: 'margin-top: 16px; display: flex; justify-content: flex-end' },
          h('button', { class: 'btn primary', type: 'submit' }, 'Start'),
        ),
      ),
    );
  }

  // ---- normal sign-in ----------------------------------------------------
  return h(
    'div',
    { class: 'scrim modal-centre' },
    h(
      'form',
      {
        class: 'modal',
        onsubmit: async (event) => {
          event.preventDefault();
          try {
            const result = await api('/api/auth/login', {
              json: { email: authForm.email, password: authForm.password },
            });
            acceptSession(result);
          } catch (error) {
            state.error = error.message;
            render();
          }
        },
      },
      h(
        'div',
        { class: 'brand', style: 'padding: 0 0 14px' },
        h('div', { class: 'brand-mark' }, 'EA'),
        h(
          'div',
          { class: 'brand-text' },
          h('strong', null, 'Activity Tracker'),
          h('span', null, 'Engineering — SHP / DCU'),
        ),
      ),
      h('h2', null, 'Sign in'),
      state.error &&
        h('div', { class: 'banner error', style: 'margin: 12px 0 0' }, state.error),
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 12px; margin-top: 14px' },
        formField(authForm, 'email', 'Email', {
          type: 'email',
          placeholder: 'you@company.com',
          autofocus: true,
        }),
        formField(authForm, 'password', 'Password', { type: 'password' }),
      ),
      h(
        'div',
        { style: 'margin-top: 18px; display: flex; justify-content: flex-end' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Sign in'),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: 14px 0 0' },
        'No account? Ask an administrator on your team to create one for you.',
      ),
    ),
  );
}

/** Store a freshly issued session and go to work. */
function acceptSession({ token, user }) {
  state.token = token;
  state.me = user;
  state.user = user.name;
  state.error = null;
  state.gate = null;
  localStorage.setItem('tracker.token', token);
  localStorage.setItem('tracker.user', user.name);
  authForm.password = '';
  authForm.accessCode = '';
  go('dashboard');
}

// ----------------------------------------------------------------- sidebar --

function renderSidebar() {
  const counts = new Map(
    (state.dashboard?.byRegister ?? []).map((r) => [r.id, r]),
  );

  return h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'brand-mark' }, 'EA'),
      h(
        'div',
        { class: 'brand-text' },
        h('strong', null, 'Activity Tracker'),
        h('span', null, 'Engineering — SHP / DCU'),
      ),
    ),

    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'dashboard'),
        onclick: () => go('dashboard'),
      },
      h('span', { class: 'short' }, '▦'),
      h('span', { class: 'grow' }, 'Dashboard'),
    ),

    h('div', { class: 'nav-label' }, 'Registers'),
    myRegisters().map((register) => {
      const stat = counts.get(register.id);
      const late = stat?.overdue ?? 0;
      return h(
        'button',
        {
          class: 'nav-item',
          'aria-current': String(state.view === 'register' && state.registerId === register.id),
          onclick: () => go('register', register.id),
          title: register.description,
        },
        h('span', { class: 'short' }, register.short),
        h('span', { class: 'grow' }, register.name),
        h(
          'span',
          { class: `nav-count${late ? ' alert' : ''}`, title: late ? `${late} overdue` : 'open items' },
          late ? `${late}!` : (stat?.open ?? ''),
        ),
      );
    }),

    h('div', { class: 'nav-label' }, 'Rota'),
    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'rota'),
        onclick: () => go('rota'),
        title: 'Safety KPI, walkthrough and weekend duties',
      },
      h('span', { class: 'short' }, '☰'),
      h('span', { class: 'grow' }, 'Duty rota'),
    ),

    h('div', { class: 'nav-label' }, 'Data'),
    canWrite() &&
      h(
        'button',
        {
          class: 'nav-item',
          'aria-current': String(state.view === 'import'),
          onclick: () => go('import'),
        },
        h('span', { class: 'short' }, '↑'),
        h('span', { class: 'grow' }, 'Import Excel'),
      ),
    h(
      'button',
      { class: 'nav-item', onclick: () => download('/api/export') },
      h('span', { class: 'short' }, '↓'),
      h('span', { class: 'grow' }, 'Export all'),
    ),
    h(
      'button',
      {
        class: 'nav-item',
        'aria-current': String(state.view === 'activity'),
        onclick: () => go('activity'),
      },
      h('span', { class: 'short' }, '⟳'),
      h('span', { class: 'grow' }, 'Recent changes'),
    ),

    canManage() &&
      h(
        'button',
        {
          class: 'nav-item',
          'aria-current': String(state.view === 'settings'),
          onclick: () => go('settings'),
        },
        h('span', { class: 'short' }, '⚙'),
        h('span', { class: 'grow' }, 'Settings'),
      ),

    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', null, `Signed in as ${state.me?.name || state.user || '—'}`),
      state.me?.role &&
        h('div', { style: 'margin-top: 2px' }, h('span', { class: 'chip p-medium' }, roleLabel(state.me.role))),
      state.authState?.disabled
        ? h(
            'button',
            {
              class: 'btn ghost sm',
              style: 'margin-top: 6px; padding-left: 0',
              onclick: () => {
                state.gate = 'name';
                render();
              },
            },
            'Change name',
          )
        : h(
            'button',
            { class: 'btn ghost sm', style: 'margin-top: 6px; padding-left: 0', onclick: () => signOut() },
            'Sign out',
          ),
    ),
  );
}

// --------------------------------------------------------------- dashboard --

// ------------------------------------------------------------- 3D landscape --

/**
 * The department as one landscape.
 *
 * A bar per register, arranged on a floor you can turn: height is how much is
 * still open on it, colour is the worst state anything on it is in. The point
 * is the shape rather than the numbers — which register is tall, which is red —
 * and the exact figures are a click away in the rings underneath.
 *
 * Drawn on a canvas with a hand-rolled projection rather than a 3D library: the
 * app has no build step, and it has to keep working inside the single-file
 * offline build, where a CDN script would simply not be there.
 */
const view3d = {
  yaw: -0.62,
  pitch: 0.72,
  spin: false,
  frame: 0,
  drag: null,
  hover: null, // register id under the pointer
  pointer: null, // where it is, for placing the readout
};

const VIEW3D_HOME = { yaw: -0.62, pitch: 0.72 };

/** Read a CSS custom property as real numbers, so the canvas follows the theme. */
function themeRgb(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  }
  const rgb = raw.match(/-?[\d.]+/g);
  if (rgb && rgb.length >= 3) return rgb.slice(0, 3).map(Number);
  return fallback;
}

const shade = ([r, g, b], factor, alpha = 1) =>
  `rgba(${Math.round(Math.min(255, r * factor))}, ${Math.round(Math.min(255, g * factor))}, ${Math.round(
    Math.min(255, b * factor),
  )}, ${alpha})`;

/** The worst thing happening on a register decides its colour. */
function landscapeState(row) {
  if (row.overdue > 0) return 'overdue';
  if (row.dueSoon > 0) return 'dueSoon';
  if (row.open > 0) return 'open';
  return 'clear';
}

/** Bottom to top: finished work at the base, the problems crowning the stack. */
const LANDSCAPE_BANDS = [
  { key: 'closed', label: 'Closed', token: '--good', fallback: [12, 163, 12] },
  { key: 'later', label: 'Open, on track', token: '--accent', fallback: [42, 120, 214] },
  { key: 'dueSoon', label: 'Due within the month', token: '--warning', fallback: [250, 178, 25] },
  { key: 'overdue', label: 'Overdue', token: '--critical', fallback: [208, 59, 59] },
];

/**
 * A fixed light, so turning the scene changes the shading.
 *
 * Faces were tinted by which axis they lay on, which is enough to read a box as
 * solid but stays put as the floor turns — the columns looked like flat cut-outs
 * rotating. Shading against a light the scene moves under is what makes them
 * read as objects.
 */
const LIGHT = (() => {
  const v = [-0.45, 0.82, 0.36];
  const len = Math.hypot(...v);
  return v.map((n) => n / len);
})();

function drawLandscape(canvas, rows) {
  const ctx = canvas.getContext('2d');
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;

  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const bands = LANDSCAPE_BANDS.map((band) => ({ ...band, rgb: themeRgb(band.token, band.fallback) }));
  const ink = themeRgb('--ink', [11, 11, 11]);
  const inkSoft = themeRgb('--ink-2', [82, 81, 78]);
  const surface = themeRgb('--raised', [255, 255, 255]);
  const floor = themeRgb('--line', [195, 194, 183]);

  const columns = Math.max(1, Math.ceil(Math.sqrt(rows.length)));
  const gridRows = Math.max(1, Math.ceil(rows.length / columns));
  const cell = 1;
  const box = 0.46;
  // Alternate rows are offset half a cell.
  //
  // On a square grid a back column sits directly behind a front one and its
  // lower bands — Closed first, being at the base — disappear entirely. Laid
  // like brickwork, every column shows through the gap between the two in
  // front of it.
  const stagger = 0.5;

  /**
   * Height follows the square root of the total.
   *
   * Linearly, a register holding eight hundred audits makes one holding six
   * notices a smear on the floor — and the six are the ones somebody has to do
   * something about. The square root keeps the order and the sense of scale
   * while leaving every register tall enough to read. Within a column the
   * segments stay strictly proportional to each other.
   */
  const totalOf = (row) => Math.max(0, row.total ?? 0);
  const biggest = Math.max(1, ...rows.map(totalOf));
  const heightOf = (total) => (total <= 0 ? 0.05 : 0.3 + (Math.sqrt(total) / Math.sqrt(biggest)) * 1.5);

  const { yaw, pitch } = view3d;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const originX = (columns * cell + 0.5) / 2;
  const originZ = (gridRows * cell) / 2;

  const project = (x, y, z) => {
    const dx = x - originX;
    const dz = z - originZ;
    const rx = dx * cosY - dz * sinY;
    const rz = dx * sinY + dz * cosY;
    return { x: rx, y: -(y * cosP + rz * sinP), depth: rz };
  };

  /** How lit a face is, given its normal — recomputed as the scene turns. */
  const lit = (nx, ny, nz) => {
    const rx = nx * cosY - nz * sinY;
    const rz = nx * sinY + nz * cosY;
    const d = rx * LIGHT[0] + ny * LIGHT[1] + rz * LIGHT[2];
    return 0.6 + 0.45 * Math.max(0, d);
  };

  const pad = (cell - box) / 2;
  const placed = [...rows]
    .sort((a, b) => totalOf(a) - totalOf(b) || String(a.short).localeCompare(String(b.short)))
    .map((row, i) => ({
      row,
      gx: (i % columns) * cell + pad + (Math.floor(i / columns) % 2 ? stagger : 0),
      gz: Math.floor(i / columns) * cell + pad,
      h: heightOf(totalOf(row)),
    }));

  const floorW = columns * cell + stagger;
  const floorD = gridRows * cell;
  const probes = [];
  for (const x of [0, floorW]) {
    for (const z of [0, floorD]) probes.push(project(x, 0, z));
  }
  for (const c of placed) {
    for (const x of [c.gx, c.gx + box]) {
      for (const z of [c.gz, c.gz + box]) probes.push(project(x, c.h, z));
    }
  }
  const minX = Math.min(...probes.map((p) => p.x));
  const maxX = Math.max(...probes.map((p) => p.x));
  const minY = Math.min(...probes.map((p) => p.y));
  const maxY = Math.max(...probes.map((p) => p.y));
  const LABEL_ROOM = 26;
  const scale = Math.min((width - 36) / (maxX - minX || 1), (height - 20 - LABEL_ROOM) / (maxY - minY || 1));
  const midX = (maxX + minX) / 2;
  const midY = (maxY + minY) / 2;
  const toScreen = (p) => ({
    x: width / 2 + (p.x - midX) * scale,
    y: (height + LABEL_ROOM) / 2 + (p.y - midY) * scale,
  });

  const at = (x, y, z) => toScreen(project(x, y, z));
  const face = (points, fill, stroke = null) => {
    ctx.beginPath();
    points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  };

  // ---- floor -------------------------------------------------------------
  //
  // A plain plane, not a grid: the columns are staggered and no longer sit on
  // the lines, so a grid drew attention to a structure that had stopped meaning
  // anything. A gentle gradient front to back gives the plane its depth instead.
  const near = at(0, 0, 0);
  const far = at(floorW, 0, floorD);
  const wash = ctx.createLinearGradient(near.x, near.y, far.x, far.y);
  wash.addColorStop(0, shade(surface, 1, 0.96));
  wash.addColorStop(1, shade(floor, 1, 0.28));
  face(
    [at(0, 0, 0), at(floorW, 0, 0), at(floorW, 0, floorD), at(0, 0, floorD)],
    wash,
    shade(floor, 1, 0.55),
  );

  // Contact shadows, cast away from the light. Drawn before any column so a
  // near shadow never falls across the column behind it.
  const shadowOffset = { x: -LIGHT[0] * 0.16, z: -LIGHT[2] * 0.16 };
  for (const c of placed) {
    if (c.h <= 0.06) continue;
    const sx = c.gx + shadowOffset.x;
    const sz = c.gz + shadowOffset.z;
    face(
      [at(sx, 0, sz), at(sx + box, 0, sz), at(sx + box, 0, sz + box), at(sx, 0, sz + box)],
      shade(ink, 1, 0.1),
    );
  }

  const drawn = placed
    .map((c) => ({ ...c, centre: project(c.gx + box / 2, 0, c.gz + box / 2).depth }))
    .sort((a, b) => b.centre - a.centre);

  const hits = [];

  for (const column of drawn) {
    const { gx, gz, h, row } = column;
    const x1 = gx + box;
    const z1 = gz + box;
    const total = totalOf(row);
    const hovered = view3d.hover === row.id;
    const boost = hovered ? 1.14 : 1;

    // Each wall of the box, with the outward normal that decides its shading.
    const sides = [
      { a: [gx, gz], b: [x1, gz], n: [0, 0, -1] },
      { a: [x1, gz], b: [x1, z1], n: [1, 0, 0] },
      { a: [x1, z1], b: [gx, z1], n: [0, 0, 1] },
      { a: [gx, z1], b: [gx, gz], n: [-1, 0, 0] },
    ]
      .map((side) => ({
        ...side,
        depth: (project(side.a[0], 0, side.a[1]).depth + project(side.b[0], 0, side.b[1]).depth) / 2,
        light: lit(side.n[0], side.n[1], side.n[2]),
      }))
      .sort((p, q) => q.depth - p.depth);

    // Segment boundaries, bottom to top.
    //
    // A band that exists is never allowed to become invisible. Strictly
    // proportional, one overdue job among eight hundred audits is a hairline
    // nobody can see — and that one job is the whole reason to look. Any band
    // holding something gets a floor of a few percent, taken pro rata from the
    // bands with room to give. A band holding nothing stays absent, because
    // showing four colours on a register that is only in one state would be a
    // picture of something that is not true.
    const present = bands
      .map((band) => ({ band, value: Math.max(0, row[band.key] ?? 0) }))
      .filter((part) => part.value > 0);

    const stack = [];
    if (total > 0 && present.length) {
      const floorFrac = Math.min(0.075, 1 / (present.length * 1.6));
      present.forEach((part) => {
        part.raw = part.value / total;
      });
      const short = present.filter((part) => part.raw < floorFrac);
      const tall = present.filter((part) => part.raw >= floorFrac);
      const owed = short.reduce((sum, part) => sum + (floorFrac - part.raw), 0);
      const spare = tall.reduce((sum, part) => sum + part.raw, 0);
      present.forEach((part) => {
        part.frac =
          part.raw < floorFrac
            ? floorFrac
            : spare > 0
              ? part.raw - owed * (part.raw / spare)
              : part.raw;
      });

      let cursor = 0;
      for (const part of present) {
        const span = part.frac * h;
        stack.push({ band: part.band, value: part.value, y0: cursor, y1: cursor + span });
        cursor += span;
      }
    }
    if (!stack.length) {
      stack.push({ band: { rgb: floor, label: 'Nothing yet' }, value: 0, y0: 0, y1: h });
    }

    const faces = [];
    // Walls back to front; within a wall the segments are coplanar, so they can
    // be laid down bottom to top in any order.
    for (const side of sides) {
      for (const part of stack) {
        const quad = [
          at(side.a[0], part.y0, side.a[1]),
          at(side.b[0], part.y0, side.b[1]),
          at(side.b[0], part.y1, side.b[1]),
          at(side.a[0], part.y1, side.a[1]),
        ];
        face(quad, shade(part.band.rgb, side.light * boost));
        faces.push(quad);
      }
      // A hairline where two colours meet, so the divisions stay legible when
      // one segment is only a sliver of the column.
      for (const part of stack.slice(0, -1)) {
        const a = at(side.a[0], part.y1, side.a[1]);
        const b = at(side.b[0], part.y1, side.b[1]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = shade(surface, 1, 0.35);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    const topBand = stack[stack.length - 1];
    const top = [at(gx, h, gz), at(x1, h, gz), at(x1, h, z1), at(gx, h, z1)];
    face(top, shade(topBand.band.rgb, lit(0, 1, 0) * boost), hovered ? shade(ink, 1, 0.5) : null);
    faces.push(top);

    hits.push({ row, faces, top, apex: at(gx + box / 2, h, gz + box / 2), stack });
  }

  // ---- labels ------------------------------------------------------------
  ctx.font = '600 10.5px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const pills = [];
  const overlaps = (a, b) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 3 && Math.abs(a.y - b.y) < 21;

  for (const hit of hits) {
    const label = `${hit.row.short || hit.row.name}${totalOf(hit.row) ? ` · ${totalOf(hit.row)}` : ''}`;
    const w = ctx.measureText(label).width + 12;
    let y = hit.apex.y - 13;
    while (pills.some((p) => overlaps({ x: hit.apex.x, y, w }, p))) y -= 20;
    pills.push({ x: hit.apex.x, y, w, label, apex: hit.apex, id: hit.row.id });
  }

  for (const pill of pills) {
    if (pill.apex.y - pill.y > 16) {
      ctx.beginPath();
      ctx.moveTo(pill.x, pill.y + 9);
      ctx.lineTo(pill.x, pill.apex.y - 2);
      ctx.strokeStyle = shade(floor, 1, 0.7);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const active = view3d.hover === pill.id;
    ctx.beginPath();
    ctx.roundRect(pill.x - pill.w / 2, pill.y - 9, pill.w, 18, 9);
    ctx.fillStyle = active ? shade(ink, 1, 0.92) : shade(surface, 1, 0.96);
    ctx.fill();
    ctx.strokeStyle = shade(floor, 1, 0.6);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = active ? shade(surface, 1) : shade(ink, 1);
    ctx.fillText(pill.label, pill.x, pill.y);
  }

  // ---- what the pointer is over ------------------------------------------
  const focus = hits.find((hit) => hit.row.id === view3d.hover);
  if (focus && view3d.pointer) {
    const lines = LANDSCAPE_BANDS.map((band) => ({
      label: band.label,
      value: Math.max(0, focus.row[band.key] ?? 0),
      rgb: bands.find((b) => b.key === band.key).rgb,
    })).reverse();

    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const titleWidth = ctx.measureText(focus.row.name).width;
    ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    const bodyWidth = Math.max(...lines.map((l) => ctx.measureText(`${l.label}  ${l.value}`).width));
    const w = Math.max(titleWidth, bodyWidth + 16) + 22;
    const rowH = 15;
    const boxH = 26 + lines.length * rowH;

    let bx = Math.min(width - w - 8, Math.max(8, view3d.pointer.x + 14));
    let by = Math.min(height - boxH - 8, Math.max(8, view3d.pointer.y - boxH - 10));

    ctx.beginPath();
    ctx.roundRect(bx, by, w, boxH, 8);
    ctx.fillStyle = shade(surface, 1, 0.98);
    ctx.fill();
    ctx.strokeStyle = shade(floor, 1, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = shade(ink, 1);
    ctx.fillText(focus.row.name, bx + 11, by + 15);

    ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    lines.forEach((line, i) => {
      const y = by + 33 + i * rowH;
      ctx.fillStyle = shade(line.rgb, 1);
      ctx.beginPath();
      ctx.roundRect(bx + 11, y - 4, 8, 8, 2);
      ctx.fill();
      ctx.fillStyle = shade(inkSoft, 1);
      ctx.fillText(line.label, bx + 25, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = shade(ink, 1);
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(String(line.value), bx + w - 11, y);
      ctx.textAlign = 'left';
      ctx.font = '400 11px ui-sans-serif, system-ui, sans-serif';
    });
  }

  canvas.__hits = hits;
}

const inside = (point, polygon) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
};

function render3dLandscape(rows) {
  const canvas = h('canvas', {
    class: 'landscape',
    role: 'img',
    'aria-label': `A bar for each of the ${rows.length} registers. Height is how much is still open on it; colour is the worst state anything on it is in. The same figures are listed below.`,
  });

  const redraw = () => drawLandscape(canvas, rows);

  // The loop runs only while it is spinning.
  //
  // Left running to poll a flag, it woke the browser sixty times a second to
  // decide to do nothing — on a phone in somebody's pocket that is battery
  // spent on a still picture. The app re-renders wholesale, so a detached
  // canvas also ends the loop rather than animating something nobody can see.
  const step = () => {
    if (!canvas.isConnected || !view3d.spin) {
      view3d.frame = 0;
      return;
    }
    if (!view3d.drag) {
      view3d.yaw += 0.004;
      redraw();
    }
    view3d.frame = requestAnimationFrame(step);
  };

  const startSpin = () => {
    cancelAnimationFrame(view3d.frame);
    view3d.frame = view3d.spin ? requestAnimationFrame(step) : 0;
  };

  const pointAt = (event) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  canvas.addEventListener('pointerdown', (event) => {
    view3d.drag = { x: event.clientX, y: event.clientY, yaw: view3d.yaw, pitch: view3d.pitch, moved: 0 };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!view3d.drag) {
      // Touch has no hover, and holding the readout open after a tap would
      // leave it stranded on screen with nothing pointing at it.
      if (event.pointerType === 'touch') return;
      const point = pointAt(event);
      const hit = columnAt(point);
      const id = hit?.row.id ?? null;
      view3d.pointer = point;
      if (id !== view3d.hover) {
        view3d.hover = id;
        canvas.style.cursor = id ? 'pointer' : 'grab';
      }
      if (id) redraw();
      else if (view3d.hover === null && canvas.__lastHover) redraw();
      canvas.__lastHover = id;
      return;
    }
    const dx = event.clientX - view3d.drag.x;
    const dy = event.clientY - view3d.drag.y;
    view3d.drag.moved = Math.max(view3d.drag.moved, Math.abs(dx) + Math.abs(dy));
    view3d.yaw = view3d.drag.yaw + dx * 0.008;
    // Clamped: past vertical the floor turns inside out, and level with it the
    // columns collapse into a line.
    view3d.pitch = Math.min(1.25, Math.max(0.18, view3d.drag.pitch + dy * 0.006));
    redraw();
  });

  /** Which column is under a point — any face of it, not only the lid. */
  const columnAt = (point) => {
    // Nearest first, so where two columns overlap the one in front wins.
    for (const hit of [...(canvas.__hits ?? [])].reverse()) {
      if (hit.faces.some((quad) => inside(point, quad))) return hit;
    }
    return null;
  };

  const release = (event) => {
    const drag = view3d.drag;
    view3d.drag = null;
    if (!drag || drag.moved > 6) return; // a turn, not a tap
    const hit = columnAt(pointAt(event));
    if (hit) go('register', hit.row.id);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', () => {
    view3d.drag = null;
  });

  canvas.addEventListener('pointerleave', () => {
    if (view3d.hover === null) return;
    view3d.hover = null;
    view3d.pointer = null;
    canvas.__lastHover = null;
    redraw();
  });

  // Sized by its container, so it has to be measured after it is on the page.
  requestAnimationFrame(() => {
    redraw();
    startSpin();
  });

  // Observed rather than listening on `window`: the dashboard re-renders often,
  // and a window listener per render accumulates for the life of the tab. An
  // observer is collected with the canvas it watches.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => canvas.isConnected && redraw()).observe(canvas);
  }

  const busiest = rows.reduce((best, r) => ((r.total ?? 0) > (best?.total ?? -1) ? r : best), null);

  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'The department, as a landscape'),
      h(
        'span',
        { class: 'hint' },
        `${rows.length} register${rows.length === 1 ? '' : 's'}${
          busiest && busiest.total > 0 ? ` · largest is ${busiest.short} at ${busiest.total}` : ''
        }`,
      ),
    ),
    h('div', { class: 'landscape-frame' }, canvas),
    h(
      'div',
      { class: 'toolbar landscape-controls' },
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: () => {
            view3d.spin = !view3d.spin;
            render();
          },
          'aria-pressed': String(view3d.spin),
        },
        view3d.spin ? 'Stop spinning' : 'Spin',
      ),
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: () => {
            Object.assign(view3d, VIEW3D_HOME);
            drawLandscape(canvas, rows);
          },
        },
        'Reset view',
      ),
      h('span', { class: 'hint' }, 'Drag to look around · click a column to open that register'),
    ),
    legend([
      { label: 'Overdue', color: COLOR.overdue },
      { label: `Due within ${state.config.dueSoonDays} days`, color: COLOR.dueSoon },
      { label: 'Open, on track', color: COLOR.later },
      { label: 'Closed', color: 'var(--good)' },
    ]),
    h(
      'p',
      { class: 'hint', style: 'margin: 2px 0 0' },
      'Each column is one register, stacked by state with the overdue work on top. Height follows the square root of the total, so one very large register does not flatten the rest, and a state with only a job or two in it is given a visible minimum rather than a hairline. Point at a column for the exact figures.',
    ),
  );
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…');

  const t = data.totals;

  return h(
    'div',
    { class: 'content' },

    h(
      'div',
      { class: 'kpis' },
      kpi(
        'Total Jobs',
        t.all,
        `across ${myRegisters().length} register${myRegisters().length === 1 ? '' : 's'}`,
      ),
      kpi('Open', t.open, 'still to do'),
      kpi('Closed', t.closed, 'completed, cancelled or archived'),
      kpi(`Due in ${state.config.dueSoonDays} days`, t.dueSoon, 'the month ahead'),
      kpi('Completed', t.completed, 'finished, not cancelled'),
      kpi('Overdue', t.overdue, 'past their due date', t.overdue > 0 ? 'is-critical' : null),
    ),

    render3dLandscape(data.byRegister),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Each register at a glance'),
        h('span', { class: 'hint' }, 'click a register to open it'),
      ),
      legend([
        { label: 'Overdue', color: COLOR.overdue },
        { label: `Due within ${state.config.dueSoonDays} days`, color: COLOR.dueSoon },
        { label: 'Open', color: COLOR.later },
        { label: 'Closed', color: 'var(--good)' },
      ]),
      h(
        'div',
        { class: 'register-grid' },
        data.byRegister.map((row) =>
          h(
            'button',
            { class: 'register-card', onclick: () => go('register', row.id) },
            h('h3', null, row.name),
            donut(
              [
                { value: row.overdue, color: COLOR.overdue, label: 'Overdue' },
                { value: row.dueSoon, color: COLOR.dueSoon, label: 'Due soon' },
                { value: row.later, color: COLOR.later, label: 'Open' },
                { value: row.closed, color: 'var(--good)', label: 'Closed' },
              ],
              row.total,
            ),
            h(
              'dl',
              { class: 'register-figures' },
              figure('Open', row.open),
              figure('Overdue', row.overdue, row.overdue ? 'is-critical' : null),
              figure(`Due ≤${state.config.dueSoonDays}d`, row.dueSoon, row.dueSoon ? 'is-warning' : null),
              figure('Closed', row.closed),
            ),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Needs attention'),
        h('span', { class: 'hint' }, `overdue and due within ${state.config.dueSoonDays} days`),
      ),
      data.attention.length
        ? h(
            'div',
            { class: 'table-wrap', style: 'border: 0' },
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, 'Register'),
                  h('th', null, 'Ref'),
                  h('th', null, 'Description'),
                  h('th', null, 'Priority'),
                  h('th', null, 'Due'),
                  h('th', null, 'Action by'),
                  h('th', null, 'Initiator'),
                ),
              ),
              h(
                'tbody',
                null,
                data.attention.map((row) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => openRecord(row.id, row.register) },
                    h('td', { class: 'muted' }, registerById(row.register)?.short ?? row.register),
                    h('td', null, h('span', { class: 'cell-ref' }, row.ref ?? '—')),
                    h('td', null, h('span', { class: 'cell-title', title: row.title ?? '' }, row.title ?? '—')),
                    h('td', null, priorityChip(row.priority)),
                    h(
                      'td',
                      null,
                      h('span', { class: `chip s-${row.days < 0 ? 'overdue' : 'due-soon'}` }, row.days < 0 ? `${Math.abs(row.days)}d late` : `in ${row.days}d`),
                      h('div', { class: 'hint' }, row.dueDate),
                    ),
                    h('td', null, row.actionBy ?? h('span', { class: 'muted' }, 'Unassigned')),
                    h('td', { class: 'muted' }, row.initiator ?? '—'),
                  ),
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'Nothing overdue or due in the next month. '),
    ),

    data.activity?.length &&
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, 'Recent changes')),
        h('div', { class: 'activity-list' }, data.activity.slice(0, 8).map(activityItem)),
      ),
  );
}

function kpi(label, value, note, tone = null) {
  return h(
    'div',
    { class: `kpi ${tone ?? ''}` },
    h('div', { class: 'k-label' }, label),
    h('div', { class: 'k-value' }, value),
    h('div', { class: 'k-note' }, note),
  );
}

const figure = (label, value, tone = null) =>
  h(
    'div',
    { class: `figure ${tone ?? ''}` },
    h('dt', null, label),
    h('dd', null, value),
  );

const activityItem = (entry) =>
  h(
    'div',
    { class: 'activity-item' },
    h('span', { class: 'who' }, entry.actor ?? 'Someone'),
    h('span', null, entry.summary ?? entry.action),
    h('span', { class: 'when' }, fmtWhen(entry.at)),
  );

// ---------------------------------------------------------------- register --

let searchTimer = null;

function renderRegister() {
  const register = registerById(state.registerId);
  if (!register) return h('div', { class: 'empty' }, 'Unknown register.');

  const list = state.list;
  const q = state.query;

  const byKey = new Map(register.fields.map((f) => [f.key, f]));
  const columns = (register.tableColumns ?? []).map((key) => byKey.get(key)).filter(Boolean);

  const setQuery = (patch, reload = true) => {
    Object.assign(state.query, patch);
    if (!('page' in patch)) state.query.page = 1;
    if (reload) loadList();
    else render();
  };

  /**
   * Which of this register's own columns the list can sort by.
   *
   * Sorting runs on the derived values, so only the columns filling a role have a
   * sort key. The rest are shown but not sortable — a header that looks clickable
   * and then does nothing is worse than one that plainly is not.
   */
  const roles = register.roles;
  const sortKeyFor = (fieldKey) =>
    ({
      [roles.ref]: 'ref',
      [roles.title]: 'title',
      [roles.due]: 'dueDate',
      [roles.priority]: 'priority',
      [roles.status]: 'status',
      [roles.actionBy]: 'actionBy',
      [roles.initiator]: 'initiator',
      [roles.area]: 'area',
    })[fieldKey] ?? null;

  const sortHeader = (label, key, extra = {}) =>
    key
      ? h(
          'th',
          {
            class: `sortable ${extra.class ?? ''}`,
            tabindex: '0',
            onclick: () =>
              setQuery({
                sort: key,
                direction: q.sort === key && q.direction === 'asc' ? 'desc' : 'asc',
              }),
          },
          `${label}${q.sort === key ? (q.direction === 'asc' ? ' ↑' : ' ↓') : ''}`,
        )
      : h('th', { class: extra.class ?? '' }, label);

  const select = (label, key, options, allLabel = 'All') =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h(
        'select',
        { value: q[key] ?? '', onchange: (e) => setQuery({ [key]: e.target.value }) },
        h('option', { value: '' }, allLabel),
        options.map((option) =>
          h(
            'option',
            { value: option.value ?? option, selected: (q[key] ?? '') === (option.value ?? option) },
            option.label ?? option,
          ),
        ),
      ),
    );

  return h(
    'div',
    { class: 'content' },

    h(
      'div',
      { class: 'toolbar' },
      h(
        'label',
        { class: 'field grow' },
        h('span', null, 'Search'),
        h('input', {
          type: 'search',
          id: 'register-search',
          value: q.search,
          placeholder: 'Reference, description, tag, person…',
          oninput: (e) => {
            state.query.search = e.target.value;
            state.query.page = 1;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(loadList, 280);
          },
        }),
      ),
      // Area offers both plants whether or not this register has rows for them
      // yet, so filtering to DCU is possible the moment the first DCU row lands.
      byKey.has('area') &&
        select(
          'Area',
          'area',
          [...new Set([...(state.config.areas ?? []), ...state.filterOptions.area])],
          'All areas',
        ),
      select('Priority', 'priority', state.config.priorities),
      select('Status', 'status', state.config.statuses),
      select('Action by', 'actionBy', state.filterOptions.actionBy, 'Anyone'),
      select(
        'Due',
        'due',
        [
          { value: 'overdue', label: 'Overdue' },
          { value: 'due-soon', label: `Next ${state.config.dueSoonDays} days` },
          { value: 'dated', label: 'Has a date' },
          { value: 'undated', label: 'No date set' },
        ],
        'Any time',
      ),
      h(
        'label',
        { class: 'switch', style: 'padding-bottom: 8px' },
        h('input', {
          type: 'checkbox',
          checked: q.open,
          onchange: (e) => setQuery({ open: e.target.checked }),
        }),
        'Open only',
      ),
    ),

    h(
      'div',
      { class: 'toolbar' },
      canWrite() &&
        h(
          'button',
          { class: 'btn primary', onclick: () => openNew(register.id) },
          '+ Add entry',
        ),
      canWrite() && h('button', { class: 'btn', onclick: () => go('import') }, 'Import from Excel'),
      h(
        'button',
        { class: 'btn', onclick: () => download(`/api/export?register=${register.id}`) },
        'Export this register',
      ),
      h(
        'button',
        { class: 'btn ghost', onclick: () => download(`/api/template?register=${register.id}`) },
        'Blank template',
      ),
      h('div', { class: 'spacer' }),
      list &&
        h(
          'div',
          { class: 'pager' },
          `${list.total} ${list.total === 1 ? 'entry' : 'entries'}`,
          list.pageCount > 1 &&
            h(
              'button',
              { class: 'btn sm', disabled: list.page <= 1, onclick: () => setQuery({ page: list.page - 1 }) },
              '‹ Prev',
            ),
          list.pageCount > 1 && `Page ${list.page} of ${list.pageCount}`,
          list.pageCount > 1 &&
            h(
              'button',
              {
                class: 'btn sm',
                disabled: list.page >= list.pageCount,
                onclick: () => setQuery({ page: list.page + 1 }),
              },
              'Next ›',
            ),
        ),
    ),

    !list
      ? h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…')
      : list.rows.length === 0
        ? h(
            'div',
            { class: 'card empty' },
            h('p', null, 'Nothing here yet.'),
            h(
              'p',
              { class: 'hint' },
              'Add an entry by hand, or import the sheet from your Excel file.',
            ),
          )
        : h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  // The sheets all open with a row number and the team reads by it,
                  // so the position is shown — but computed from the current page
                  // rather than stored, because a stored serial is wrong the moment
                  // anything is sorted, filtered or inserted.
                  h('th', { class: 'num' }, '#'),
                  columns.map((field) =>
                    sortHeader(field.label, sortKeyFor(field.key), {
                      class: field.type === 'number' || field.type === 'percent' ? 'num' : '',
                    }),
                  ),
                  sortHeader('Updated', 'updatedAt'),
                ),
              ),
              h(
                'tbody',
                null,
                list.rows.map((record, i) =>
                  h(
                    'tr',
                    { class: 'clickable', tabindex: '0', onclick: () => openRecord(record.id, record.register) },
                    h('td', { class: 'num muted' }, (list.page - 1) * list.pageSize + i + 1),
                    columns.map((field) => cell(register, record, field)),
                    h('td', { class: 'muted' }, fmtWhen(record.updatedAt)),
                  ),
                ),
              ),
            ),
          ),

    renderImportHistory(register.id),
  );
}

// ------------------------------------------------------------------ drawer --

async function openRecord(id, registerId) {
  try {
    const record = await api(`/api/records/${id}`);
    state.drawer = { record, registerId: registerId ?? record.register, isNew: false, draft: {} };
    render();
  } catch (error) {
    toast(error.message);
  }
}

function openNew(registerId) {
  state.drawer = {
    record: { id: null, register: registerId, data: {} },
    registerId,
    isNew: true,
    draft: {},
    // Whether the reference shown is still the one the app suggested. Cleared
    // the moment somebody types in that field, which is how the server knows to
    // honour what they wrote instead of issuing a number of its own.
    autoRef: false,
  };
  render();

  // Shown as soon as the form opens, but it is a preview rather than a
  // reservation — the number is issued for real when Save is pressed, so
  // opening the form and thinking better of it does not consume one and leave
  // a gap in the sequence.
  const register = registerById(registerId);
  if (!register?.autoNumber) return;

  api(`/api/registers/${registerId}/next-ref`)
    .then(({ ref, field }) => {
      const drawer = state.drawer;
      // The form may have been closed, or another one opened, while this was
      // in flight.
      if (!drawer?.isNew || drawer.registerId !== registerId) return;
      if (drawer.draft[field]) return; // they typed faster than the network
      drawer.draft[field] = ref;
      drawer.autoRef = true;
      render();
    })
    // A failure here costs the convenience, not the entry: the field stays
    // empty and can be filled in by hand.
    .catch(() => {});
}

/**
 * One upload slot, used twice.
 *
 * The logos are uploaded rather than shipped with the app: nobody's trademark
 * belongs in somebody else's source tree, the file is then whatever the brand
 * team actually issued rather than something redrawn from a screenshot, and the
 * next site to use this supplies its own without a code change.
 */
function logoSlot(slot, label) {
  const current = state.logos?.[slot] ?? null;
  const inputId = `logo-input-${slot}`;

  const put = async (logo) => {
    try {
      await api('/api/report/logo', { method: 'PUT', json: { slot, logo } });
      state.logos = { ...(state.logos ?? {}), [slot]: logo };
      toast(logo ? 'Saved — it is on the next export and report.' : 'Removed.');
      render();
    } catch (error) {
      toast(error.message);
    }
  };

  return h(
    'div',
    { style: 'flex: 1 1 260px; min-width: 240px' },
    h('div', { class: 'nav-label', style: 'padding-left: 0' }, label),
    h(
      'div',
      {
        // A fixed frame so an empty slot and a filled one are the same size and
        // the two sit level, whatever shape the images are.
        style:
          'height: 64px; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--line); border-radius: 6px; margin-bottom: 10px; padding: 6px',
      },
      current
        ? h('img', { src: current, alt: `${label} logo`, style: 'max-height: 50px; max-width: 100%' })
        : h('span', { class: 'hint' }, 'None yet'),
    ),
    h('input', {
      type: 'file',
      id: inputId,
      accept: 'image/png,image/jpeg',
      style: 'display: none',
      onchange: (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => put(reader.result);
        reader.readAsDataURL(file);
      },
    }),
    h(
      'div',
      { class: 'toolbar' },
      h(
        'button',
        { class: 'btn primary', type: 'button', onclick: () => $(`#${inputId}`).click() },
        current ? 'Replace' : 'Upload',
      ),
      current ? h('button', { class: 'btn', type: 'button', onclick: () => put(null) }, 'Remove') : null,
    ),
  );
}

const AUTO_REF_HINTS = {
  auto: 'Numbered automatically — the serial restarts each month. Type over it to use your own.',
  manual: 'Using the number you typed instead of the automatic one.',
};

function renderDrawer() {
  const { record, registerId, isNew, draft } = state.drawer;
  const register = registerById(registerId);
  if (!register) return null;

  const valueOf = (key) => (key in draft ? draft[key] : (record.data?.[key] ?? ''));

  const fieldInput = (field) => {
    const write = (e) => {
      draft[field.key] = e.target.value;
      // Typing over an issued number means they want their own. From here the
      // server honours what is in the box rather than allocating.
      if (register.autoNumber?.field === field.key) {
        state.drawer.autoRef = false;
        // Updated in place rather than by re-rendering: re-rendering the field
        // somebody is typing in takes the cursor with it. Without this the hint
        // went on claiming the number was automatic after they had replaced it.
        const note = $(`#hint-${field.key}`);
        if (note) note.textContent = AUTO_REF_HINTS.manual;
      }
    };

    const common = {
      id: `f-${field.key}`,
      value: valueOf(field.key),
      oninput: write,
      onchange: write,
    };

    if (field.type === 'longtext') return h('textarea', common);

    if (field.type === 'select') {
      return h(
        'select',
        {
          ...common,
          onchange: (e) => {
            draft[field.key] = e.target.value;
            // Priority and status drive the row's colour and the dashboard, so the
            // drawer redraws immediately rather than waiting for a save.
            render();
          },
        },
        // An imported row often has no Status or Priority cell at all. Saying so is
        // clearer than a bare dash, because the table shows the fallback the app
        // applies ("Not Started", "Medium") and the two would otherwise disagree.
        h('option', { value: '' }, '— not set'),
        field.options.map((option) =>
          h('option', { value: option, selected: String(valueOf(field.key)) === option }, option),
        ),
      );
    }

    if (field.type === 'date') {
      // A date column may legitimately hold a phrase — "Next Shutdown" is two of
      // the eight ETCs in the real Action Notice sheet. So the picker is what
      // you get, and typing a phrase stays possible rather than being refused.
      //
      // The input follows the value: a stored phrase opens as a text box, so
      // editing an old row never silently discards what it says. An empty field
      // opens as a picker, which is what somebody entering a date expects.
      const raw = String(valueOf(field.key) ?? '');
      const looksLikeDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) || raw === '';
      const forcedText = state.drawer.textFields?.[field.key] === true;
      const asText = forcedText || !looksLikeDate;

      // Offered on the register's own due field, where the phrases actually
      // occur, and whenever the box is already text so there is always a way
      // back to the picker. Every other date field is just a date.
      const offerToggle = register.roles?.due === field.key || asText;

      return [
        h('input', {
          ...common,
          type: asText ? 'text' : 'date',
          placeholder: asText ? 'e.g. Next Shutdown' : null,
        }),
        offerToggle
          ? h(
              'button',
              {
                type: 'button',
                class: 'linkish',
                onclick: () => {
                  state.drawer.textFields = { ...(state.drawer.textFields ?? {}) };
                  state.drawer.textFields[field.key] = !asText;
                  // Clear a value the other input cannot hold, rather than
                  // leaving a date picker showing blank over a stored phrase.
                  if (asText) draft[field.key] = looksLikeDate ? raw : '';
                  render();
                },
              },
              asText ? 'Use the date picker' : 'Enter text instead',
            )
          : null,
      ];
    }

    if (field.type === 'number' || field.type === 'percent') {
      return h('input', { ...common, type: 'number' });
    }

    return h('input', { ...common, type: 'text' });
  };

  const extraKeys = Object.keys(record.data ?? {}).filter((key) => key.startsWith('extra:'));

  /**
   * Enter saves, the way it does on the sign-in form.
   *
   * The drawer is a stack of inputs rather than a `<form>`, so Enter did
   * nothing at all — somebody filling in a notice had to reach for the mouse
   * for the one action they were already finished with.
   *
   * Not in a textarea: Enter there is a new line, and Description and Remarks
   * are the fields most likely to want one. Not on a date input either, where
   * the browser's own picker uses Enter to accept a date.
   */
  const submitOnEnter = (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const el = event.target;
    if (el.tagName === 'TEXTAREA' || el.type === 'date') return;
    event.preventDefault();
    save();
  };

  const save = async () => {
    try {
      const payload = isNew ? { ...(record.data ?? {}), ...draft } : draft;
      if (isNew) {
        const created = await api('/api/records', {
          json: { register: registerId, data: payload, autoRef: state.drawer.autoRef === true },
        });
        // The number the server actually issued, which may not be the one
        // previewed if somebody else saved in the meantime.
        toast(created?.ref ? `Added ${created.ref}.` : 'Entry added.');
      } else {
        await api(`/api/records/${record.id}`, { method: 'PATCH', json: { data: payload } });
        toast('Saved.');
      }
      state.drawer = null;
      if (state.view === 'register') loadList();
      else loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this entry for everyone? This cannot be undone.')) return;
    try {
      await api(`/api/records/${record.id}`, { method: 'DELETE' });
      toast('Deleted.');
      state.drawer = null;
      if (state.view === 'register') loadList();
      else loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  };

  return h(
    'div',
    {
      class: 'scrim',
      onclick: (event) => {
        if (event.target === event.currentTarget) {
          state.drawer = null;
          render();
        }
      },
    },
    h(
      'div',
      { class: 'drawer' },
      h(
        'header',
        null,
        h(
          'h2',
          null,
          isNew ? `New ${register.name} entry` : (record.ref ?? register.name),
        ),
        !isNew && priorityChip(draft.priority ?? record.priority),
        !isNew && dueChip(record),
        h(
          'button',
          {
            class: 'btn ghost sm',
            onclick: () => {
              state.drawer = null;
              render();
            },
          },
          '✕',
        ),
      ),

      h(
        'div',
        { class: 'body', onkeydown: submitOnEnter },
        !isNew &&
          h(
            'p',
            { class: 'hint' },
            `Last updated ${fmtWhen(record.updatedAt)}${record.updatedBy ? ` by ${record.updatedBy}` : ''}${record.source?.startsWith('import:') ? ` · from ${record.source.slice(7)}` : ''}`,
          ),

        register.fields.map((field) =>
          h(
            'label',
            { class: 'field' },
            h('span', null, field.label),
            fieldInput(field),
            // Said once, on the field it applies to: the number is chosen for
            // them, and typing over it is allowed rather than a mistake.
            isNew && register.autoNumber?.field === field.key
              ? h(
                  'span',
                  { class: 'hint', id: `hint-${field.key}` },
                  state.drawer.autoRef ? AUTO_REF_HINTS.auto : AUTO_REF_HINTS.manual,
                )
              : null,
          ),
        ),

        extraKeys.length > 0 &&
          h(
            'div',
            null,
            h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Extra columns from the sheet'),
            extraKeys.map((key) =>
              h(
                'label',
                { class: 'field', style: 'margin-bottom: 10px' },
                h('span', null, key.slice(6)),
                h('input', {
                  type: 'text',
                  value: valueOf(key),
                  oninput: (e) => {
                    draft[key] = e.target.value;
                  },
                }),
              ),
            ),
          ),
      ),

      h(
        'footer',
        null,
        !isNew && canWrite() && h('button', { class: 'btn danger', onclick: remove }, 'Delete'),
        h('div', { class: 'spacer', style: 'flex: 1' }),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.drawer = null;
              render();
            },
          },
          canWrite() ? 'Cancel' : 'Close',
        ),
        canWrite() &&
          h('button', { class: 'btn primary', onclick: save }, isNew ? 'Add entry' : 'Save changes'),
      ),
    ),
  );
}

// ------------------------------------------------------------------ import --

/** Registers that more than one selected sheet feeds, as [name, count] pairs. */
function combinedRegisters(imp) {
  const counts = new Map();
  for (const choice of imp.choices ?? []) {
    if (!choice.include || !choice.register) continue;
    counts.set(choice.register, (counts.get(choice.register) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => [registerById(id)?.name ?? id, count]);
}

function renderImport() {
  const imp = state.importState;

  const inspect = async (file) => {
    if (!file) return;
    state.importState = { stage: 'reading', filename: file.name };
    render();
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await api('/api/import/inspect', { method: 'POST', body });
      // Choices made the last time this same file was uploaded win over the
      // detector's guess: if someone corrected a mapping once, they should not
      // have to correct it again every month.
      const remembered = new Map(
        (result.remembered ?? []).map((choice) => [choice.sheet, choice]),
      );

      state.importState = {
        stage: 'confirm',
        filename: result.filename,
        token: result.token,
        sheets: result.sheets,
        reused: remembered.size > 0,
        // Sheets the reader could not identify, or that hold no rows, start switched
        // off — importing an empty sheet is never what anyone meant to do.
        choices: result.sheets.map((sheet) => {
          const previous = remembered.get(sheet.name);
          return {
            include: Boolean(previous?.register ?? sheet.suggestedRegister) && sheet.dataRows > 0,
            register: previous?.register ?? sheet.suggestedRegister ?? '',
            mode: previous?.mode ?? 'replace',
          };
        }),
      };
    } catch (error) {
      state.importState = { stage: 'error', message: error.message };
    }
    render();
  };

  const commit = async () => {
    const selections = imp.sheets
      .map((sheet, i) => ({ sheet: sheet.name, ...imp.choices[i] }))
      .filter((choice) => choice.include && choice.register)
      .map(({ sheet, register, mode }) => ({ sheet, register, mode }));

    if (!selections.length) return toast('Tick at least one sheet to import.');

    state.importState = { ...imp, stage: 'importing' };
    render();
    try {
      const result = await api('/api/import/commit', {
        json: { token: imp.token, selections },
      });
      state.importState = { stage: 'done', filename: imp.filename, results: result.results };
      state.imports = null;
      loadDashboard();
    } catch (error) {
      state.importState = { ...imp, stage: 'confirm', error: error.message };
    }
    render();
  };

  if (!imp || imp.stage === 'error') {
    return h(
      'div',
      { class: 'content' },
      imp?.message && h('div', { class: 'banner error' }, imp.message),
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, 'Import from Excel')),
        h(
          'p',
          { class: 'hint', style: 'margin-top: -6px; margin-bottom: 14px' },
          'Upload your Engineering Master file or an Action Notice sheet. Every sheet in the workbook is read separately, and you choose which register each one goes into.',
        ),
        h(
          'div',
          {
            class: 'dropzone',
            ondragover: (e) => {
              e.preventDefault();
              e.currentTarget.classList.add('over');
            },
            ondragleave: (e) => e.currentTarget.classList.remove('over'),
            ondrop: (e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('over');
              inspect(e.dataTransfer.files[0]);
            },
          },
          h('p', { style: 'margin: 0 0 12px; font-size: 15px' }, 'Drop an .xlsx file here'),
          h('p', { class: 'hint', style: 'margin: 0 0 16px' }, 'or'),
          h('input', {
            type: 'file',
            id: 'file-input',
            accept: '.xlsx,.xlsm',
            style: 'display: none',
            onchange: (e) => inspect(e.target.files[0]),
          }),
          h(
            'button',
            { class: 'btn primary', onclick: () => $('#file-input').click() },
            'Choose a file',
          ),
        ),
      ),
      renderImportHistory(),
    );
  }

  if (imp.stage === 'reading' || imp.stage === 'importing') {
    return h(
      'div',
      { class: 'content' },
      h(
        'div',
        { class: 'card empty' },
        h('span', { class: 'spin' }),
        ' ',
        imp.stage === 'reading' ? `Reading ${imp.filename}…` : 'Importing…',
      ),
    );
  }

  if (imp.stage === 'done') {
    return h(
      'div',
      { class: 'content' },
      h(
        'section',
        { class: 'card' },
        h('header', null, h('h2', null, `Imported from ${imp.filename}`)),
        h(
          'div',
          { class: 'table-wrap', style: 'border: 0' },
          h(
            'table',
            null,
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, 'Sheet'),
                h('th', null, 'Register'),
                h('th', { class: 'num' }, 'Rows added'),
                h('th', { class: 'num' }, 'Replaced'),
                h('th', { class: 'num' }, 'Blank rows skipped'),
                h('th', { class: 'num' }, 'Without a due date'),
              ),
            ),
            h(
              'tbody',
              null,
              imp.results.map((result) =>
                h(
                  'tr',
                  null,
                  h('td', null, result.sheet),
                  h(
                    'td',
                    null,
                    result.error
                      ? h('span', { class: 'chip s-overdue' }, result.error)
                      : result.registerName,
                  ),
                  h('td', { class: 'num' }, result.imported ?? '—'),
                  h('td', { class: 'num muted' }, result.replaced || '—'),
                  h('td', { class: 'num muted' }, result.skippedBlankRows || '—'),
                  h('td', { class: 'num muted' }, result.undated || '—'),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: 'display: flex; gap: 8px; margin-top: 16px' },
          h('button', { class: 'btn primary', onclick: () => go('dashboard') }, 'Go to dashboard'),
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                state.importState = null;
                render();
              },
            },
            'Import another file',
          ),
        ),
      ),
    );
  }

  // stage === 'confirm'
  return h(
    'div',
    { class: 'content' },
    imp.error && h('div', { class: 'banner error' }, imp.error),
    imp.reused &&
      h(
        'div',
        { class: 'banner info' },
        'Filled in from the last time this file was imported. Change anything that is different this month.',
      ),
    // Several sheets feeding one register is normal — an SHP master sheet and a
    // DCU master sheet both belong in IWS — but it is worth saying out loud that
    // they combine, because "Replace" on each of them reads like each one wins.
    combinedRegisters(imp).map(([name, count]) =>
      h(
        'div',
        { class: 'banner info' },
        `${count} sheets go into ${name}. They will be added together, not one over the other.`,
      ),
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, `${imp.filename} — ${imp.sheets.length} sheet${imp.sheets.length === 1 ? '' : 's'}`),
        h('span', { class: 'hint' }, 'check each one, then import'),
      ),
      h(
        'div',
        { style: 'display: flex; flex-direction: column; gap: 12px' },
        imp.sheets.map((sheet, i) => {
          const choice = imp.choices[i];
          return h(
            'div',
            { class: `sheet-card${choice.include ? '' : ' off'}` },
            h(
              'div',
              { class: 'sheet-head' },
              h(
                'label',
                { class: 'switch' },
                h('input', {
                  type: 'checkbox',
                  checked: choice.include,
                  onchange: (e) => {
                    choice.include = e.target.checked;
                    render();
                  },
                }),
                h('strong', null, sheet.name),
              ),
              h('span', { class: 'pill' }, `${sheet.dataRows} data row${sheet.dataRows === 1 ? '' : 's'}`),
              sheet.headerRow && h('span', { class: 'pill' }, `header on row ${sheet.headerRow}`),
              !sheet.suggestedRegister &&
                h('span', { class: 'chip s-overdue' }, 'Not recognised — choose a register'),
            ),

            h(
              'div',
              { class: 'sheet-controls' },
              h(
                'label',
                { class: 'field' },
                h('span', null, 'Import into'),
                h(
                  'select',
                  {
                    value: choice.register,
                    onchange: (e) => {
                      choice.register = e.target.value;
                      render();
                    },
                  },
                  h('option', { value: '' }, 'Choose a register…'),
                  state.config.registers.map((register) =>
                    h(
                      'option',
                      { value: register.id, selected: choice.register === register.id },
                      register.name,
                    ),
                  ),
                ),
              ),
              h(
                'label',
                { class: 'field' },
                h('span', null, 'How'),
                h(
                  'select',
                  {
                    value: choice.mode,
                    onchange: (e) => {
                      choice.mode = e.target.value;
                      render();
                    },
                  },
                  h(
                    'option',
                    { value: 'replace', selected: choice.mode === 'replace' },
                    'Replace everything in this register',
                  ),
                  h('option', { value: 'append', selected: choice.mode === 'append' }, 'Add to what is there'),
                ),
              ),
            ),

            sheet.mappedColumns?.length > 0 &&
              h(
                'div',
                { class: 'hint' },
                `Matched ${sheet.mappedColumns.length} columns: ${sheet.mappedColumns.map((c) => c.label).join(', ')}`,
              ),
            sheet.unmappedColumns?.length > 0 &&
              h(
                'div',
                { class: 'hint' },
                `Kept as extra columns: ${sheet.unmappedColumns.join(', ')}`,
              ),

            // Said before importing, not discovered afterwards in a row count.
            sheet.missingKeyColumns?.length > 0 &&
              h(
                'div',
                { class: 'banner warn', style: 'margin-top: 4px' },
                sheet.missingKeyColumns
                  .map(({ role, label }) =>
                    role === 'due'
                      ? `No "${label}" column found in this sheet — all ${sheet.dataRows} rows will import with no due date, and will not appear in Overdue or Due in ${state.config.dueSoonDays} days. Check the heading spelling in Excel, or set the dates in the app afterwards.`
                      : `No "${label}" column found in this sheet.`,
                  )
                  .join(' '),
              ),
          );
        }),
      ),

      h(
        'div',
        { style: 'display: flex; gap: 8px; margin-top: 18px; align-items: center' },
        h('button', { class: 'btn primary', onclick: commit }, 'Import selected sheets'),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              state.importState = null;
              render();
            },
          },
          'Cancel',
        ),
        h(
          'span',
          { class: 'hint' },
          '“Replace” clears that register first — use it when the sheet is the master copy.',
        ),
      ),
    ),
  );
}

/**
 * The workbooks imported so far.
 *
 * Kept because "which file did these rows come from?" is a real question months
 * later, and the answer should be the file itself rather than somebody's memory.
 */
function renderImportHistory(registerId = null) {
  const scope = registerId ?? 'all';

  if (state.imports === null || state.importsScope !== scope) {
    state.importsScope = scope;
    api(`/api/imports${registerId ? `?register=${registerId}` : ''}`)
      .then((data) => {
        state.imports = data.imports;
        render();
      })
      .catch(() => {
        state.imports = [];
      });
    return null;
  }

  if (!state.imports.length) return null;

  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, registerId ? 'Files imported into this register' : 'Previously imported'),
      h('span', { class: 'hint' }, 'the last 20 uploads'),
    ),
    h(
      'div',
      { class: 'table-wrap', style: 'border: 0' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'File'),
            !registerId && h('th', null, 'Sheets imported'),
            h('th', null, 'Uploaded by'),
            h('th', null, 'When'),
            h('th', { class: 'num' }, 'Rows'),
            h('th', null, ''),
          ),
        ),
        h(
          'tbody',
          null,
          state.imports.map((entry) =>
            h(
              'tr',
              null,
              h('td', null, h('span', { class: 'cell-ref' }, entry.filename)),
              !registerId &&
                h(
                  'td',
                  { class: 'muted' },
                  (entry.results ?? [])
                    .filter((r) => r.registerName)
                    .map((r) => r.registerName)
                    .join(', ') || '—',
                ),
              h('td', null, entry.uploadedBy ?? '—'),
              h('td', { class: 'muted' }, fmtWhen(entry.uploadedAt)),
              h(
                'td',
                { class: 'num' },
                (entry.results ?? [])
                  .filter((r) => !registerId || r.register === registerId)
                  .reduce((sum, r) => sum + (r.imported ?? 0), 0),
              ),
              h(
                'td',
                null,
                entry.contentStored === false
                  ? h('span', { class: 'hint' }, 'not stored offline')
                  : h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: () => download(`/api/imports/${entry.id}/file`),
                      },
                      `↓ ${kb(entry.sizeBytes)}`,
                    ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- activity --

function renderActivity() {
  return h(
    'div',
    { class: 'content' },
    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Recent changes'), h('span', { class: 'hint' }, 'newest first')),
      state.activity === null
        ? h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…')
        : state.activity.length === 0
          ? h('div', { class: 'empty' }, 'No changes recorded yet.')
          : h('div', { class: 'activity-list' }, state.activity.map(activityItem)),
    ),
  );
}


// ---------------------------------------------------------------- settings --

const userDraft = { registers: [] };

/** Transport names as somebody reading the screen would recognise them. */
const MAIL_PROVIDER_LABELS = {
  graph: 'Microsoft 365 (Outlook)',
  smtp: 'SMTP',
  brevo: 'Brevo',
  resend: 'Resend',
};

/**
 * Daily email reminders.
 *
 * The schedule itself lives outside this app — a free instance sleeps after
 * fifteen minutes, so an in-process timer would simply not fire. Something
 * external calls `/api/reminders/run` each morning; this screen is where the
 * rules, the recipients and the evidence of what was sent live.
 *
 * The mail password is deliberately not here. It is an environment variable on
 * the host, so it cannot leave in a database backup — this screen can see
 * whether mail works and say what is missing, but never what the password is.
 */
function renderReminders() {
  const data = state.reminders;
  if (!data) return null;

  const config = data.config;
  const save = async (patch, message) => {
    try {
      const result = await api('/api/reminders', { method: 'PUT', json: { ...config, ...patch } });
      state.reminders = { ...data, config: result.config, bandsToday: result.bandsToday };
      if (message) toast(message);
      render();
    } catch (error) {
      toast(error.message);
    }
  };

  const number = (label, key, hint, min, max) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        value: String(config[key]),
        title: hint,
        onchange: (e) => save({ [key]: Number(e.target.value) }),
      }),
    );

  const check = (key, label, hint) =>
    h(
      'label',
      { style: 'display: flex; gap: 9px; align-items: flex-start; cursor: pointer' },
      h('input', {
        type: 'checkbox',
        checked: config[key] ? 'checked' : null,
        style: 'margin-top: 3px',
        onchange: (e) => save({ [key]: e.target.checked }),
      }),
      h('span', null, label, hint && h('span', { class: 'hint', style: 'display: block' }, hint)),
    );

  const preview = state.reminderPreview;

  return h(
    'section',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'Daily email reminders'),
      h('span', { class: 'hint' }, config.enabled ? 'on' : 'off'),
    ),

    // What is missing, in the order it has to be fixed. A screen full of
    // settings that cannot possibly send is worse than one that says why.
    !data.mail.configured
      ? h(
          'div',
          { class: 'banner warn', style: 'margin-bottom: 14px' },
          h('strong', null, 'No mail account is connected yet. '),
          data.mail.problem,
        )
      : h(
          'div',
          { class: 'banner ok', style: 'margin-bottom: 14px' },
          `Sending through ${MAIL_PROVIDER_LABELS[data.mail.provider] ?? data.mail.provider} as ${data.mail.from}.`,
        ),

    data.scheduleConfigured
      ? null
      : h(
          'div',
          { class: 'banner info', style: 'margin-bottom: 14px' },
          'No schedule secret is set, so nothing can trigger the daily run automatically. Set TRACKER_REMINDER_SECRET on the host to switch the schedule on. You can still send from here.',
        ),

    h(
      'div',
      { style: 'display: flex; flex-direction: column; gap: 14px' },
      check(
        'enabled',
        'Send reminders automatically',
        'When this is off, the scheduled run does nothing and reminders only go out if you send them from here.',
      ),

      h(
        'div',
        { class: 'toolbar' },
        number('Remind daily within (days)', 'dailyWithinDays', 'Jobs due this many days from now are emailed every day.', 0, 365),
        number('Mention jobs up to (days)', 'windowDays', 'Jobs further away than this are not mentioned at all.', 1, 365),
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Weekly look-ahead on'),
          h(
            'select',
            { onchange: (e) => save({ weeklyOn: e.target.value }) },
            (data.weekdays ?? []).map((day) =>
              h('option', { value: day, selected: config.weeklyOn === day }, day),
            ),
          ),
        ),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -4px 0 0' },
        `Overdue jobs and anything due within ${config.dailyWithinDays} days are emailed every day. Jobs due in ${
          config.dailyWithinDays + 1
        }–${config.windowDays} days go out once a week, on ${config.weeklyOn} — daily on those would drown the urgent ones.`,
      ),

      check('includeOverdue', 'Include jobs that are already overdue'),
      check(
        'sendWhenEmpty',
        'Email people who have nothing due',
        'Off by default. A digest that arrives every morning saying "nothing" is a digest people stop opening.',
      ),

      h(
        'label',
        { class: 'field' },
        h('span', null, 'Link back to the tracker'),
        h('input', {
          type: 'url',
          value: config.appUrl ?? '',
          placeholder: 'https://engineering-tracker.onrender.com',
          style: 'width: 100%',
          onchange: (e) => save({ appUrl: e.target.value }, 'Saved.'),
        }),
      ),

      h(
        'label',
        { class: 'field' },
        h('span', null, 'Also send to (one address per line)'),
        h('textarea', {
          rows: '3',
          placeholder: 'engineering.dept@company.com',
          value: (config.extraRecipients ?? []).join('\n'),
          onchange: (e) =>
            save(
              { extraRecipients: e.target.value.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean) },
              'Saved.',
            ),
        }),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -4px 0 0' },
        'Everyone with an account is emailed already, covering only the registers their account can open. Addresses here have no account, so they receive everything.',
      ),

      h(
        'div',
        { class: 'toolbar' },
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              try {
                state.reminderPreview = await api('/api/reminders/preview');
                render();
              } catch (error) {
                toast(error.message);
              }
            },
          },
          'Show who gets one today',
        ),
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: async () => {
              state.reminderTest = { ok: null, message: 'Sending…' };
              render();
              try {
                const result = await api('/api/reminders/test', { json: {} });
                state.reminderTest = { ok: true, message: `Test sent to ${result.to}. Check your inbox.` };
              } catch (error) {
                // Not a toast. A mail server's refusal runs to several lines,
                // is the thing you act on, and is what IT will ask you to
                // forward — none of which survives disappearing after three
                // seconds.
                state.reminderTest = { ok: false, message: error.message };
              }
              render();
            },
          },
          'Send a test to me',
        ),
        h(
          'button',
          {
            class: 'btn primary',
            type: 'button',
            onclick: async () => {
              if (!confirm("Send today's reminders to the whole team now?")) return;
              try {
                // Forced: the admin has just said to send it, so the
                // already-sent-today guard is not what they meant.
                const result = await api('/api/reminders/run', { json: { force: true } });
                toast(
                  result.sent
                    ? `Sent ${result.sent} email${result.sent === 1 ? '' : 's'}${
                        result.failed ? `, ${result.failed} failed` : ''
                      }.`
                    : 'Nobody had anything due, so nothing was sent.',
                );
                state.reminders = null;
                state.users = null;
                render();
              } catch (error) {
                toast(error.message);
              }
            },
          },
          'Send now',
        ),
      ),
    ),

    state.reminderTest
      ? h(
          'div',
          {
            class: `banner ${state.reminderTest.ok === false ? 'error' : state.reminderTest.ok ? 'ok' : 'info'}`,
            // `pre-wrap` because a mail server's answer is several lines and
            // its line breaks are where the meaning is.
            style: 'margin-top: 14px; white-space: pre-wrap',
          },
          state.reminderTest.message,
          state.reminderTest.ok === false &&
            h(
              'button',
              {
                class: 'btn ghost',
                type: 'button',
                style: 'display: block; margin-top: 10px',
                onclick: () => {
                  state.reminderTest = null;
                  render();
                },
              },
              'Dismiss',
            ),
        )
      : null,

    preview &&
      h(
        'div',
        { style: 'margin-top: 18px' },
        h(
          'div',
          { class: 'nav-label', style: 'padding-left: 0' },
          `${preview.date} (${preview.weekday}) — ${preview.messages.length} would be emailed`,
        ),
        preview.messages.length
          ? h(
              'div',
              { class: 'table-wrap' },
              h(
                'table',
                null,
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, 'To'),
                    h('th', null, 'Overdue'),
                    h('th', null, 'Due soon'),
                    h('th', null, 'Coming up'),
                    h('th', null, 'Theirs'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  preview.messages.map((m) =>
                    h(
                      'tr',
                      { key: m.to },
                      h('td', null, m.name ? `${m.name} · ${m.to}` : m.to),
                      h('td', null, String(m.counts.overdue)),
                      h('td', null, String(m.counts.urgent)),
                      h('td', null, String(m.counts.soon)),
                      h('td', null, String(m.counts.mine)),
                    ),
                  ),
                ),
              ),
            )
          : h('p', { class: 'hint' }, 'Nobody has anything due today.'),
        // A ternary, not `&&`: a length of 0 is falsy but still a value, and
        // `h()` rendered it as a literal "0" under the buttons.
        preview.skipped.length
          ? h(
              'p',
              { class: 'hint' },
              `Not emailed: ${preview.skipped.map((s) => s.name || s.to).join(', ')} — nothing due.`,
            )
          : null,
      ),

    data.runs?.length
      ? h(
          'div',
          { style: 'margin-top: 18px' },
          h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Recent runs'),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              null,
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, 'When'),
                  h('th', null, 'Triggered by'),
                  h('th', null, 'Sent'),
                  h('th', null, 'Failed'),
                ),
              ),
              h(
                'tbody',
                null,
                data.runs.map((run) =>
                  h(
                    'tr',
                    { key: run.at },
                    h('td', null, String(run.at).slice(0, 16).replace('T', ' ')),
                    h('td', null, run.trigger),
                    h('td', null, String(run.sent)),
                    h(
                      'td',
                      { style: run.failed ? 'color: var(--critical)' : '' },
                      run.failed ? String(run.failed) : '—',
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
  );
}

/**
 * Accounts and what each person may do.
 *
 * Two dimensions, because they answer different questions: the role says what
 * kind of thing somebody may do, and the register list says where. A contractor
 * who updates only PDM findings is an editor limited to PDM — expressing that
 * as a role would mean inventing a role per combination.
 */
function renderSettings() {
  if (!hasConfirmation()) {
    state.view = 'dashboard';
    state.confirmPrompt = { error: null };
    return h('div', { class: 'content' }, h('div', { class: 'empty' }, 'Confirm your password to continue.'));
  }

  if (!canManage()) {
    return h('div', { class: 'content' }, h('div', { class: 'banner error' }, 'Only an admin can open Settings.'));
  }

  if (state.users === null) {
    api('/api/report/logo')
      .then((data) => {
        state.logos = { left: data.left ?? data.logo ?? null, right: data.right ?? null };
        render();
      })
      .catch(() => {});

    api('/api/reminders')
      .then((data) => {
        state.reminders = data;
        render();
      })
      // Not fatal: the offline build has no reminders, and Settings must still
      // open if this one endpoint is unavailable.
      .catch(() => {});

    api('/api/users')
      .then((data) => {
        state.users = data.users;
        render();
      })
      .catch((error) => {
        state.users = [];
        toast(error.message);
      });
    return h('div', { class: 'content' }, h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading…'));
  }

  const reload = () => {
    state.users = null;
    render();
  };

  const registerCheckboxes = (selected, onToggle) =>
    h(
      'div',
      { class: 'register-picker' },
      h(
        'label',
        { class: 'switch' },
        h('input', {
          type: 'checkbox',
          checked: selected.length === 0,
          onchange: (e) => onToggle(e.target.checked ? [] : (state.config.registers ?? []).map((r) => r.id)),
        }),
        h('strong', null, 'All registers'),
      ),
      (state.config.registers ?? []).map((register) =>
        h(
          'label',
          { class: 'switch' },
          h('input', {
            type: 'checkbox',
            checked: selected.length === 0 || selected.includes(register.id),
            disabled: selected.length === 0,
            onchange: (e) =>
              onToggle(
                e.target.checked
                  ? [...new Set([...selected, register.id])]
                  : selected.filter((id) => id !== register.id),
              ),
          }),
          register.name,
        ),
      ),
    );

  const saveUser = async (user, patch) => {
    try {
      await api(`/api/users/${user.id}`, { method: 'PATCH', json: patch });
      toast(`Saved ${user.name}.`);
      reload();
    } catch (error) {
      toast(error.message);
    }
  };

  return h(
    'div',
    { class: 'content' },

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Your team'),
        h('span', { class: 'hint' }, `${state.users.length} account${state.users.length === 1 ? '' : 's'}`),
      ),
      h(
        'div',
        { class: 'table-wrap', style: 'border: 0' },
        h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Name'),
              h('th', null, 'Email'),
              h('th', null, 'Can do'),
              h('th', null, 'Registers'),
              h('th', null, 'Last signed in'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            state.users.map((user) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h('span', { class: 'cell-ref' }, user.name),
                  user.id === state.me?.id && h('div', { class: 'hint' }, 'that is you'),
                  !user.active && h('div', null, h('span', { class: 'chip s-overdue' }, 'switched off')),
                ),
                h('td', { class: 'muted' }, user.email),
                h(
                  'td',
                  null,
                  h(
                    'select',
                    {
                      value: user.role,
                      onchange: (e) => saveUser(user, { role: e.target.value }),
                    },
                    (state.authState?.roles ?? []).map((r) =>
                      h('option', { value: r.value, selected: user.role === r.value }, roleLabel(r.value)),
                    ),
                  ),
                  h(
                    'div',
                    { class: 'hint', style: 'max-width: 260px' },
                    (state.authState?.roles ?? []).find((r) => r.value === user.role)?.description ?? '',
                  ),
                ),
                h(
                  'td',
                  null,
                  registerCheckboxes(user.registers ?? [], (registers) => saveUser(user, { registers })),
                ),
                h('td', { class: 'muted' }, user.lastLoginAt ? fmtWhen(user.lastLoginAt) : 'never'),
                h(
                  'td',
                  { style: 'white-space: nowrap' },
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: () => saveUser(user, { active: !user.active }),
                    },
                    user.active ? 'Switch off' : 'Switch on',
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: async () => {
                        const password = prompt(`New password for ${user.name} (at least 8 characters):`);
                        if (!password) return;
                        await saveUser(user, { password });
                      },
                    },
                    'Set password',
                  ),
                  ' ',
                  user.id !== state.me?.id &&
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: async () => {
                          if (!confirm(`Remove the account for ${user.name}?`)) return;
                          try {
                            await api(`/api/users/${user.id}`, { method: 'DELETE' });
                            toast('Account removed.');
                            reload();
                          } catch (error) {
                            toast(error.message);
                          }
                        },
                      },
                      'Remove',
                    ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Add someone')),
      h(
        'form',
        {
          style: 'display: flex; flex-direction: column; gap: 14px',
          onsubmit: async (event) => {
            event.preventDefault();
            try {
              await api('/api/users', { json: { ...userDraft } });
              toast(`${userDraft.name} can now sign in.`);
              userDraft.name = '';
              userDraft.email = '';
              userDraft.password = '';
              userDraft.registers = [];
              reload();
            } catch (error) {
              toast(error.message);
            }
          },
        },
        h(
          'div',
          { class: 'toolbar' },
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'Name'),
            h('input', {
              type: 'text',
              id: 'new-name',
              value: userDraft.name ?? '',
              placeholder: 'e.g. Rehan',
              required: 'required',
              oninput: (e) => {
                userDraft.name = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'Email'),
            h('input', {
              type: 'email',
              id: 'new-email',
              value: userDraft.email ?? '',
              placeholder: 'rehan@company.com',
              required: 'required',
              oninput: (e) => {
                userDraft.email = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field grow' },
            h('span', null, 'First password'),
            h('input', {
              type: 'text',
              id: 'new-password',
              value: userDraft.password ?? '',
              placeholder: 'At least 8 characters',
              required: 'required',
              oninput: (e) => {
                userDraft.password = e.target.value;
              },
            }),
          ),
          h(
            'label',
            { class: 'field' },
            h('span', null, 'Can do'),
            h(
              'select',
              {
                value: userDraft.role ?? 'viewer',
                onchange: (e) => {
                  userDraft.role = e.target.value;
                  render();
                },
              },
              (state.authState?.roles ?? []).map((r) =>
                h('option', { value: r.value, selected: (userDraft.role ?? 'viewer') === r.value }, roleLabel(r.value)),
              ),
            ),
          ),
        ),
        h(
          'div',
          null,
          h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Which registers'),
          registerCheckboxes(userDraft.registers ?? [], (registers) => {
            userDraft.registers = registers;
            render();
          }),
        ),
        h(
          'p',
          { class: 'hint', style: 'margin: 0' },
          'You will need to tell them this password yourself — the app does not email invitations. They can change it once they are in.',
        ),
        h(
          'div',
          null,
          h('button', { class: 'btn primary', type: 'submit' }, 'Create account'),
        ),
      ),
    ),

    h(
      'section',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Logos'),
        h('span', { class: 'hint' }, 'on every export and report'),
      ),
      h(
        'p',
        { class: 'hint', style: 'margin: -6px 0 14px' },
        'PNG or JPG, under about 400 KB each, ideally wide with a transparent or white background. They appear at the top of every Excel export and on the PDF report — the left one first, the right one opposite it, with the title between.',
      ),
      h(
        'div',
        { style: 'display: flex; gap: 28px; flex-wrap: wrap' },
        logoSlot('left', 'Left — your company'),
        logoSlot('right', 'Right — the client'),
      ),
      h(
        'div',
        { class: 'toolbar', style: 'margin-top: 16px' },
        h(
          'button',
          { class: 'btn ghost', type: 'button', onclick: () => download('/api/report.pdf') },
          'Preview the report',
        ),
        h(
          'button',
          { class: 'btn ghost', type: 'button', onclick: () => download('/api/export') },
          'Preview an export',
        ),
      ),
    ),

    renderReminders(),

    h(
      'section',
      { class: 'card' },
      h('header', null, h('h2', null, 'Your password')),
      h(
        'form',
        {
          class: 'toolbar',
          onsubmit: async (event) => {
            event.preventDefault();
            const currentPassword = $('#current-password').value;
            const newPassword = $('#next-password').value;
            try {
              await api('/api/auth/password', { json: { currentPassword, newPassword } });
              toast('Password changed.');
              $('#current-password').value = '';
              $('#next-password').value = '';
            } catch (error) {
              toast(error.message);
            }
          },
        },
        h(
          'label',
          { class: 'field grow' },
          h('span', null, 'Current password'),
          h('input', { type: 'password', id: 'current-password', required: 'required' }),
        ),
        h(
          'label',
          { class: 'field grow' },
          h('span', null, 'New password'),
          h('input', { type: 'password', id: 'next-password', required: 'required' }),
        ),
        h('button', { class: 'btn', type: 'submit' }, 'Change password'),
      ),
    ),
  );
}

// ------------------------------------------------------------- duty rota --
//
// The safety duty rota: who covers which task, in which area, in which week.
// Everything about *how* the duties are shared out lives on the server in
// `rota.js`; this is the screen for it. The two writes it makes — save the
// document, fill it again — each come back with the whole document, so the
// screen never has to guess what the server decided.

const ROTA_AREAS = ['SHP', 'DCU'];

const ROTA_TABS = [
  ['kpi', 'Safety KPI'],
  ['walkthrough', 'Walkthrough'],
  ['weekend', 'Weekend'],
  ['person', 'By person'],
  ['team', 'Team'],
];

const rotaDoc = () => state.rota?.rota ?? null;

const rotaNameOf = (id) => rotaDoc()?.people.find((person) => person.id === id)?.name ?? '—';

async function loadRota() {
  state.busy = true;
  render();
  try {
    state.rota = await api('/api/rota');
    if (!state.rotaPerson || !state.rota.rota.people.some((p) => p.id === state.rotaPerson)) {
      state.rotaPerson = state.rota.rota.people[0]?.id ?? null;
    }
    state.error = null;
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * Change the rota by editing a copy and sending the whole thing back.
 *
 * A rejected save is almost always somebody else having saved first, so the
 * answer is to show their version rather than to retry ours over the top of it.
 */
async function pushRota(mutate, note) {
  const doc = rotaDoc();
  if (!doc) return;

  const next = JSON.parse(JSON.stringify(doc));
  mutate(next);

  state.busy = true;
  render();
  try {
    state.rota = await api('/api/rota', { method: 'PUT', json: next });
    state.error = null;
    state.busy = false;
    if (note) toast(note);
    render();
  } catch (error) {
    state.busy = false;
    toast(error.message);
    await loadRota();
  }
}

async function fillRotaNow(parts, note) {
  const doc = rotaDoc();
  if (!doc) return;

  state.busy = true;
  render();
  try {
    state.rota = await api('/api/rota/fill', { method: 'POST', json: { rev: doc.rev, parts } });
    state.error = null;
    state.busy = false;
    toast(note);
    render();
  } catch (error) {
    state.busy = false;
    toast(error.message);
    await loadRota();
  }
}

/** Read one person's duties out of the document. No scheduling decisions here. */
function rotaDutiesFor(personId) {
  const payload = state.rota;
  const doc = payload?.rota;
  if (!doc || !personId) return [];

  const duties = [];
  for (const week of payload.calendar) {
    for (const task of doc.tasks) {
      for (const area of ROTA_AREAS) {
        if ((doc.kpi.data[week.week]?.[task.key]?.[area] ?? []).includes(personId)) {
          duties.push({ week, what: task.key, area, when: null, kind: 'KPI' });
        }
      }
    }
    for (const area of ROTA_AREAS) {
      if ((doc.wt.data[week.mondayIso]?.[area] ?? []).includes(personId)) {
        duties.push({ week, what: 'Walkthrough', area, when: week.mondayText, kind: 'Walkthrough' });
      }
    }
    if ((doc.we.data[week.saturdayIso] ?? []).includes(personId)) {
      duties.push({
        week,
        what: 'Weekend cover',
        area: null,
        when: week.saturdayText,
        kind: 'Weekend',
      });
    }
  }
  return duties;
}

function rotaCountsFor(personId) {
  const duties = rotaDutiesFor(personId);
  const of = (kind) => duties.filter((duty) => duty.kind === kind).length;
  return { kpi: of('KPI'), wt: of('Walkthrough'), we: of('Weekend'), total: duties.length };
}

const areaChip = (area, label) =>
  h('span', { class: `chip a-${area.toLowerCase()}` }, label ?? area);

// ---- this week ------------------------------------------------------------

function renderDutyBoard() {
  const week = state.rota?.thisWeek;

  if (!week) {
    return h(
      'div',
      { class: 'card' },
      h('header', null, h('h2', null, 'On duty this week')),
      h(
        'div',
        { class: 'hint' },
        'This week falls outside the planned window. Set the start week under Schedule on the Safety KPI tab.',
      ),
    );
  }

  const card = (title, names, tone) =>
    h(
      'div',
      { class: `duty-card${tone ? ` is-${tone}` : ''}` },
      h('h3', null, title),
      h(
        'div',
        { class: 'names' },
        names.length
          ? names
          : h('span', { class: 'hint' }, 'Nobody assigned'),
      ),
    );

  return h(
    'div',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'On duty this week'),
      h('span', { class: 'hint' }, `${week.label} · ${week.range}`),
    ),
    h(
      'div',
      { class: 'duty-board' },
      week.tasks.map((task) =>
        card(
          task.key,
          ROTA_AREAS.flatMap((area) =>
            (task.areas[area] ?? []).map((name) => areaChip(area, `${area} · ${name}`)),
          ),
        ),
      ),
      ROTA_AREAS.map((area) =>
        card(
          `Walkthrough · ${area}`,
          (week.walkthrough[area] ?? []).map((name) => areaChip(area, name)),
          area.toLowerCase(),
        ),
      ),
      card(
        'Weekend cover',
        week.weekend.map((name) => h('span', { class: 'chip p-medium' }, name)),
      ),
    ),
  );
}

// ---- safety KPI -----------------------------------------------------------

function renderRotaSchedule() {
  const doc = rotaDoc();

  const number = (id, label, value, min, max, apply) =>
    h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h('input', {
        type: 'number',
        id,
        min: String(min),
        max: String(max),
        value: String(value),
        onchange: (event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) pushRota((draft) => apply(draft, next));
        },
      }),
    );

  return h(
    'details',
    { class: 'card' },
    h(
      'summary',
      null,
      h('strong', null, 'Schedule and targets'),
      h(
        'span',
        { class: 'hint', style: 'margin-left: 10px' },
        `${doc.weeks} weeks from ${state.rota.calendar[0]?.mondayText ?? '—'}`,
      ),
    ),
    h(
      'div',
      { style: 'margin-top: 14px' },
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Start week (Monday)'),
          h('input', {
            type: 'date',
            id: 'rota-start',
            value: doc.startISO,
            onchange: (event) => {
              if (event.target.value) {
                pushRota((draft) => {
                  draft.startISO = event.target.value;
                });
              }
            },
          }),
        ),
        number('rota-weeks', 'Weeks', doc.weeks, 1, 53, (draft, value) => {
          draft.weeks = value;
        }),
        number('rota-wt', 'Walkthrough per area', doc.wtPerArea, 1, 8, (draft, value) => {
          draft.wtPerArea = value;
        }),
        number('rota-we', 'People per weekend', doc.wePerDate, 1, 4, (draft, value) => {
          draft.wePerDate = value;
        }),
      ),

      h('div', { class: 'nav-label', style: 'padding-left: 0' }, 'Weekly target per task'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', null, 'Task'),
              h('th', null, 'SHP'),
              h('th', null, 'DCU'),
              h('th', null, 'Per week'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            doc.tasks.map((task, index) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h('input', {
                    type: 'text',
                    value: task.key,
                    id: `rota-task-${index}`,
                    style: 'max-width: 110px',
                    onchange: (event) => {
                      pushRota((draft) => {
                        draft.tasks[index].key = event.target.value;
                      });
                    },
                  }),
                ),
                ROTA_AREAS.map((area) =>
                  h(
                    'td',
                    null,
                    h('input', {
                      type: 'number',
                      min: '0',
                      max: '8',
                      value: String(task[area]),
                      id: `rota-task-${index}-${area}`,
                      style: 'max-width: 80px',
                      onchange: (event) => {
                        pushRota((draft) => {
                          draft.tasks[index][area] = Number(event.target.value);
                        });
                      },
                    }),
                  ),
                ),
                h('td', null, String(task.SHP + task.DCU)),
                h(
                  'td',
                  null,
                  h(
                    'button',
                    {
                      class: 'btn ghost sm',
                      onclick: () =>
                        pushRota((draft) => {
                          draft.tasks.splice(index, 1);
                        }, 'Task removed'),
                    },
                    'Remove',
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
      h(
        'button',
        {
          class: 'btn sm',
          style: 'margin-top: 10px',
          onclick: () =>
            pushRota((draft) => {
              draft.tasks.push({ key: `TASK${draft.tasks.length + 1}`, SHP: 1, DCU: 1 });
            }, 'Task added'),
        },
        'Add task',
      ),
    ),
  );
}

function renderRotaKpi() {
  const payload = state.rota;
  const doc = payload.rota;
  const editable = canWrite();

  const toggle = (week, taskKey, area, personId) =>
    pushRota((draft) => {
      const forWeek = (draft.kpi.data[week] = draft.kpi.data[week] ?? {});
      const forTask = (forWeek[taskKey] = forWeek[taskKey] ?? {});
      const list = (forTask[area] ?? []).slice();
      const at = list.indexOf(personId);
      if (at >= 0) list.splice(at, 1);
      else list.push(personId);
      forTask[area] = list;
      draft.kpi.locked[`${week}|${taskKey}|${area}`] = true;
    });

  const head = h(
    'thead',
    null,
    h(
      'tr',
      null,
      h('th', { class: 'c-name', rowspan: '3' }, 'Team member'),
      h('th', { class: 'c-area', rowspan: '3' }, 'Area'),
      payload.calendar.map((week) =>
        h(
          'th',
          { class: 'wk-head wk-sep', colspan: String(doc.tasks.length) },
          week.label,
          h('span', { class: 'wk-dates' }, week.range),
        ),
      ),
    ),
    h(
      'tr',
      null,
      payload.calendar.flatMap(() =>
        doc.tasks.map((task, index) => h('th', { class: index === 0 ? 'wk-sep' : '' }, task.key)),
      ),
    ),
    h(
      'tr',
      null,
      payload.calendar.flatMap(() =>
        doc.tasks.map((task, index) =>
          h('th', { class: `tgt${index === 0 ? ' wk-sep' : ''}` }, `${task.SHP}+${task.DCU}`),
        ),
      ),
    ),
  );

  const body = h(
    'tbody',
    null,
    doc.people.flatMap((person) =>
      ROTA_AREAS.map((area, areaIndex) =>
        h(
          'tr',
          null,
          areaIndex === 0 &&
            h(
              'td',
              {
                class: 'c-name',
                rowspan: String(ROTA_AREAS.length),
                style: person.active ? null : 'color: var(--ink-muted)',
              },
              person.active ? person.name : `${person.name} (away)`,
            ),
          h('td', { class: `c-area is-${area.toLowerCase()}` }, area),
          payload.calendar.flatMap((week) =>
            doc.tasks.map((task, taskIndex) => {
              const on = (doc.kpi.data[week.week]?.[task.key]?.[area] ?? []).includes(person.id);
              const edited = Boolean(doc.kpi.locked[`${week.week}|${task.key}|${area}`]);
              const classes = [
                'slot',
                `is-${area.toLowerCase()}`,
                on ? 'on' : '',
                edited ? 'edited' : '',
                taskIndex === 0 ? 'wk-sep' : '',
                editable ? '' : 'readonly',
              ]
                .filter(Boolean)
                .join(' ');

              return h(
                'td',
                {
                  class: classes,
                  title: `${person.name} · ${task.key} · ${area} · ${week.label}`,
                  onclick: editable ? () => toggle(week.week, task.key, area, person.id) : null,
                },
                on ? '1' : '',
              );
            }),
          ),
        ),
      ),
    ),
  );

  const foot = h(
    'tfoot',
    null,
    h(
      'tr',
      null,
      h('td', { class: 'c-name' }, 'Total'),
      h('td', { class: 'c-area' }, ''),
      payload.calendar.flatMap((week) =>
        doc.tasks.map((task, index) => {
          const got = ROTA_AREAS.reduce(
            (sum, area) => sum + (doc.kpi.data[week.week]?.[task.key]?.[area] ?? []).length,
            0,
          );
          const want = task.SHP + task.DCU;
          return h(
            'td',
            {
              class: `${got < want ? 'short ' : ''}${index === 0 ? 'wk-sep' : ''}`,
              title: `Target ${want}`,
            },
            String(got),
          );
        }),
      ),
    ),
  );

  return [
    editable && renderRotaSchedule(),
    h(
      'div',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'KPI matrix'),
        h(
          'span',
          { class: 'hint' },
          payload.unfilled
            ? `${payload.unfilled} slot${payload.unfilled === 1 ? '' : 's'} still unfilled`
            : 'Every target met',
        ),
        editable &&
          h(
            'button',
            {
              class: 'btn sm',
              onclick: () =>
                pushRota((draft) => {
                  draft.kpi.locked = {};
                }, 'Hand edits cleared'),
            },
            'Clear edits',
          ),
        editable &&
          h(
            'button',
            {
              class: 'btn primary sm',
              onclick: () => fillRotaNow({ wt: false, we: false }, 'KPI rota filled'),
            },
            'Fill KPI',
          ),
      ),
      h(
        'div',
        { class: 'hint', style: 'margin-bottom: 10px' },
        editable
          ? 'Click a cell to move a name in or out. An edited cell keeps a corner mark, and the next fill works around it.'
          : 'Your account has view-only access, so the cells are not editable.',
      ),
      h('div', { class: 'table-wrap' }, h('table', { class: 'rota-grid' }, head, body, foot)),
    ),
  ];
}

// ---- walkthrough and weekend ---------------------------------------------

function rotaPicker(currentId, area, onPick) {
  const doc = rotaDoc();
  return h(
    'select',
    {
      class: `rota-pick${area ? ` is-${area.toLowerCase()}` : ''}`,
      disabled: !canWrite(),
      onchange: (event) => onPick(event.target.value),
    },
    h('option', { value: '', selected: !currentId }, '— not set —'),
    doc.people.map((person) =>
      h(
        'option',
        { value: person.id, selected: person.id === currentId },
        person.active ? person.name : `${person.name} (away)`,
      ),
    ),
  );
}

function renderRotaWalkthrough() {
  const payload = state.rota;
  const doc = payload.rota;

  const setPerson = (dateIso, area, index, personId) =>
    pushRota((draft) => {
      const slot = (draft.wt.data[dateIso] = draft.wt.data[dateIso] ?? {});
      const list = (slot[area] ?? []).slice();
      while (list.length < draft.wtPerArea) list.push(null);
      list[index] = personId || null;
      slot[area] = list.filter(Boolean);
      draft.wt.locked[`${dateIso}|${area}`] = true;
    });

  return h(
    'div',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'Internal walkthrough'),
      h('span', { class: 'hint' }, `${doc.wtPerArea} per area, every Monday`),
      canWrite() &&
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () =>
              pushRota((draft) => {
                draft.wt.locked = {};
              }, 'Hand edits cleared'),
          },
          'Clear edits',
        ),
      canWrite() &&
        h(
          'button',
          {
            class: 'btn primary sm',
            onclick: () => fillRotaNow({ kpi: false, we: false }, 'Walkthrough rota filled'),
          },
          'Fill walkthrough',
        ),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Week'),
            h('th', null, 'Date'),
            h('th', null, 'Area'),
            Array.from({ length: doc.wtPerArea }, (_, i) => h('th', null, `Person ${i + 1}`)),
          ),
        ),
        h(
          'tbody',
          null,
          payload.calendar.flatMap((week) =>
            ROTA_AREAS.map((area, areaIndex) => {
              const list = doc.wt.data[week.mondayIso]?.[area] ?? [];
              return h(
                'tr',
                null,
                areaIndex === 0 && h('td', { rowspan: '2' }, week.label),
                areaIndex === 0 && h('td', { rowspan: '2' }, week.mondayText),
                h('td', null, areaChip(area)),
                Array.from({ length: doc.wtPerArea }, (_, i) =>
                  h(
                    'td',
                    null,
                    rotaPicker(list[i], area, (value) =>
                      setPerson(week.mondayIso, area, i, value),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
    ),
  );
}

function renderRotaWeekend() {
  const payload = state.rota;
  const doc = payload.rota;

  const setPerson = (dateIso, index, personId) =>
    pushRota((draft) => {
      const list = (draft.we.data[dateIso] ?? []).slice();
      while (list.length < draft.wePerDate) list.push(null);
      list[index] = personId || null;
      draft.we.data[dateIso] = list.filter(Boolean);
      draft.we.locked[dateIso] = true;
    });

  const soFar = new Map();

  return h(
    'div',
    { class: 'card' },
    h(
      'header',
      null,
      h('h2', null, 'Weekend coverage'),
      h('span', { class: 'hint' }, 'Strict rotation — nobody takes a second before everybody has a first'),
      canWrite() &&
        h(
          'button',
          {
            class: 'btn sm',
            onclick: () =>
              pushRota((draft) => {
                draft.we.locked = {};
              }, 'Hand edits cleared'),
          },
          'Clear edits',
        ),
      canWrite() &&
        h(
          'button',
          {
            class: 'btn primary sm',
            onclick: () => fillRotaNow({ kpi: false, wt: false }, 'Weekend rota filled'),
          },
          'Fill weekends',
        ),
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        null,
        h(
          'thead',
          null,
          h(
            'tr',
            null,
            h('th', null, 'Week'),
            h('th', null, 'Saturday'),
            Array.from({ length: doc.wePerDate }, () => h('th', null, 'On cover')),
            h('th', null, 'Turns so far'),
          ),
        ),
        h(
          'tbody',
          null,
          payload.calendar.map((week) => {
            const list = doc.we.data[week.saturdayIso] ?? [];
            for (const id of list) soFar.set(id, (soFar.get(id) ?? 0) + 1);
            return h(
              'tr',
              null,
              h('td', null, week.label),
              h('td', null, week.saturdayText),
              Array.from({ length: doc.wePerDate }, (_, i) =>
                h('td', null, rotaPicker(list[i], null, (value) => setPerson(week.saturdayIso, i, value))),
              ),
              h(
                'td',
                { class: 'hint' },
                list.map((id) => `${rotaNameOf(id)} ×${soFar.get(id)}`).join(', ') || '—',
              ),
            );
          }),
        ),
      ),
    ),
  );
}

// ---- by person ------------------------------------------------------------

function rotaPersonText(personId) {
  const lines = [`${rotaNameOf(personId)} — duty list`];
  const byWeek = new Map();

  for (const duty of rotaDutiesFor(personId)) {
    if (!byWeek.has(duty.week.week)) byWeek.set(duty.week.week, { week: duty.week, items: [] });
    byWeek.get(duty.week.week).items.push(duty);
  }
  if (!byWeek.size) return `${lines[0]}\nNothing assigned.`;

  for (const group of byWeek.values()) {
    lines.push('');
    lines.push(`${group.week.week}  (${group.week.range})`);
    for (const duty of group.items) {
      lines.push(
        `  - ${duty.what}${duty.area ? ` — ${duty.area}` : ''}${duty.when ? ` — ${duty.when}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

function renderRotaPerson() {
  const doc = rotaDoc();
  const personId = state.rotaPerson ?? doc.people[0]?.id ?? null;
  const counts = rotaCountsFor(personId);

  const byWeek = new Map();
  for (const duty of rotaDutiesFor(personId)) {
    if (!byWeek.has(duty.week.week)) byWeek.set(duty.week.week, { week: duty.week, items: [] });
    byWeek.get(duty.week.week).items.push(duty);
  }

  const tile = (label, value) =>
    h('div', { class: 'kpi' }, h('div', { class: 'k-label' }, label), h('div', { class: 'k-value' }, String(value)));

  return [
    h(
      'div',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'By person'),
        h('span', { class: 'hint' }, 'Everything one person owes — copy it and send it to them'),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h(
          'label',
          { class: 'field' },
          h('span', null, 'Person'),
          h(
            'select',
            {
              id: 'rota-person',
              onchange: (event) => {
                state.rotaPerson = event.target.value;
                render();
              },
            },
            doc.people.map((person) =>
              h('option', { value: person.id, selected: person.id === personId }, person.name),
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const text = rotaPersonText(personId);
              try {
                await navigator.clipboard.writeText(text);
                toast('Copied the duty list.');
              } catch {
                // Clipboard access is refused on an insecure origin and in some
                // locked-down browsers. Selecting the text is the way out.
                window.prompt('Copy the duty list:', text);
              }
            },
          },
          'Copy as text',
        ),
      ),
    ),
    h('div', { class: 'kpis' }, tile('KPI duties', counts.kpi), tile('Walkthroughs', counts.wt), tile('Weekends', counts.we), tile('Total', counts.total)),
    byWeek.size
      ? h(
          'div',
          null,
          [...byWeek.values()].map((group) =>
            h(
              'div',
              { class: 'person-week' },
              h(
                'header',
                null,
                h('span', { class: 'wk' }, group.week.week),
                h('span', { class: 'hint' }, group.week.range),
              ),
              h(
                'ul',
                null,
                group.items.map((duty) =>
                  h(
                    'li',
                    null,
                    duty.area ? areaChip(duty.area) : h('span', { class: 'chip p-medium' }, 'Weekend'),
                    h('span', null, duty.what),
                    h('span', { class: 'meta' }, duty.when ?? duty.kind),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('div', { class: 'card' }, h('div', { class: 'hint' }, 'Nothing assigned in this window yet.')),
  ];
}

// ---- team -----------------------------------------------------------------

function renderRotaTeam() {
  const doc = rotaDoc();
  const editable = canWrite();
  const rows = doc.people.map((person) => ({ person, counts: rotaCountsFor(person.id) }));
  const most = Math.max(1, ...rows.map((row) => row.counts.total));

  return [
    h(
      'div',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Team'),
        h('span', { class: 'hint' }, 'Untick somebody on leave and the next fill skips them'),
        editable &&
          h(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                const name = window.prompt('Name of the new team member?');
                if (!name || !name.trim()) return;
                pushRota((draft) => {
                  const ids = new Set(draft.people.map((p) => p.id));
                  let id = `p${draft.people.length + 1}`;
                  while (ids.has(id)) id = `${id}x`;
                  draft.people.push({ id, name: name.trim(), active: true });
                }, 'Added to the team');
              },
            },
            'Add person',
          ),
      ),
      h(
        'div',
        { class: 'team-list' },
        doc.people.map((person, index) =>
          h(
            'div',
            { class: `team-row${person.active ? '' : ' is-off'}` },
            editable
              ? h('input', {
                  type: 'text',
                  value: person.name,
                  id: `rota-person-${index}`,
                  onchange: (event) =>
                    pushRota((draft) => {
                      draft.people[index].name = event.target.value;
                    }),
                })
              : h('strong', { style: 'flex: 1 1 100%' }, person.name),
            h(
              'label',
              { class: 'switch' },
              h('input', {
                type: 'checkbox',
                checked: person.active,
                disabled: !editable,
                onchange: (event) =>
                  pushRota((draft) => {
                    draft.people[index].active = event.target.checked;
                  }),
              }),
              h('span', null, 'Available'),
            ),
            editable &&
              h(
                'button',
                {
                  class: 'btn ghost sm',
                  onclick: () => {
                    if (!window.confirm(`Remove ${person.name}? Their duties are cleared too.`)) return;
                    pushRota((draft) => {
                      draft.people.splice(index, 1);
                    }, 'Removed from the team');
                  },
                },
                'Remove',
              ),
          ),
        ),
      ),
    ),

    h(
      'div',
      { class: 'card' },
      h(
        'header',
        null,
        h('h2', null, 'Workload balance'),
        h('span', { class: 'hint' }, 'Across the whole planned window'),
      ),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              ['Person', 'KPI', 'Walkthrough', 'Weekend', 'Total', 'Share'].map((label) =>
                h('th', null, label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map(({ person, counts }) =>
              h(
                'tr',
                null,
                h('td', null, person.active ? person.name : `${person.name} (away)`),
                h('td', null, String(counts.kpi)),
                h('td', null, String(counts.wt)),
                h('td', null, String(counts.we)),
                h('td', null, String(counts.total)),
                h(
                  'td',
                  null,
                  h(
                    'div',
                    { class: 'bar-track', title: `${counts.total} duties` },
                    h('div', {
                      class: 'bar-fill',
                      style: `width: ${Math.round((counts.total / most) * 100)}%`,
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ];
}

// ---- the view -------------------------------------------------------------

function renderRota() {
  if (!state.rota) {
    return h(
      'div',
      { class: 'content' },
      h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading the rota…'),
    );
  }

  const tab = state.rotaTab;

  return h(
    'div',
    { class: 'content' },
    state.error && h('div', { class: 'banner' }, state.error),
    renderDutyBoard(),
    h(
      'div',
      { class: 'rota-tabs' },
      ROTA_TABS.map(([id, label]) =>
        h(
          'button',
          {
            'aria-current': String(tab === id),
            onclick: () => {
              state.rotaTab = id;
              render();
            },
          },
          label,
        ),
      ),
    ),
    tab === 'walkthrough'
      ? renderRotaWalkthrough()
      : tab === 'weekend'
        ? renderRotaWeekend()
        : tab === 'person'
          ? renderRotaPerson()
          : tab === 'team'
            ? renderRotaTeam()
            : renderRotaKpi(),
  );
}

// ------------------------------------------------------------------ render --

function titleFor() {
  if (state.view === 'dashboard') return ['Dashboard', 'Everything the team is tracking, in one place'];
  if (state.view === 'rota') {
    return ['Safety duty rota', 'Who covers which task, in which area, this week'];
  }
  if (state.view === 'import') return ['Import Excel', 'One sheet at a time, into the register you choose'];
  if (state.view === 'activity') return ['Recent changes', 'Who changed what, and when'];
  if (state.view === 'settings') return ['Settings', 'Accounts, and what each person may do'];
  const register = registerById(state.registerId);
  return [register?.name ?? 'Register', register?.description ?? ''];
}

function applyTheme() {
  if (state.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', state.theme);
}

function render() {
  const root = $('#root');

  // A full redraw would drop the caret out of whatever the user is typing in, so
  // the focused element and its selection are captured and restored around it.
  const active = document.activeElement;
  const focusId = active?.id || null;
  const selStart = active?.selectionStart ?? null;
  const selEnd = active?.selectionEnd ?? null;

  root.replaceChildren();

  if (!state.config) {
    root.append(h('div', { class: 'empty' }, h('span', { class: 'spin' }), ' Loading tracker…'));
    return;
  }

  if (state.gate) {
    root.append(renderGate());
    if (!focusId) ($('#gate-name') ?? $('#auth-accessCode') ?? $('#auth-email'))?.focus();
    else document.getElementById(focusId)?.focus();
    return;
  }

  const [title, subtitle] = titleFor();

  const body =
    state.view === 'rota'
      ? renderRota()
      : state.view === 'dashboard'
        ? renderDashboard()
        : state.view === 'register'
          ? renderRegister()
          : state.view === 'import'
            ? renderImport()
            : state.view === 'settings'
              ? renderSettings()
              : renderActivity();

  root.append(
    h(
      'div',
      { class: 'shell' },
      renderSidebar(),
      h(
        'main',
        { class: 'main' },
        h(
          'div',
          { class: 'topbar' },
          h('h1', null, title, h('span', { class: 'sub' }, subtitle)),
          state.busy && h('span', { class: 'spin' }),
          h(
            'button',
            {
              class: 'btn ghost sm',
              title: 'Switch light / dark',
              onclick: () => {
                state.theme = state.theme === 'dark' ? 'light' : 'dark';
                localStorage.setItem('tracker.theme', state.theme);
                applyTheme();
                render();
              },
            },
            state.theme === 'dark' ? '☀ Light' : '☾ Dark',
          ),
          h(
            'button',
            {
              class: 'btn',
              title: 'Engineering Department Updates — summary and what needs attention',
              onclick: () =>
                state.authState?.disabled
                  ? // No server offline to render a PDF; the browser's own
                    // "Save as PDF" prints the same content from the page.
                    window.print()
                  : download('/api/report.pdf'),
            },
            '↓ PDF report',
          ),
          h('button', { class: 'btn', onclick: () => download('/api/export') }, '↓ Export all'),
          canWrite() &&
            h('button', { class: 'btn primary', onclick: () => go('import') }, '↑ Import Excel'),
        ),
        state.error && h('div', { class: 'content' }, h('div', { class: 'banner error' }, state.error)),
        // The standalone build says where its data lives. Someone who was handed a
        // file rather than a URL has no other way to know their edits are local.
        state.config.storageNotice &&
          h(
            'div',
            { class: 'content', style: 'padding-bottom: 0' },
            h('div', { class: 'banner info' }, state.config.storageNotice),
          ),
        body,
      ),
    ),
  );

  if (state.confirmPrompt) {
    root.append(renderConfirmPrompt());
    if (!focusId) $('#confirm-password')?.focus();
  }
  if (state.drawer) root.append(renderDrawer());
  if (state.toast) root.append(h('div', { class: 'toast' }, state.toast));

  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus();
      if (selStart !== null && restored.setSelectionRange) {
        try {
          restored.setSelectionRange(selStart, selEnd);
        } catch {
          // Inputs like `type=date` reject setSelectionRange; focus alone is enough.
        }
      }
    }
  }
}

// -------------------------------------------------------------------- boot --

async function boot() {
  applyTheme();
  try {
    state.config = await api('/api/config');
    state.authState = await api('/api/auth/state');
  } catch {
    $('#root').replaceChildren(
      h('div', { class: 'empty' }, 'Cannot reach the tracker server. Is it running?'),
    );
    return;
  }

  // The offline build has no accounts — it asks for a name and treats whoever is
  // holding the file as able to do everything, because they already are.
  if (state.authState.disabled) {
    if (state.user) {
      state.me = { id: 'local', name: state.user, role: 'admin', registers: [] };
      go('dashboard');
    } else {
      state.gate = 'name';
      render();
    }
    return;
  }

  if (state.authState.needsSetup) {
    state.gate = 'setup';
    render();
    return;
  }

  if (!state.token) {
    state.gate = 'login';
    render();
    return;
  }

  try {
    const { user } = await api('/api/auth/me');
    state.me = user;
    state.user = user?.name ?? '';
    go('dashboard');
  } catch {
    // The token was rejected — `api` has already cleared it and shown the form.
    render();
  }
}

boot();
