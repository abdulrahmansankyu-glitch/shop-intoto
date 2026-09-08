/**
 * Record shaping, filtering, sorting and dashboard maths.
 *
 * Deliberately free of Node built-ins and of any storage or HTTP concern: it runs
 * unchanged on the server, in front of Postgres or the JSON file, and inside the
 * browser in the standalone single-file build. One implementation means the
 * offline copy and the shared deployment cannot quietly disagree about what
 * "overdue" or "open" means.
 *
 * `crypto.randomUUID()` is used rather than `node:crypto` because it is a global
 * in Node 18+ and in browsers on a secure origin.
 */

import {
  CLOSED_STATUSES,
  DUE_SOON_DAYS,
  PRIORITY_VALUES,
  REGISTERS,
  REGISTER_BY_ID,
  VERDICTS,
  VERDICT_REGISTERS,
  daysUntil,
  dueState,
  normaliseVerdict,
} from './registers.js';

/** Shape a stored row (either backend) into the JSON the API serves. */
export function toApi(row) {
  return {
    id: row.id,
    register: row.register,
    data: row.data ?? {},
    ref: row.ref ?? null,
    title: row.title ?? null,
    dueDate: asDateString(row.due_date),
    dueText: row.due_text ?? null,
    issuedDate: asDateString(row.issued_date),
    closedDate: asDateString(row.closed_date),
    priority: row.priority ?? 'Medium',
    priorityRaw: row.priority_raw ?? null,
    status: row.status ?? 'Not Started',
    statusRaw: row.status_raw ?? null,
    actionBy: row.action_by ?? null,
    initiator: row.initiator ?? null,
    area: row.area ?? null,
    discipline: row.discipline ?? null,
    location: row.location ?? null,
    source: row.source ?? null,
    createdAt: asIsoString(row.created_at),
    createdBy: row.created_by ?? null,
    updatedAt: asIsoString(row.updated_at),
    updatedBy: row.updated_by ?? null,
  };
}

