/**
 * Daily reminder rules, and the digest each person receives.
 *
 * The team's rule, in their words: remind about anything overdue or falling due
 * inside a month, and remind *daily* once the deadline is close. That is three
 * bands, and only the first two go out every day — a job that is still three
 * weeks away does not need a message every morning to stay visible, and a
 * reminder that arrives daily regardless of urgency stops being read at all.
 * The rest of the month therefore goes out once a week.
 *
 * Two channels run on those bands with their own idea of "close": email at
 * fifteen days, WhatsApp at seven. `planRun` plans the email, `planWhatsappRun`
 * the WhatsApp messages, and both sit on the same `collectItems`.
 *
 * This module is deliberately free of Node built-ins, of storage and of the
 * transports: it takes records, accounts and a date, and returns the exact set
 * of messages to send. That is what makes the rules testable without a database
 * or an SMTP server, and what lets the Settings screen show a preview that is
 * the same computation as the send, not a second guess at it.
 */

import {
  CLOSED_STATUSES,
  DUE_SOON_DAYS,
  REGISTER_BY_ID,
  daysUntil,
  formatDisplayDate,
  normaliseKey,
  todayIso,
} from './registers.js';
import { normalisePhone } from './phone.js';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * WhatsApp keeps its own thresholds.
 *
 * The team asked for a month's warning over WhatsApp and then a message once a
 * week remains — a tighter daily band than the email's fifteen days. That is the
 * right way round: an email is read when it is opened, a WhatsApp message
 * interrupts, and a channel that interrupts every morning about something three
 * weeks away is a channel that gets muted.
 */
export const DEFAULT_WHATSAPP_CONFIG = {
  enabled: false,
  windowDays: DUE_SOON_DAYS,
  dailyWithinDays: 7,
  weeklyOn: 'Sunday',
  includeOverdue: true,
  sendWhenEmpty: false,
};

/**
 * Defaults.
 *
 * `weeklyOn` is Sunday because that is the first working day of the week on the
 * plant — the weekly look-ahead wants to land at the start of the week it
 * describes, not in the middle of it.
 *
 * Off by default: a feature that starts emailing the whole team the moment it
 * deploys is a feature that gets switched off by the team rather than
 * configured by them.
 */
export const DEFAULT_REMINDER_CONFIG = {
  enabled: false,
  windowDays: DUE_SOON_DAYS,
  dailyWithinDays: 15,
  weeklyOn: 'Sunday',
  includeOverdue: true,
  sendWhenEmpty: false,
  extraRecipients: [],
  appUrl: '',
  whatsapp: DEFAULT_WHATSAPP_CONFIG,
};

/** Ordered widest-urgency-first; the digest renders them in this order. */
export const BANDS = [
  { key: 'overdue', label: 'Overdue', daily: true },
  { key: 'urgent', label: 'Due soon', daily: true },
  { key: 'soon', label: 'Coming up', daily: false },
];

const BAND_KEYS = BANDS.map((b) => b.key);

const clampInt = (value, fallback, min, max) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The thresholds a channel sends on, clamped so no setting can misbehave. */
function normaliseBands(raw = {}, defaults = DEFAULT_REMINDER_CONFIG) {
  const windowDays = clampInt(raw.windowDays, defaults.windowDays, 1, 365);
  return {
    enabled: Boolean(raw.enabled),
    windowDays,
    // Never wider than the window itself: a daily threshold beyond the window
    // would silently promote the whole "coming up" band to a daily message.
    dailyWithinDays: Math.min(
      windowDays,
      clampInt(raw.dailyWithinDays, defaults.dailyWithinDays, 0, 365),
    ),
    weeklyOn: WEEKDAYS.includes(raw.weeklyOn) ? raw.weeklyOn : defaults.weeklyOn,
    includeOverdue: raw.includeOverdue !== false,
    sendWhenEmpty: Boolean(raw.sendWhenEmpty),
  };
}

/** Coerce whatever is stored (or posted) into a config that cannot misbehave. */
export function normaliseConfig(raw = {}) {
  return {
    ...normaliseBands(raw, DEFAULT_REMINDER_CONFIG),
    whatsapp: normaliseBands(raw.whatsapp ?? {}, DEFAULT_WHATSAPP_CONFIG),
    extraRecipients: [
      ...new Set(
        (Array.isArray(raw.extraRecipients) ? raw.extraRecipients : [])
          .map((e) => String(e ?? '').trim().toLowerCase())
          .filter((e) => EMAIL_RE.test(e)),
      ),
    ],
    appUrl: String(raw.appUrl ?? '').trim().replace(/\/+$/, ''),
  };
}

/** Weekday of a plain `YYYY-MM-DD`, read in UTC so no timezone can shift it. */
export function weekdayOf(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return WEEKDAYS[day] ?? null;
}

/**
 * Which band a record falls in, or null when it needs no reminder.
 *
 * Undated rows return null. There are eighty-odd of them in the real registers,
 * mostly `Next Shutdown` and `SEP` entries, and there is no honest way to say a
 * job is due in nine days when nobody has said when it is due. They are counted
 * separately in the digest instead, so they are visible without being urgent.
 */
export function bandOf(record, config, today = todayIso()) {
  if (CLOSED_STATUSES.has(record.status)) return null;
  if (!record.dueDate) return null;
  const days = daysUntil(record.dueDate, today);
  if (days === null) return null;
  if (days < 0) return config.includeOverdue ? 'overdue' : null;
  if (days <= config.dailyWithinDays) return 'urgent';
  if (days <= config.windowDays) return 'soon';
  return null;
}

/** Whether a band is sent on this date: the daily ones always, `soon` weekly. */
export function sendsToday(band, config, today = todayIso()) {
  const found = BANDS.find((b) => b.key === band);
  if (!found) return false;
  return found.daily || weekdayOf(today) === config.weeklyOn;
}

/** The bands going out on this date, in urgency order. */
export function bandsSendingOn(config, today = todayIso()) {
  return BAND_KEYS.filter((band) => sendsToday(band, config, today));
}

/** Every record needing a reminder today, soonest due first. */
export function collectItems(records, config, today = todayIso()) {
  const sending = new Set(bandsSendingOn(config, today));
  return records
    .map((record) => {
      const band = bandOf(record, config, today);
      return band && sending.has(band)
        ? { record, band, days: daysUntil(record.dueDate, today) }
        : null;
    })
    .filter(Boolean)
    .sort(
      (a, b) =>
        a.days - b.days ||
        String(a.record.register).localeCompare(String(b.record.register)) ||
        String(a.record.id).localeCompare(String(b.record.id)),
    );
}

/**
 * Whether an action owner from a spreadsheet is this person.
 *
 * The registers carry owner names as free text — `Abdulrahman`, `Abdulrahman
 * Sankyu`, `ABDULRAHMAN S.` — while accounts carry a name and an email. Tokens
 * are compared whole rather than by prefix, so `Ali` does not claim `Alissa`'s
 * work.
 *
 * A match needs one token of three characters or more, which rejects an initial
 * (`A.`, `AS`) without rejecting a real short name. Four was the first
 * threshold I used and it was wrong: `Ali` is a whole name here, and it stopped
 * him being credited with his own valve.
 *
 * Two different people who genuinely share a first name cannot be told apart
 * from `Action By: Ali` alone. That is a limit of the source data, not of the
 * matching — and it only affects which rows are repeated under "assigned to
 * you", never which rows a person is allowed to see.
 */
export function ownerMatches(actionBy, name) {
  const tokens = (value) =>
    String(value ?? '')
      .split(/[\s,._/&-]+/)
      .map(normaliseKey)
      .filter(Boolean);

  // Single letters are dropped before comparing, so `ABDULRAHMAN S.` still
  // matches `Abdulrahman Sankyu` — the initial is how the sheet abbreviates the
  // surname, and requiring it to match would reject the very case it stands for.
  const a = tokens(actionBy).filter((t) => t.length > 1);
  const b = tokens(name).filter((t) => t.length > 1);
  if (!a.length || !b.length) return false;

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (!short.some((t) => t.length >= 3)) return false;
  const set = new Set(long);
  return short.every((t) => set.has(t));
}