/** `pg` hands back `Date` for a `date` column; the other stores hold strings. */
export function asDateString(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(
      value.getUTCDate(),
    ).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

export function asIsoString(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Build the storage row for a record, from derived values plus metadata. */
export function toRow({ id, register, data, derived, source, actor, createdAt, createdBy }) {
  const now = new Date().toISOString();
  return {
    id: id ?? crypto.randomUUID(),
    register,
    data: data ?? {},
    ref: derived.ref,
    title: derived.title,
    due_date: derived.dueDate,
    due_text: derived.dueText,
    issued_date: derived.issuedDate,
    closed_date: derived.closedDate,
    priority: derived.priority,
    priority_raw: derived.priorityRaw,
    status: derived.status,
    status_raw: derived.statusRaw,
    action_by: derived.actionBy,
    initiator: derived.initiator,
    area: derived.area,
    discipline: derived.discipline,
    location: derived.location,
    source: source ?? 'manual',
    created_at: createdAt ?? now,
    created_by: createdBy ?? actor ?? null,
    updated_at: now,
    updated_by: actor ?? null,
  };
}

/** Merge submitted field values with what the register declares, dropping unknowns. */
export function sanitiseData(register, input) {
  const allowed = new Set(register.fields.map((f) => f.key));
  const data = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    // `extra:` keys are columns carried in from a sheet the app has no field for.
    if (!allowed.has(key) && !key.startsWith('extra:')) continue;
    if (value === null || value === undefined || value === '') continue;
    data[key] = typeof value === 'string' ? value.trim() : value;
  }
  return data;
}

// ---------------------------------------------------------------- querying --

const SORTABLE = new Set([
  'dueDate',
  'priority',
  'status',
  'ref',
  'title',
  'actionBy',
  'initiator',
  'area',
  'updatedAt',
  'createdAt',
]);

const PRIORITY_RANK = { Critical: 1, High: 2, Medium: 3, Low: 4, Planned: 5 };

function matches(record, q) {
  if (q.register && record.register !== q.register) return false;
  // An account limited to certain registers never sees rows from the others,
  // whether or not it asked for a specific one.
  if (q.registers?.length && !q.registers.includes(record.register)) return false;

  if (q.search) {
    const needle = q.search.toLowerCase();
    const haystack = [
      record.ref,
      record.title,
      record.actionBy,
      record.initiator,
      record.area,
      record.location,
      record.discipline,
      ...Object.values(record.data ?? {}).map((v) => (v == null ? '' : String(v))),
    ]
      .join('  ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  if (q.priority?.length && !q.priority.includes(record.priority)) return false;
  if (q.status?.length && !q.status.includes(record.status)) return false;

  if (q.actionBy?.length) {
    const value = (record.actionBy ?? '').toLowerCase();
    if (!q.actionBy.some((a) => a.toLowerCase() === value)) return false;
  }

  if (q.initiator?.length) {
    const value = (record.initiator ?? '').toLowerCase();
    if (!q.initiator.some((a) => a.toLowerCase() === value)) return false;
  }

  if (q.area?.length) {
    const value = (record.area ?? '').toLowerCase();
    if (!q.area.some((a) => a.toLowerCase() === value)) return false;
  }

  // `open` is the default working view: anything nobody has closed out.
  if (q.open && CLOSED_STATUSES.has(record.status)) return false;

  if ((q.from || q.to) && !withinDates(record, q)) return false;

  if (q.due) {
    const closed = CLOSED_STATUSES.has(record.status);
    const days = record.dueDate ? daysUntil(record.dueDate) : null;
    if (q.due === 'overdue' && !(!closed && days !== null && days < 0)) return false;
    if (q.due === 'due-soon' && !(!closed && days !== null && days >= 0 && days <= DUE_SOON_DAYS)) {
      return false;
    }
    if (q.due === 'undated' && record.dueDate) return false;
    if (q.due === 'dated' && !record.dueDate) return false;
  }

  return true;
}

/**
 * Which date a range filter is asking about.
 *
 * Three answers rather than one, because the registers genuinely disagree about
 * what a record's date is. An IWS scope has a target date and that is what
 * "September" means for it. A quality audit has no target date at all — it
 * records something that already happened — so for that register the only date
 * is the one it was raised on. Forcing either register into the other's answer
 * makes the filter silently empty.
 *
 *  * `due`    — the target date alone. Undated rows drop out.
 *  * `issued` — the date it was raised or the audit was done.
 *  * `any`    — either one inside the range. The default, since it is the only
 *               answer that cannot empty a table by accident.
 */
export const DATE_FIELDS = ['due', 'issued', 'any'];

/** Whether a record falls inside `from`..`to` on the chosen date. */
export function withinDates(record, { from, to, dateField }) {
  const inRange = (value) => {
    if (!value) return false;
    // Both ends inclusive: a range typed as 1–30 September is read by everybody
    // as including the thirtieth.
    if (from && value < from) return false;
    if (to && value > to) return false;
    return true;
  };

  if (dateField === 'issued') return inRange(record.issuedDate);
  if (dateField === 'due') return inRange(record.dueDate);
  return inRange(record.dueDate) || inRange(record.issuedDate);
}

/**
 * Order two records, with a deterministic tiebreak.
 *
 * No backend returns rows in a guaranteed order, and Postgres in particular
 * relocates a tuple when it is updated. Without a final tiebreak, saving one row
 * silently reshuffles every other row that shares its due date — the row you just
 * edited appears to jump somewhere else in the table.
 */
function compare(a, b, sort, direction) {
  const primary = comparePrimary(a, b, sort, direction);
  return primary !== 0 ? primary : a.id.localeCompare(b.id);
}

function comparePrimary(a, b, sort, direction) {
  const sign = direction === 'desc' ? -1 : 1;

  if (sort === 'priority') {
    return sign * ((PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
  }

  if (sort === 'dueDate') {
    // Undated rows sort last in both directions. They are not "far future" work —
    // they are work with no date, and burying them under a descending sort would
    // hide them exactly when someone is looking for what to schedule next.
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return sign * a.dueDate.localeCompare(b.dueDate);
  }

  const av = a[sort];
  const bv = b[sort];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  return sign * String(av).localeCompare(String(bv), undefined, { numeric: true });
}

export function applyQuery(records, query = {}) {
  const q = {
    register: query.register || null,
    registers: asArray(query.registers),
    search: query.search ? String(query.search).trim().toLowerCase() : '',
    priority: asArray(query.priority),
    status: asArray(query.status),
    actionBy: asArray(query.actionBy),
    initiator: asArray(query.initiator),
    area: asArray(query.area),
    due: query.due || null,
    open: query.open === true || query.open === 'true',
    from: asDate(query.from),
    to: asDate(query.to),
    // `any` when nobody said. Defaulting to the due date silently empties a
    // register that has no due column — Quality Audit has none at all — and an
    // empty table is the one answer a filter must never give by accident.
    dateField: DATE_FIELDS.includes(query.dateField) ? query.dateField : 'any',
  };

  const filtered = records.filter((r) => matches(r, q));

  const sort = SORTABLE.has(query.sort) ? query.sort : 'dueDate';
  const direction = query.direction === 'desc' ? 'desc' : 'asc';
  filtered.sort((a, b) => compare(a, b, sort, direction));

  const total = filtered.length;
  const pageSize = clampInt(query.pageSize, 1, 500, 50);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = clampInt(query.page, 1, pageCount, 1);
  const start = (page - 1) * pageSize;

  return { rows: filtered.slice(start, start + pageSize), total, page, pageSize, pageCount };
}

/**
 * A `YYYY-MM-DD` from the query string, or null.
 *
 * Strict on purpose. Dates are compared as strings — which is exactly right for
 * this format and only this format — so a half-typed `2026-09` sliding through
 * would compare as less than every real date in September and silently empty
 * the table while the box looks filled in.
 */
function asDate(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function asArray(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = (Array.isArray(value) ? value : String(value).split(','))
    .map((v) => String(v).trim())
    .filter(Boolean);
  return list.length ? list : null;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --------------------------------------------------------------- dashboard --

/**
 * The audit figures: how many were done, and how they came out.
 *
 * A separate count from open/closed/overdue and not a substitute for it. An
 * audit is not work waiting to be done, so counting audits in the overdue
 * figures answers nothing; what the team reports at the end of a month is how
 * many audits were carried out and how many of them found a problem.
 *
 * `unclassified` is shown rather than folded into either side. A row where
 * nobody filled the verdict in has not been judged, and quietly counting it as
 * compliant would flatter the very number the register exists to report.
 *
 * Written to work for any register that declares a `verdict` role, so a second
 * kind of audit is a change to `registers.js` and nothing here.
 */
export function verdictSummary(records) {
  const ids = new Set(VERDICT_REGISTERS.map((r) => r.id));
  const rows = records.filter((r) => ids.has(r.register));

  const verdictOf = (row) =>
    normaliseVerdict(row.data?.[REGISTER_BY_ID.get(row.register)?.roles?.verdict]);

  const counts = Object.fromEntries(VERDICTS.map((v) => [v, 0]));
  let unclassified = 0;
  for (const row of rows) {
    const verdict = verdictOf(row);
    if (verdict) counts[verdict] += 1;
    else unclassified += 1;
  }

  const compliance = counts.Compliance;
  const nonCompliance = counts['Non compliance'];
  const judged = compliance + nonCompliance;

  return {
    registers: VERDICT_REGISTERS.map((r) => r.id),
    total: rows.length,
    compliance,
    nonCompliance,
    unclassified,
    // Out of the audits that reached a verdict, not out of all of them — a rate
    // whose denominator includes rows nobody judged is not a compliance rate.
    rate: judged ? Math.round((compliance / judged) * 1000) / 10 : null,
    // Findings still open, which is the queue somebody has to work through.
    openFindings: rows.filter(
      (r) => verdictOf(r) === 'Non compliance' && !CLOSED_STATUSES.has(r.status),
    ).length,
  };
}

/** Everything the dashboard shows, computed in one pass over the records. */
export function summarise(records) {
  const open = records.filter((r) => !CLOSED_STATUSES.has(r.status));
  const state = (r) => dueState(r.dueDate, r.status);

  const overdue = open.filter((r) => state(r) === 'overdue');
  const dueSoon = open.filter((r) => state(r) === 'due-soon');

  const tally = (rows, key) => {
    const counts = new Map();
    for (const row of rows) {
      const name = row[key] || 'Unassigned';
      const entry = counts.get(name) ?? { name, open: 0, overdue: 0, dueSoon: 0 };
      entry.open += 1;
      if (state(row) === 'overdue') entry.overdue += 1;
      if (state(row) === 'due-soon') entry.dueSoon += 1;
      counts.set(name, entry);
    }
    return [...counts.values()].sort(
      (a, b) => b.overdue - a.overdue || b.dueSoon - a.dueSoon || b.open - a.open,
    );
  };

  const buckets = [
    { key: 'overdue', label: 'Overdue', count: overdue.length },
    { key: '0-7', label: 'Within 7 days', count: 0 },
    { key: '8-14', label: '8–14 days', count: 0 },
    { key: '15-30', label: '15–30 days', count: 0 },
    { key: '31+', label: 'Beyond 30 days', count: 0 },
    { key: 'undated', label: 'No date set', count: open.filter((r) => !r.dueDate).length },
  ];

  for (const row of open) {
    if (!row.dueDate) continue;
    const days = daysUntil(row.dueDate);
    if (days === null || days < 0) continue;
    if (days <= 7) buckets[1].count += 1;
    else if (days <= 14) buckets[2].count += 1;
    else if (days <= DUE_SOON_DAYS) buckets[3].count += 1;
    else buckets[4].count += 1;
  }

  return {
    totals: {
      all: records.length,
      open: open.length,
      // Closed is everything no longer on somebody's plate; completed is the subset
      // that was actually finished, as opposed to cancelled or archived.
      closed: records.length - open.length,
      completed: records.filter((r) => r.status === 'Completed').length,
      overdue: overdue.length,
      dueSoon: dueSoon.length,
      undated: open.filter((r) => !r.dueDate).length,
    },
    byRegister: REGISTERS.map((register) => {
      const rows = records.filter((r) => r.register === register.id);
      const openRows = rows.filter((r) => !CLOSED_STATUSES.has(r.status));
      return {
        id: register.id,
        name: register.name,
        short: register.short,
        total: rows.length,
        open: openRows.length,
        closed: rows.length - openRows.length,
        completed: rows.filter((r) => r.status === 'Completed').length,
        overdue: openRows.filter((r) => state(r) === 'overdue').length,
        dueSoon: openRows.filter((r) => state(r) === 'due-soon').length,
        // Open, not late, and not due inside the window — the work that is simply
        // scheduled. Named so the four segments of the ring add up to the total.
        later: openRows.filter((r) => !['overdue', 'due-soon'].includes(state(r))).length,
      };
    }),
    byPriority: PRIORITY_VALUES.map((priority) => {
      const rows = open.filter((r) => r.priority === priority);
      return {
        priority,
        open: rows.length,
        overdue: rows.filter((r) => state(r) === 'overdue').length,
        dueSoon: rows.filter((r) => state(r) === 'due-soon').length,
      };
    }),
    quality: verdictSummary(records),
    byActionBy: tally(open, 'actionBy').slice(0, 12),
    byInitiator: tally(open, 'initiator').slice(0, 12),
    dueBuckets: buckets,
    attention: [...overdue, ...dueSoon]
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .slice(0, 40)
      .map((r) => ({
        id: r.id,
        register: r.register,
        ref: r.ref,
        title: r.title,
        dueDate: r.dueDate,
        days: daysUntil(r.dueDate),
        priority: r.priority,
        status: r.status,
        actionBy: r.actionBy,
        initiator: r.initiator,
      })),
  };
}