/**
 * Who gets a digest.
 *
 * Every active account, because that is what the team asked for — the people in
 * the software are the people who hear about the work. An account limited to
 * certain registers is limited in its reminders too: the same allow-list that
 * hides PDM from them in the app keeps PDM out of their inbox, or the email
 * would be a way around a permission the app enforces everywhere else.
 *
 * `extraRecipients` are addresses with no account — a shared department mailbox,
 * a contractor — and they see everything, since there is no allow-list to apply.
 */
export function recipientsFor(users, config) {
  const seen = new Set();
  const list = [];

  for (const user of users) {
    const email = String(user.email ?? '').trim().toLowerCase();
    if (!email || user.active === false || seen.has(email)) continue;
    seen.add(email);
    list.push({
      email,
      name: user.name ?? null,
      registers: Array.isArray(user.registers) ? user.registers : [],
      kind: 'account',
    });
  }

  for (const email of config.extraRecipients) {
    if (seen.has(email)) continue;
    seen.add(email);
    list.push({ email, name: null, registers: [], kind: 'extra' });
  }

  return list;
}

/** Rows past their date but with no date at all — counted, never listed. */
const undatedCount = (records) =>
  records.filter((r) => !CLOSED_STATUSES.has(r.status) && !r.dueDate).length;

/**
 * Work out every message that should go out on `today`.
 *
 * Returns the messages *and* the recipients deliberately skipped with the
 * reason, because "nobody was emailed" and "everybody was emailed and had
 * nothing due" look identical from the outside otherwise.
 */
export function planRun({ records, users, config, today = todayIso() }) {
  const cfg = normaliseConfig(config);
  const bands = bandsSendingOn(cfg, today);
  const recipients = recipientsFor(users, cfg);
  const messages = [];
  const skipped = [];

  if (!bands.length) {
    return { date: today, weekday: weekdayOf(today), bands, messages, skipped, recipients: recipients.length };
  }

  for (const recipient of recipients) {
    const visible = recipient.registers.length
      ? records.filter((r) => recipient.registers.includes(r.register))
      : records;

    const items = collectItems(visible, cfg, today);
    const counts = {
      overdue: items.filter((i) => i.band === 'overdue').length,
      urgent: items.filter((i) => i.band === 'urgent').length,
      soon: items.filter((i) => i.band === 'soon').length,
      mine: items.filter((i) => ownerMatches(i.record.actionBy, recipient.name)).length,
      undated: undatedCount(visible),
    };

    if (!items.length && !cfg.sendWhenEmpty) {
      skipped.push({ email: recipient.email, name: recipient.name, reason: 'nothing due' });
      continue;
    }

    messages.push({
      to: recipient.email,
      name: recipient.name,
      kind: recipient.kind,
      registers: recipient.registers,
      counts,
      items,
      ...renderDigest({ recipient, items, counts, config: cfg, today }),
    });
  }

  return { date: today, weekday: weekdayOf(today), bands, messages, skipped, recipients: recipients.length };
}

// ---------------------------------------------------------------------------
// The digest itself
// ---------------------------------------------------------------------------

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const INK = '#111111';
const MUTED = '#6b6a66';
const RULE = '#e2e1db';
const ACCENT = '#1c5cab';
const CRITICAL = '#c0392b';
const WARNING = '#8a5a06';

const BAND_COLOUR = { overdue: CRITICAL, urgent: WARNING, soon: ACCENT };

/**
 * How many rows of one band the email lists.
 *
 * A register with two hundred overdue items would otherwise produce a message
 * long enough that Gmail clips it, hiding the end behind a "view entire
 * message" link — which is exactly where the least urgent rows already are.
 * The count in the heading stays truthful either way.
 */
const MAX_ROWS_PER_BAND = 40;

const registerName = (id) => REGISTER_BY_ID.get(id)?.name ?? id;
const registerShort = (id) => REGISTER_BY_ID.get(id)?.short ?? id;

/** "3 days late" / "due today" / "in 9 days" — the phrase both formats use. */
export function duePhrase(days) {
  if (days === null || days === undefined) return 'no date';
  if (days < 0) return `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} late`;
  if (days === 0) return 'due today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function subjectFor(counts, today) {
  const parts = [];
  if (counts.overdue) parts.push(`${counts.overdue} overdue`);
  if (counts.urgent) parts.push(`${counts.urgent} due soon`);
  if (counts.soon) parts.push(`${counts.soon} coming up`);
  const tail = parts.length ? parts.join(', ') : 'nothing outstanding';
  return `Engineering updates ${today} — ${tail}`;
}

/**
 * Three columns, not five.
 *
 * Register, reference, description, due date and owner as five columns is
 * readable on a desktop and unreadable on a phone: at 400px every cell wrapped
 * mid-word — `Abdulr / ahman / Sanky / u` — and the due date collided with the
 * owner beside it. Most of these will be read on a phone.
 *
 * So the register sits above its reference, and the owner below the
 * description. Nothing is dropped; the same five facts are stacked into three
 * columns wide enough to hold them. Percentages rather than pixels because a
 * mail client decides its own width, and `table-layout:fixed` so all three
 * sections of one message line up with each other.
 */
// Weighted for the narrow case: at 400px, 22% left `IWS-2021-004` breaking
// across three lines, and a reference broken up is a reference you cannot
// search for in the app.
const COLUMNS = ['26%', '48%', '26%'];

function htmlTable(items) {
  const cols = COLUMNS.map((width) => `<col style="width:${width}">`).join('');
  const head = ['Job', 'Description', 'Due']
    .map(
      (label) =>
        `<th align="left" style="padding:6px 8px;border-bottom:1px solid ${RULE};font:600 11px/1.4 Arial,sans-serif;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${label}</th>`,
    )
    .join('');

  const rows = items
    .slice(0, MAX_ROWS_PER_BAND)
    .map((item) => {
      const r = item.record;
      const colour = BAND_COLOUR[item.band];
      // `overflow-wrap` rather than `word-break`: it breaks at the hyphens a tag
      // like `PZV-1180-A-CALIB` already has, and splits mid-word only when a
      // word genuinely cannot fit.
      const cell = (content, extra = '') =>
        `<td valign="top" style="padding:8px;border-bottom:1px solid ${RULE};font:400 13px/1.45 Arial,sans-serif;color:${INK};overflow-wrap:break-word;${extra}">${content}</td>`;

      return `<tr>
${cell(
  `<span style="font-size:10px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${escape(
    registerShort(r.register),
  )}</span><br><strong>${escape(r.ref ?? '—')}</strong>`,
)}
${cell(
  `${escape(r.title ?? '—')}<br><span style="font-size:11px;color:${MUTED}">Action by ${escape(
    r.actionBy ?? 'nobody yet',
  )}</span>`,
)}
${cell(
  `<span style="color:${colour};font-weight:700">${escape(
    duePhrase(item.days),
  )}</span><br><span style="color:${MUTED};font-size:11px;white-space:nowrap">${escape(formatDisplayDate(r.dueDate ?? ''))}</span>`,
)}
</tr>`;
    })
    .join('');

  const more =
    items.length > MAX_ROWS_PER_BAND
      ? `<tr><td colspan="3" style="padding:7px 8px;font:400 12px/1.4 Arial,sans-serif;color:${MUTED}">…and ${
          items.length - MAX_ROWS_PER_BAND
        } more — open the tracker for the full list.</td></tr>`
      : '';

  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;width:100%;table-layout:fixed;margin:0 0 22px">
<colgroup>${cols}</colgroup>
<thead><tr>${head}</tr></thead><tbody>${rows}${more}</tbody></table>`;
}

function countChip(label, value, colour) {
  return `<td align="center" style="padding:10px 6px;border:1px solid ${RULE};font-family:Arial,sans-serif">
<div style="font-size:22px;font-weight:700;color:${colour};line-height:1.1">${value}</div>
<div style="font-size:11px;color:${MUTED};padding-top:3px">${escape(label)}</div>
</td>`;
}

/**
 * Render one person's digest as HTML and as plain text.
 *
 * No logo image. A data URI is stripped by Gmail and a linked one needs a host
 * that is awake — either way the header would show a broken-image box on the
 * free tier, which looks worse than a typographic heading. The PDF report is
 * where the logo belongs; it is a file, not a message.
 */
export function renderDigest({ recipient, items, counts, config, today }) {
  const scoped = recipient.registers.length
    ? `Covering ${recipient.registers.map(registerName).join(', ')} — the registers your account can open.`
    : null;

  const mine = items.filter((i) => ownerMatches(i.record.actionBy, recipient.name));
  const sections = [];

  // The reader's own jobs come first, and then appear again in their band.
  // The repetition is the point: the top section is what they must act on, the
  // rest is the department's position, and a digest that showed only their own
  // rows would hide the fact that the register they share is on fire.
  if (mine.length) sections.push({ title: `Assigned to you (${mine.length})`, items: mine });
  const suffix = mine.length ? ' — all owners' : '';

  for (const band of BANDS) {
    const rows = items.filter((i) => i.band === band.key);
    if (!rows.length) continue;
    const title =
      band.key === 'overdue'
        ? `Overdue (${rows.length})${suffix}`
        : band.key === 'urgent'
          ? `Due within ${config.dailyWithinDays} days (${rows.length})${suffix}`
          : `Due in ${config.dailyWithinDays + 1}–${config.windowDays} days (${rows.length})${suffix}`;
    sections.push({ title, items: rows });
  }

  const greeting = recipient.name ? `Hello ${escape(recipient.name)},` : 'Hello,';

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f1">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f4f4f1"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" width="720" style="max-width:720px;width:100%;background:#ffffff;border:1px solid ${RULE}">
<tr><td style="height:4px;background:${ACCENT};font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:24px 26px 0">
<h1 style="margin:0;font:700 20px/1.25 Arial,sans-serif;color:${INK}">Engineering Department Updates</h1>
<p style="margin:5px 0 0;font:400 13px/1.5 Arial,sans-serif;color:${MUTED}">Solid Handling Plant &middot; DCU — status as at ${escape(formatDisplayDate(today))}</p>
</td></tr>
<tr><td style="padding:20px 26px 0;font:400 14px/1.6 Arial,sans-serif;color:${INK}">
<p style="margin:0 0 16px">${greeting}</p>
</td></tr>
<tr><td style="padding:0 26px">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin:0 0 22px"><tr>
${countChip('Overdue', counts.overdue, counts.overdue ? CRITICAL : INK)}
${countChip(`Due in ${config.dailyWithinDays}d`, counts.urgent, counts.urgent ? WARNING : INK)}
${countChip(`Due ${config.dailyWithinDays + 1}–${config.windowDays}d`, counts.soon, INK)}
${countChip('Assigned to you', counts.mine, counts.mine ? ACCENT : INK)}
</tr></table>
</td></tr>
<tr><td style="padding:0 26px">
${sections
  .map(
    (section) =>
      `<h2 style="margin:0 0 8px;font:700 14px/1.3 Arial,sans-serif;color:${INK}">${escape(section.title)}</h2>${htmlTable(section.items)}`,
  )
  .join('')}
</td></tr>
<tr><td style="padding:4px 26px 24px;border-top:1px solid ${RULE}">
<p style="margin:14px 0 0;font:400 12px/1.6 Arial,sans-serif;color:${MUTED}">
${counts.undated ? `${counts.undated} open job${counts.undated === 1 ? ' has' : 's have'} no target date and ${counts.undated === 1 ? 'is' : 'are'} not listed above.<br>` : ''}
${scoped ? `${escape(scoped)}<br>` : ''}
${config.appUrl ? `<a href="${escape(config.appUrl)}" style="color:${ACCENT}">Open the tracker</a> to update a job or change its date.<br>` : ''}
Sent automatically by the Engineering Activity Tracker.
</p>
</td></tr>
</table></td></tr></table>
</body></html>`;

  const textSections = sections
    .map((section) => {
      const rows = section.items
        .slice(0, MAX_ROWS_PER_BAND)
        .map(
          (i) =>
            `  - [${registerShort(i.record.register)}] ${i.record.ref ?? '—'} — ${
              i.record.title ?? '—'
            } (${duePhrase(i.days)}, ${formatDisplayDate(i.record.dueDate)}) — ${i.record.actionBy ?? 'Unassigned'}`,
        )
        .join('\n');
      const more =
        section.items.length > MAX_ROWS_PER_BAND
          ? `\n  …and ${section.items.length - MAX_ROWS_PER_BAND} more.`
          : '';
      return `${section.title}\n${rows}${more}`;
    })
    .join('\n\n');

  const text = [
    'ENGINEERING DEPARTMENT UPDATES',
    `Solid Handling Plant / DCU — status as at ${formatDisplayDate(today)}`,
    '',
    recipient.name ? `Hello ${recipient.name},` : 'Hello,',
    '',
    `Overdue: ${counts.overdue}   Due in ${config.dailyWithinDays}d: ${counts.urgent}   Due in ${config.windowDays}d: ${counts.soon}   Assigned to you: ${counts.mine}`,
    '',
    textSections,
    '',
    counts.undated
      ? `${counts.undated} open job${counts.undated === 1 ? ' has' : 's have'} no target date and ${
          counts.undated === 1 ? 'is' : 'are'
        } not listed above.`
      : null,
    scoped,
    config.appUrl ? `Open the tracker: ${config.appUrl}` : null,
    'Sent automatically by the Engineering Activity Tracker.',
    // Only the optional lines drop out. Filtering every empty string would take
    // the deliberate blank separators with them and run the whole digest together.
  ]
    .filter((line) => line !== null && line !== undefined)
    .join('\n');

  return { subject: subjectFor(counts, today), html, text };
}

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

/**
 * The band settings WhatsApp sends on.
 *
 * A separate set from the email's, so tightening one channel does not tighten
 * the other. `extraRecipients` and `appUrl` are carried across because they
 * belong to the deployment rather than to a channel — there is one tracker URL,
 * whichever way you are told about it.
 */
export function whatsappConfigOf(config) {
  const cfg = normaliseConfig(config);
  return { ...cfg.whatsapp, extraRecipients: [], appUrl: cfg.appUrl };
}

/**
 * Who has a WhatsApp number worth messaging.
 *
 * Same rules as the email list and for the same reasons: active accounts only,
 * and an account limited to certain registers is limited in its reminders too.
 * Nobody without a number, because a WhatsApp reminder to a person who never
 * gave one is not a reminder, it is a link to nowhere.
 *
 * There are no `extraRecipients` here. An email address typed into a settings
 * box reaches a mailbox somebody chose to publish; a phone number typed into
 * one reaches a person's private phone, and the only numbers this app should
 * hold are the ones its own team members put on their own accounts.
 */
export function whatsappRecipientsFor(users, country) {
  const seen = new Set();
  const list = [];

  for (const user of users) {
    if (user.active === false) continue;
    const phone = normalisePhone(user.phone, country);
    if (!phone || seen.has(phone)) continue;
    seen.add(phone);
    list.push({
      phone,
      email: user.email ?? null,
      name: user.name ?? null,
      registers: Array.isArray(user.registers) ? user.registers : [],
    });
  }

  return list;
}

/**
 * How many rows one WhatsApp message lists.
 *
 * Far fewer than the email's forty. The message has to survive being pasted
 * into a `wa.me` link, and more to the point it is read on a lock screen — a
 * fifty-line message is one nobody finishes. The counts at the top stay
 * truthful however many rows are shown, and the rest are a tap away in the app.
 */
export const MAX_WHATSAPP_ROWS = 12;

/**
 * One person's reminder, written for WhatsApp.
 *
 * Plain text with WhatsApp's own `*bold*`, because that is all it renders —
 * there is no HTML here, and a message built out of table borders would arrive
 * as punctuation soup.
 *
 * Their own jobs come first and are the only ones listed in full; everything
 * else is summarised by band. On a phone, the useful question is "what do I
 * have to do", not "what is the department's position", which is the report's
 * job and the email's.
 */
export function renderWhatsappDigest({ recipient, items, counts, config, today }) {
  const mine = items.filter((i) => ownerMatches(i.record.actionBy, recipient.name));
  const others = items.filter((i) => !mine.includes(i));

  const line = (item, withOwner) =>
    `• *${item.record.ref ?? '—'}* (${registerShort(item.record.register)}) — ${
      item.record.title ?? 'No description'
    }\n  ${duePhrase(item.days)}, ${formatDisplayDate(item.record.dueDate)}${
      withOwner ? ` — ${item.record.actionBy ?? 'Unassigned'}` : ''
    }`;

  const section = (title, rows, withOwner) => {
    if (!rows.length) return null;
    const shown = rows.slice(0, MAX_WHATSAPP_ROWS).map((item) => line(item, withOwner));
    const more =
      rows.length > MAX_WHATSAPP_ROWS ? `  …and ${rows.length - MAX_WHATSAPP_ROWS} more.` : null;
    return [`*${title}*`, ...shown, more].filter((l) => l !== null).join('\n');
  };

  const body = [
    section(`Assigned to you (${mine.length})`, mine, false),
    // Only the urgent half of everybody else's work. The whole month's list for
    // the whole department is a report, and it is already one tap away.
    section(
      'Others overdue or due soon',
      others.filter((i) => i.band !== 'soon'),
      true,
    ),
  ].filter(Boolean);

  const text = [
    `*Engineering Action Reminder* — ${formatDisplayDate(today)}`,
    'Solid Handling Plant / DCU',
    '',
    recipient.name ? `Hello ${recipient.name},` : 'Hello,',
    `Overdue: *${counts.overdue}*  |  Due in ${config.dailyWithinDays} days: *${counts.urgent}*  |  Due in ${config.windowDays} days: *${counts.soon}*`,
    '',
    body.length ? body.join('\n\n') : 'Nothing is overdue or falling due. Thank you.',
    '',
    counts.undated
      ? `${counts.undated} open job${counts.undated === 1 ? ' has' : 's have'} no target date.`
      : null,
    config.appUrl ? `Open the tracker: ${config.appUrl}` : null,
  ]
    // Only the optional lines drop out; filtering every empty string would take
    // the deliberate blank separators with them.
    .filter((l) => l !== null && l !== undefined)
    .join('\n');

  return { text };
}

/**
 * Work out every WhatsApp message that should go out on `today`.
 *
 * Deliberately the same shape as `planRun`, and deliberately a separate
 * function rather than a flag on it: the two channels reach different people
 * (one by mailbox, one by phone) on different thresholds, and a single planner
 * pretending otherwise would have to be untangled at every call site anyway.
 */
export function planWhatsappRun({ records, users, config, today = todayIso(), country }) {
  const cfg = whatsappConfigOf(config);
  const bands = bandsSendingOn(cfg, today);
  const recipients = whatsappRecipientsFor(users, country);
  const messages = [];
  const skipped = [];

  if (!bands.length) {
    return { date: today, weekday: weekdayOf(today), bands, messages, skipped, recipients: recipients.length };
  }

  for (const recipient of recipients) {
    const visible = recipient.registers.length
      ? records.filter((r) => recipient.registers.includes(r.register))
      : records;

    const items = collectItems(visible, cfg, today);
    const counts = {
      overdue: items.filter((i) => i.band === 'overdue').length,
      urgent: items.filter((i) => i.band === 'urgent').length,
      soon: items.filter((i) => i.band === 'soon').length,
      mine: items.filter((i) => ownerMatches(i.record.actionBy, recipient.name)).length,
      undated: undatedCount(visible),
    };

    if (!items.length && !cfg.sendWhenEmpty) {
      skipped.push({ phone: recipient.phone, name: recipient.name, reason: 'nothing due' });
      continue;
    }

    messages.push({
      to: recipient.phone,
      name: recipient.name,
      email: recipient.email,
      registers: recipient.registers,
      counts,
      items,
      // Carried on the message so the transport can fill a WhatsApp template
      // without being handed the config as well.
      dailyWithinDays: cfg.dailyWithinDays,
      ...renderWhatsappDigest({ recipient, items, counts, config: cfg, today }),
    });
  }

  return { date: today, weekday: weekdayOf(today), bands, messages, skipped, recipients: recipients.length };
}
