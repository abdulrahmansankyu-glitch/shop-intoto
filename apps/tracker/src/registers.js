/**
 * The nine registers the engineering team tracks, and how each one maps onto a
 * single shared shape.
 *
 * Every register keeps its own columns — an IWS row genuinely is not a PDM row, and
 * flattening them into one generic "task" would lose the Notification/WO numbers,
 * the calibration dates and the vibration-analysis findings that make each sheet
 * useful. So each register declares its own `fields`, stored verbatim.
 *
 * What makes a dashboard possible is `roles`: a per-register statement of which of
 * its own columns answers each cross-cutting question — what is this called, who
 * owns it, when is it due, how urgent is it. Derivation reads only `roles`, so
 * adding a tenth register is a data change here and nothing else anywhere.
 */

/** Normalised priority ladder. Lower `rank` is more urgent. */
export const PRIORITIES = [
  { value: 'Critical', rank: 1 },
  { value: 'High', rank: 2 },
  { value: 'Medium', rank: 3 },
  { value: 'Low', rank: 4 },
  { value: 'Planned', rank: 5 },
];

export const PRIORITY_VALUES = PRIORITIES.map((p) => p.value);

export const STATUSES = [
  'Not Started',
  'In Progress',
  'On Hold',
  'Completed',
  'Cancelled',
  'Archived',
];

/** Statuses that mean "no longer on anybody's plate". */
export const CLOSED_STATUSES = new Set(['Completed', 'Cancelled', 'Archived']);

/**
 * Free text from the sheets → the normalised ladder.
 *
 * The sheets use three different vocabularies: IWS uses P1–P5, CTS uses
 * High/Medium/Low, and PDM uses condition-monitoring severities (Alarm, Suspect,
 * Orange). All three are graded urgency, so all three map onto one ladder rather
 * than becoming three incomparable columns nobody can chart together.
 */
const PRIORITY_ALIASES = new Map(
  Object.entries({
    p1: 'Critical',
    p2: 'High',
    p3: 'Medium',
    p4: 'Low',
    p5: 'Planned',
    critical: 'Critical',
    urgent: 'Critical',
    emergency: 'Critical',
    danger: 'Critical',
    red: 'Critical',
    alarm: 'High',
    high: 'High',
    // QC's "Finding Classification": `Execution` means the audit found work
    // that has to be done, `N/A` means it did not. It is the only urgency
    // signal that sheet carries. `N/A` is deliberately not mapped — it falls to
    // the default rather than claiming a clean audit is low *priority*, which
    // would be a judgement the sheet never made.
    execution: 'High',
    // The Quality Audit verdict is that register's only urgency signal: a
    // non-compliance is something somebody has to answer for, a compliance is
    // not. `Low` rather than nothing for the clean ones, because the default is
    // Medium — and a shelf of compliant audits marked Medium would colour every
    // one of them in an export and crowd out the findings that matter.
    noncompliance: 'High',
    noncompliant: 'High',
    compliance: 'Low',
    compliant: 'Low',
    orange: 'Medium',
    suspect: 'Medium',
    medium: 'Medium',
    med: 'Medium',
    moderate: 'Medium',
    normal: 'Low',
    low: 'Low',
    green: 'Low',
    minor: 'Low',
    planned: 'Planned',
    routine: 'Planned',
  }),
);

/** Free text from the sheets → the normalised status list. */
const STATUS_ALIASES = new Map(
  Object.entries({
    completed: 'Completed',
    complete: 'Completed',
    done: 'Completed',
    closed: 'Completed',
    close: 'Completed',
    finished: 'Completed',
    ongoing: 'In Progress',
    inprogress: 'In Progress',
    progress: 'In Progress',
    started: 'In Progress',
    open: 'In Progress',
    wip: 'In Progress',
    notstarted: 'Not Started',
    new: 'Not Started',
    pending: 'Not Started',
    onhold: 'On Hold',
    hold: 'On Hold',
    waiting: 'On Hold',
    deferred: 'On Hold',
    cancelled: 'Cancelled',
    canceled: 'Cancelled',
    dropped: 'Cancelled',
    archived: 'Archived',
    archive: 'Archived',
    // "Overdue" describes the due date, not the work. Treat it as still in progress
    // and let the computed due-date state say it is late — otherwise a row goes on
    // reading "Overdue" forever after somebody finally does the job.
    overdue: 'In Progress',
    delayed: 'In Progress',
    late: 'In Progress',
  }),
);

/** Strip case, spaces and punctuation so "Action By " matches "action_by". */
export function normaliseKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export function normalisePriority(value) {
  const key = normaliseKey(value);
  if (!key) return null;
  return PRIORITY_ALIASES.get(key) ?? null;
}

/**
 * Phrases that decide a status when the whole cell is not a known word.
 *
 * The QC sheet does not hold a status vocabulary — it holds sentences. Sixteen
 * distinct ones across 850 rows: `Found normal`, `To be attend`, `TO be
 * attend`, `REQUESTED FOR THE MATERIALS`, `NOTIFICATION ALREADY DONE`, and
 * `job completed` in six different capitalisations. None of them matches an
 * alias exactly, so every one of those rows would default to Not Started and
 * the register would read as 850 jobs nobody had begun.
 *
 * Outstanding phrases are tested first, because a sentence can hold both: `TO
 * BE DONE` contains "done", and reading that as finished would be the more
 * expensive mistake of the two.
 */
const STATUS_PHRASES = [
  // A quality audit's verdict, where the register has no status column of its
  // own. A non-compliance is open work until somebody closes it out; a
  // compliance is finished the moment it is written down — there is nothing to
  // do about a job that was done correctly, and leaving those "Not Started"
  // would fill the register with hundreds of jobs nobody can ever close.
  //
  // Ordered before everything else because "noncompliance" contains
  // "compliance", and reading a finding as a clean audit is the expensive
  // mistake of the two.
  // (Tested against the normalised key, which has already lost its spaces and
  // hyphens — so one spelling covers "Non compliance" and "non-compliant".)
  [/^noncompl/, 'In Progress'],
  [/^compl(iance|iant)/, 'Completed'],
  // Still outstanding.
  [/\bnot(completed|done|attended|closed)/, 'In Progress'],
  [/tobe(attend|made|done|completed|carried|actioned)?/, 'In Progress'],
  [/(requested|awaiting|underprocess|inhand|willbe|yettobe|pendingfor)/, 'In Progress'],
  // Finished.
  [/(completed|complete|done|installed|replaced|rectified|attended|closed|finished)/, 'Completed'],
  // The audit looked and found nothing — there is no work, so there is nothing
  // left open. This is 743 of the 850 rows.
  [/(foundnormal|noissue|noabnormal|normalcondition|satisfactory)/, 'Completed'],
];

export function normaliseStatus(value) {
  const key = normaliseKey(value);
  if (!key) return null;

  // An exact match always wins, so the seven registers that do use a proper
  // status vocabulary never reach the phrase matching below.
  const exact = STATUS_ALIASES.get(key);
  if (exact) return exact;

  for (const [pattern, status] of STATUS_PHRASES) {
    if (pattern.test(key)) return status;
  }
  return null;
}

/**
 * The verdict a quality audit reaches.
 *
 * Its own small vocabulary rather than a status or a priority, because it is
 * neither: an audit is not "in progress", and a compliance is not "low
 * priority". It is a finding about work that has already been done, and the
 * thing the team counts at the end of a month is how many of each there were.
 */
export const VERDICTS = ['Compliance', 'Non compliance'];

const VERDICT_ALIASES = new Map(
  Object.entries({
    compliance: 'Compliance',
    compliant: 'Compliance',
    complied: 'Compliance',
    conform: 'Compliance',
    conforming: 'Compliance',
    ok: 'Compliance',
    pass: 'Compliance',
    passed: 'Compliance',
    satisfactory: 'Compliance',
    noncompliance: 'Non compliance',
    noncompliant: 'Non compliance',
    notcompliance: 'Non compliance',
    notcompliant: 'Non compliance',
    nonconformance: 'Non compliance',
    nonconformity: 'Non compliance',
    nc: 'Non compliance',
    fail: 'Non compliance',
    failed: 'Non compliance',
    observation: 'Non compliance',
  }),
);

/**
 * Free text from the sheet → one of the two verdicts, or null.
 *
 * Null is a real answer: a row where nobody filled the column in has not been
 * judged either way, and counting it as compliant would flatter the figure the
 * whole register exists to report.
 */
export function normaliseVerdict(value) {
  const key = normaliseKey(value);
  if (!key) return null;
  return VERDICT_ALIASES.get(key) ?? null;
}

const text = (key, label, aliases = []) => ({ key, label, type: 'text', aliases });
const longtext = (key, label, aliases = []) => ({ key, label, type: 'longtext', aliases });
const date = (key, label, aliases = []) => ({ key, label, type: 'date', aliases });
/**
 * A clock time with no date attached — "09:00".
 *
 * Excel has no time-only type: a cell showing 09:00 holds a fraction of a day,
 * which ExcelJS hands over as a `Date` on 30 December 1899. Read as an ordinary
 * date it becomes "1899-12-30", which is how the audit times first imported.
 * Typed as `time`, only the clock is kept.
 */
const time = (key, label, aliases = []) => ({ key, label, type: 'time', aliases });
const number = (key, label, aliases = []) => ({ key, label, type: 'number', aliases });

/**
 * A number Excel stores as a fraction and shows as a percentage.
 *
 * The QC sheet's "Quality Overall %" column is formatted `0%`, so a cell reading
 * 90% holds 0.9. Storing that verbatim would print `0.9` in a column headed with
 * a percent sign, which reads as nine-tenths of one percent. Anything at or
 * below 1 is therefore scaled; anything above is already a percentage and is
 * left alone, so a sheet that stores plain 90 works too.
 */
const percent = (key, label, aliases = []) => ({ key, label, type: 'percent', aliases });
/**
 * The two plants this team covers. Area is a choice rather than free text so the
 * dashboard can group by it — typing "SHP " once and "SHP" the next time would
 * otherwise split one plant into two.
 */
export const AREA_OPTIONS = ['SHP', 'DCU'];

const select = (key, label, options, aliases = []) => ({
  key,
  label,
  type: 'select',
  options,
  aliases,
});

export const REGISTERS = [
  {
    id: 'action-notice',
    name: 'Action Notice',
    /**
     * Document numbers the app issues: `PA-2607-09`.
     *
     * `PA` fixed, then the year and month, then a serial restarting at 01 each
     * month. Only entries created by hand in the app are numbered — an imported
     * sheet keeps whatever numbers it already carries.
     */
    autoNumber: { field: 'documentNo', prefix: 'PA' },
    short: 'AN',
    description: 'Engineering action notices raised on plant equipment.',
    // Both uploaded workbooks title this sheet "Sheet1", so name-matching alone
    // cannot identify it. Header matching (below) is what actually resolves it.
    sheetAliases: ['action notice', 'action notice tracking', 'an', 'sheet1'],
    // The columns this register shows in its table — the same ones, in the same
    // order, as the team's own sheet. A shared generic layout (Ref / Description /
    // Priority) reads as a stranger's spreadsheet: it hides the Unit and Discipline
    // an engineer scans for, and shows a "Ref" column that half the registers leave
    // empty. Anything not listed here is still stored and still editable.
    tableColumns: ['documentNo', 'issuedDate', 'description', 'location', 'initiator', 'etc', 'actionBy', 'status'],
    fields: [
      text('documentNo', 'Document No.', ['document no', 'doc no', 'documentnumber']),
      date('issuedDate', 'Date', ['date', 'date issued', 'raised on']),
      longtext('description', 'Description', ['description', 'work description']),
      text('location', 'Location / Tag', ['location  tag', 'location', 'tag', 'equipment tag']),
      text('initiator', 'Initiator', ['initiator', 'raised by', 'initiated by']),
      // A date picker, not a text box — this is the commitment date the whole
      // dashboard counts from. Two of the eight ETCs in the real sheet are
      // phrases ("Next Shutdown"), so the form keeps a way to type one; see the
      // date field in the drawer.
      date('etc', 'ETC', ['etc', 'estimated completion', 'target']),
      text('actionBy', 'Action By', ['action by', 'actionby', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'notes']),
    ],
    roles: {
      ref: 'documentNo',
      title: 'description',
      // ETC is this sheet's commitment date — and it is sometimes a date and
      // sometimes a phrase ("Next Shutdown"). `deriveRecord` keeps whichever it is.
      due: 'etc',
      issued: 'issuedDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      initiator: 'initiator',
      location: 'location',
    },
  },

  {
    id: 'iws',
    name: 'IWS',
    short: 'IWS',
    description: 'Inspection work scopes raised against plant units.',
    sheetAliases: ['iws', 'iws track', 'iws tracking'],
    tableColumns: ['iwsNumber', 'area', 'unit', 'discipline', 'description', 'issuedDate', 'targetDate', 'progress', 'status'],
    fields: [
      text('iwsNumber', 'IWS Number', ['iws number', 'iws no', 'iwsnumber']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      select('area', 'Area', AREA_OPTIONS, ['area']),
      text('unit', 'Unit', ['unit']),
      text('discipline', 'Discipline', ['discipline', 'trade']),
      longtext('description', 'Description', ['description', 'scope']),
      date('issuedDate', 'Date Issued', ['date issued', 'issued date', 'date']),
      date('targetDate', 'Target Date', [
        'target date',
        // "Targate Date" is how the team's own IWS sheets and change notes spell
        // it; a sheet using that spelling silently imported with no due dates.
        'targate date',
        'traget date',
        'targert date',
        'due date',
        'target',
      ]),
      text('counter', 'Counter', ['counter']),
      text('notificationNo', 'Notification No.', ['notification no', 'notification']),
      text('woNo', 'WO. No.', ['wo no', 'work order', 'wo number', 'wo']),
      text('prPoNo', 'PR & PO No', ['pr  po no', 'pr po no', 'pr po', 'prpo']),
      number('itemsCount', 'Items Count', ['items count', 'total items']),
      number('itemsCompleted', 'Items Comp.', ['items comp', 'items completed']),
      number('progress', 'Progress', ['progress', 'percent complete', 'completion']),
      text('inspectionType', 'Type Of Inspection', ['type of inspection', 'inspection type']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      longtext('updates', 'Updates', ['updates', 'update']),
      select('status', 'Status', STATUSES, ['status']),
      date('closeDate', 'Close Date', ['close date', 'closed on', 'completion date']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'notes']),
    ],
    roles: {
      ref: 'iwsNumber',
      title: 'description',
      due: 'targetDate',
      issued: 'issuedDate',
      closed: 'closeDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      discipline: 'discipline',
      progress: 'progress',
    },
  },

  {
    id: 'pzv',
    name: 'PZV',
    short: 'PZV',
    description: 'Pressure safety valve calibration and overhaul schedule.',
    sheetAliases: ['pzv', 'pzv tracking', 'pzv tracking sheet', 'psv'],
    tableColumns: ['plantSection', 'sortField', 'description', 'lastCalibration', 'dueDate'],
    fields: [
      select('area', 'Area', AREA_OPTIONS, ['area']),
      text('plantSection', 'Unit', ['unit', 'plant section', 'section']),
      longtext('description', 'Description', ['description']),
      text('sortField', 'Tag Number', ['tag number', 'sort field', 'tag', 'valve tag']),
      longtext('maintenanceItem', 'Maintenance Item Text', [
        'maintenance item text',
        'maintenance item',
      ]),
      date('lastCalibration', 'Last Inspection', [
        'last inspection',
        'last calibration date',
        'last calibration',
      ]),
      date('dueDate', 'Due Date', ['due date', 'next calibration', 'next due']),
      date('plannedDate', 'Plan date for callibration', [
        'plan date for callibration',
        'plan date for calibration',
        'planned date',
      ]),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'sortField',
      title: 'description',
      due: 'dueDate',
      issued: 'lastCalibration',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      location: 'sortField',
    },
  },

  {
    id: 'eis',
    name: 'EIS',
    short: 'EIS',
    description: 'Equipment inspection strategy — vessels and tanks.',
    sheetAliases: ['eis', 'eis tracking', 'eis tracking sheet'],
    tableColumns: ['area', 'equipmentNumber', 'description', 'lastInspection', 'nextInspection'],
    fields: [
      select('area', 'Area', AREA_OPTIONS, ['area']),
      text('equipmentNumber', 'Equipment Number', ['equipment number', 'equipment no', 'tag']),
      longtext('description', 'Description', ['description']),
      text('equipmentType', 'Equipment Type', ['equipment type', 'type']),
      text('strategy', 'Inspection Asset Strategy', [
        'inspection asset strategy',
        'asset strategy',
        'strategy',
      ]),
      date('lastInspection', 'Last Inspection', ['last inspection', 'last inspection date']),
      date('nextInspection', 'Next Inspection', ['next inspection', 'next inspection date']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipmentNumber',
      title: 'description',
      due: 'nextInspection',
      issued: 'lastInspection',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      location: 'equipmentNumber',
    },
  },

  {
    id: 'routine-inspection',
    name: 'Routine Inspection',
    short: 'RI',
    description: 'Recurring inspection routines by interval and discipline.',
    sheetAliases: ['routine inspection', 'inspection routine', 'routine'],
    tableColumns: ['discipline', 'interval', 'activity', 'area', 'equipments', 'duration', 'actionBy', 'inspectionDate', 'nextInspection'],
    fields: [
      select('area', 'Area', AREA_OPTIONS, ['area']),
      text('discipline', 'Discipline', ['discipline', 'trade']),
      text('interval', 'Interval', ['interval', 'frequency']),
      longtext('activity', 'Inspection Activity', ['inspection activity', 'activity']),
      text('equipments', 'Equipments', ['equipments', 'equipment']),
      text('duration', 'Duration of Inspection', ['duration of inspection', 'duration']),
      text('actionBy', 'Action by', ['action by', 'responsible', 'owner']),
      date('inspectionDate', 'Inspection Date', ['inspection date', 'last inspection']),
      // In the source sheet this column holds month names ("SEP", "JAN") as often as
      // real dates, so it is typed as text and parsed opportunistically.
      text('nextInspection', 'Next Inspec Date', [
        'next inspec date',
        'next inspection date',
        'next inspection',
      ]),
      select('status', 'Status', STATUSES, ['status']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipments',
      title: 'activity',
      due: 'nextInspection',
      issued: 'inspectionDate',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      area: 'area',
      discipline: 'discipline',
    },
  },

  {
    id: 'cts-recommendation',
    name: 'CTS Recommendation',
    short: 'CTS',
    description: 'Recommendations arising from CTS investigation reports.',
    sheetAliases: ['cts recommendation', 'cts recommendations', 'cts'],
    tableColumns: ['recommendation', 'actionBy', 'priority', 'status', 'etc', 'category', 'equipment'],
    fields: [
      longtext('recommendation', 'Recommendation', ['recommendation']),
      longtext('basis', 'Basis', ['basis', 'rationale']),
      text('actionBy', 'Action by', ['action by', 'responsible', 'owner']),
      longtext('notes', 'Notes', ['notes', 'note']),
      select('priority', 'Priority', PRIORITY_VALUES, ['priority']),
      select('status', 'Status', STATUSES, ['status']),
      longtext('remarks', 'Remarks', ['remarks']),
      date('etc', 'ETC', ['etc', 'estimated completion', 'target date']),
      text('category', 'Category', ['category']),
      text('reference', 'Refrence', ['refrence', 'reference', 'ref']),
      text('owner', 'Recom Owner', ['recom owner', 'recommendation owner', 'initiator']),
      text('equipment', 'Equipment', ['equipment', 'tag']),
      text('source', 'Source', ['source']),
    ],
    roles: {
      ref: 'reference',
      title: 'recommendation',
      due: 'etc',
      priority: 'priority',
      status: 'status',
      actionBy: 'actionBy',
      initiator: 'owner',
      location: 'equipment',
    },
  },

  {
    id: 'pdm',
    name: 'PDM',
    short: 'PDM',
    description: 'Predictive maintenance findings — vibration and oil analysis.',
    sheetAliases: ['pdm', 'predictive maintenance', 'pdm tracking'],
    tableColumns: ['equipmentTag', 'reportDate', 'severity', 'recommendation', 'progress', 'maintenanceAction', 'status'],
    fields: [
      text('technique', 'Technique', ['technique', 'method']),
      text('equipmentTag', 'Equipment Tag', ['equipment tag', 'tag', 'equipment']),
      date('reportDate', 'Report Date', ['report date', 'date']),
      // Severity is this register's urgency vocabulary; it feeds the priority ladder.
      text('severity', 'Severity', ['severity']),
      longtext('finding', 'Finding / Analysis', ['finding  analysis', 'finding', 'analysis']),
      longtext('recommendation', 'Recommendation', ['recommendation']),
      text('progress', 'Progress', ['progress']),
      longtext('maintenanceAction', 'Maintenance Action', ['maintenance action', 'action']),
      select('status', 'Case Status', STATUSES, ['case status', 'stats', 'status']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner']),
      date('targetDate', 'Target Date', ['target date', 'due date', 'etc']),
      longtext('remarks', 'Remarks', ['remarks', 'notes']),
    ],
    roles: {
      ref: 'equipmentTag',
      title: 'finding',
      due: 'targetDate',
      issued: 'reportDate',
      // No Priority column in the sheet — severity carries the urgency instead.
      priority: 'severity',
      status: 'status',
      actionBy: 'actionBy',
      location: 'equipmentTag',
    },
  },

  /**
   * QC — quality audits of completed maintenance work orders.
   *
   * This register is shaped differently from the other seven, and the difference
   * matters. The rest track work that is *going to* happen and therefore have a
   * target date; a QC row records an audit that has *already* happened, and the
   * uploaded sheet has no due-date column at all. `targetDate` and `actionBy`
   * below are declared anyway and are simply empty until the team adds those
   * columns — the day they do, QC rows join the overdue counts and the reminder
   * emails with no change here.
   *
   * The urgency signal the sheet does carry is `Finding Classification`:
   * `Execution` means the audit found something needing work, `N/A` means it did
   * not. That is what fills the priority role.
   */
  {
    id: 'qc',
    name: 'QC Report',
    short: 'QC',
    description: 'Quality audits of completed maintenance work orders.',
    sheetAliases: ['qc', 'qc report', 'quality', 'quality report', 'quality audit', 'qa'],
    tableColumns: [
      'workOrderNo',
      'date',
      'equipmentTag',
      'workCenter',
      'qualityPercent',
      'findingClassification',
      'auditFindings',
      'actionStatus',
    ],
    fields: [
      number('week', 'Week', ['week', 'week no', 'wk']),
      date('date', 'Date', ['date', 'audit date', 'qc date', 'inspection date']),
      // Text, not a number: a twelve-digit work order is an identifier, and
      // nothing good comes of letting it be arithmetic.
      text('workOrderNo', 'Work Order No.', [
        'work order no',
        'work order',
        'wo no',
        'wo number',
        'wo',
        'order no',
      ]),
      select('maintType', 'PM/CM', ['PM', 'CM'], ['pm cm', 'pmcm', 'maint type', 'maintenance type']),
      text('equipmentTag', 'Equipment Tag no.', [
        'equipment tag no',
        'equipment tag',
        'equipment',
        'tag no',
        'tag',
      ]),
      text('workCenter', 'Maint. Work Center', [
        'maint work center',
        'maintenance work center',
        'work center',
        'workcenter',
        'work centre',
      ]),
      percent('qualityPercent', 'Quality %', [
        'quality overall',
        'quality overall %',
        'quality %',
        'quality',
        'overall quality',
      ]),
      longtext('auditFindings', 'Audit Findings', [
        'audit findings',
        'audit finding',
        'findings',
        'finding',
        'observation',
      ]),
      select(
        'findingClassification',
        'Finding Classification',
        ['Execution', 'N/A'],
        ['finding classification', 'classification', 'finding class'],
      ),
      text('notification', 'Y8/SCR', ['y8 scr', 'y8/scr', 'y8', 'scr', 'notification no', 'notification']),
      // Free text in the sheet — "Found normal", "To be attend", six spellings
      // of "job completed". Kept verbatim; the derived status is what the
      // dashboard counts, and `normaliseStatus` is what reads this.
      text('actionStatus', 'Status', ['status', 'action status', 'current status']),
      longtext('workDetail', 'Detail of the works', [
        'detail of the works',
        'details of the works',
        'detail of work',
        'work detail',
        'details',
        'detail',
      ]),

      // Not in today's sheet. Declared so that adding either column to the
      // workbook is all it takes for QC to appear in the overdue counts and in
      // somebody's reminder email.
      date('targetDate', 'Target Date', ['target date', 'due date', 'targate date', 'completion date']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner', 'attended by']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'notes']),
    ],
    roles: {
      ref: 'workOrderNo',
      title: 'workDetail',
      due: 'targetDate',
      issued: 'date',
      status: 'actionStatus',
      priority: 'findingClassification',
      actionBy: 'actionBy',
      location: 'equipmentTag',
      discipline: 'workCenter',
    },
  },

  /**
   * PM/CM Quality Audit — field audits of maintenance work as it happens.
   *
   * An auditor walks the job, checks the permit against what is actually going
   * on, and writes down one of two verdicts. That verdict is the point of the
   * register, and it is why this one is shaped differently again from QC:
   *
   *  * **The verdict carries the status.** The sheet has no status column, and
   *    inventing one that everything defaults to "Not Started" would fill the
   *    register with jobs nobody can ever close — most audits find nothing
   *    wrong, and there is no work to track in a job done correctly. So a
   *    `Compliance` arrives closed and a `Non compliance` arrives open, through
   *    the `statusFrom` role. The moment somebody sets the Status column on a
   *    row, that wins: closing out a finding is a real event and has to be
   *    recordable.
   *  * **The verdict carries the urgency too.** A non-compliance is High; a
   *    compliance is Low. There is no priority column to read instead.
   *  * **The auditor is the initiator, not the owner.** They found it; somebody
   *    else fixes it. `Action By` and `Target Date` are declared for that
   *    somebody, empty until the team starts filling them in — at which point
   *    these rows join the overdue counts and the reminders with no change here.
   */
  {
    id: 'quality-audit',
    name: 'Quality Audit',
    short: 'QA',
    exportTitle: 'Engineering PM/CM Quality Audit',
    description: 'PM/CM quality audits of maintenance work in the field.',
    sheetAliases: [
      'quality audit',
      'pm quality audit',
      'pmcm quality audit',
      'pm cm quality audit',
      'pm/cm quality audit',
      'field audit',
      'compliance audit',
    ],
    tableColumns: ['date', 'time', 'area', 'permitNumber', 'equipment', 'verdict', 'observation', 'auditor'],
    fields: [
      date('date', 'Date', ['date', 'audit date']),
      time('time', 'Time', ['time', 'audit time']),
      select('area', 'Area', AREA_OPTIONS, ['area', 'plant', 'unit']),
      // Two work-order columns, one filled per row: an audit is of either a
      // planned job or a corrective one. Text rather than number — a twelve-digit
      // order is an identifier, and nothing good comes of it being arithmetic.
      text('pmWorkOrder', 'PM Work Order', ['pm work order', 'pm workorder', 'pm wo', 'pm order', 'pm']),
      text('cmWorkOrder', 'CM Work Order', ['cm work order', 'cm workorder', 'cm wo', 'cm order', 'cm']),
      text('permitType', 'Permit Type', ['permit type', 'type of permit', 'permit']),
      text('permitNumber', 'Permit Number', ['permit number', 'permit no', 'permit num']),
      text('equipment', 'Equipment', ['equipment', 'equipment tag', 'tag', 'tag no']),
      select('verdict', 'Quality Audit', VERDICTS, [
        'quality audit',
        'audit result',
        'result',
        'compliance',
        'finding',
        'verdict',
      ]),
      longtext('observation', 'Quality Observation', [
        'quality observation',
        'observation',
        'observations',
        'audit observation',
        'findings',
      ]),
      text('auditor', 'Auditor', ['auditor', 'audited by', 'inspector', 'audit by']),
      longtext('remarks', 'Remarks', ['remarks', 'comment', 'comments', 'notes', 'action taken']),

      // The close-out half. Not in today's sheet; declared so a finding can be
      // followed to its end without a schema change the day the team wants to.
      select('status', 'Status', STATUSES, ['status', 'action status', 'close out status']),
      date('targetDate', 'Target Date', ['target date', 'due date', 'etc', 'completion date']),
      text('actionBy', 'Action By', ['action by', 'responsible', 'owner', 'assigned to']),
    ],
    roles: {
      ref: 'permitNumber',
      title: 'observation',
      due: 'targetDate',
      issued: 'date',
      status: 'status',
      // Falls back to the verdict when nobody has set a status — see above.
      statusFrom: 'verdict',
      priority: 'verdict',
      verdict: 'verdict',
      actionBy: 'actionBy',
      initiator: 'auditor',
      area: 'area',
      location: 'equipment',
    },
  },
];

/** Registers that reach a compliance verdict, and the field holding it. */
export const VERDICT_REGISTERS = REGISTERS.filter((r) => r.roles.verdict);

/**
 * The heading across the top of an exported sheet.
 *
 * A document title, not a description of the software: the file goes out to
 * other departments, and "Action Notice — Engineering action notices raised on
 * plant equipment." reads as a tooltip that escaped onto a form. The `description`
 * stays where it belongs, on the register page in the app.
 *
 * A register may name its own; otherwise it is the department and the register,
 * which is how the team's own workbooks are headed.
 */
export function exportTitle(register) {
  return register.exportTitle ?? `Engineering ${register.name}`;
}

export const REGISTER_BY_ID = new Map(REGISTERS.map((r) => [r.id, r]));

export function getRegister(id) {
  return REGISTER_BY_ID.get(String(id ?? '').toLowerCase()) ?? null;
}

/**
 * Excel serial dates far outside plant history are a spreadsheet accident, not a
 * date. The uploaded EIS sheet has several 1934/1935 "Next Inspection" values —
 * a five-year addition that wrapped. Admitting them would put permanently
 * overdue rows at the top of every dashboard, so they are kept as raw text and
 * excluded from date maths.
 */
const MIN_PLAUSIBLE_YEAR = 1990;
const MAX_PLAUSIBLE_YEAR = 2100;

/**
 * Coerce a cell to a calendar date, or null when it is a phrase.
 *
 * "Next Shutdown" in an ETC column is real, deliberate information — it means the
 * work is scheduled but not dated. It must survive as text rather than being
 * discarded for failing to parse.
 */
export function toDateOnly(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return withinRange(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial: days since 1899-12-30 (the epoch that absorbs the 1900 leap bug).
    const ms = Math.round((value - 25569) * 86400 * 1000);
    return withinRange(new Date(ms));
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // dd/mm/yyyy, dd-mm-yyyy and dd.mm.yyyy, which Excel exports as text more often
  // than not. The dotted form is what the PZV sheet's later rows use, and without
  // it eleven valves parsed as "no date" and vanished from the overdue counts.
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return withinRange(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
  }

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return withinRange(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return withinRange(parsed);
}

/**
 * Coerce a cell to a clock time — `09:00` — or null.
 *
 * Excel has no time-only type. A cell showing 09:00 holds 0.375, a fraction of
 * a day, and ExcelJS hands it over as a `Date` on 30 December 1899, its epoch.
 * Read as an ordinary date that becomes "1899-12-30", which tells nobody when
 * the audit happened.
 *
 * UTC accessors deliberately: the fraction is a wall-clock time with no zone,
 * and reading it locally would shift 09:00 by however many hours the reader
 * happens to be from UTC.
 */
export function toClockTime(value) {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
  }

  // A bare fraction of a day, which is what the cell holds underneath.
  if (typeof value === 'number' && Number.isFinite(value)) {
    const minutes = Math.round((value % 1) * 24 * 60);
    return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  }

  const raw = String(value).trim();
  // "9:00", "09:00 AM", "21:30". Anything else is left as written rather than
  // guessed at — a note in a time column is still information.
  const match = /^(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(raw);
  if (!match) return raw || null;

  let hours = Number(match[1]) % 24;
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  return `${pad(hours)}:${match[2]}`;
}

function withinRange(dateValue) {
  const year = dateValue.getUTCFullYear();
  if (year < MIN_PLAUSIBLE_YEAR || year > MAX_PLAUSIBLE_YEAR) return null;
  // Normalise to a plain calendar day. A due date has no time of day, and keeping
  // one makes "due today" depend on the reader's timezone.
  return `${year}-${pad(dateValue.getUTCMonth() + 1)}-${pad(dateValue.getUTCDate())}`;
}

const pad = (n) => String(n).padStart(2, '0');

export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Whole days from today to `iso`; negative when the date has passed. */
export function daysUntil(iso, from = todayIso()) {
  if (!iso) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * A date as the team reads it: month/day/year.
 *
 * Dates are stored and compared as `YYYY-MM-DD`, which sorts correctly and is
 * unambiguous, and turned into this only at the moment of display. One function
 * so the spreadsheet, the printed report and the reminder emails cannot drift
 * into three different conventions.
 *
 * Anything that is not a plain date — `Next Shutdown`, `SEP` — is passed
 * through untouched, because it is a note rather than a date.
 */
export function formatDisplayDate(value) {
  const raw = String(value ?? '');
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  return match ? `${match[2]}/${match[3]}/${match[1]}` : raw;
}

/** The window the team called "near one month or less". */
export const DUE_SOON_DAYS = 30;

export function dueState(dueDate, status) {
  if (CLOSED_STATUSES.has(status)) return 'closed';
  if (!dueDate) return 'undated';
  const days = daysUntil(dueDate);
  if (days === null) return 'undated';
  if (days < 0) return 'overdue';
  if (days <= DUE_SOON_DAYS) return 'due-soon';
  return 'scheduled';
}

/**
 * Fold a register-specific row into the shared shape the dashboard reads.
 *
 * Returns only derived values; `data` is stored untouched alongside so nothing
 * from the original sheet is ever lost to normalisation.
 */
export function deriveRecord(register, data) {
  const roles = register.roles;
  const pick = (role) => {
    const key = roles[role];
    if (!key) return null;
    const value = data?.[key];
    if (value === null || value === undefined) return null;
    const trimmed = typeof value === 'string' ? value.trim() : value;
    return trimmed === '' ? null : trimmed;
  };

  const dueRaw = pick('due');
  const dueDate = toDateOnly(dueRaw);

  /**
   * The status, and where a register with no status column gets one.
   *
   * `statusFrom` names a second column to read when the first is empty — for
   * quality audits, the verdict, so a compliance lands closed and a
   * non-compliance lands open. An explicit status always wins: the fallback is
   * for rows nobody has ruled on yet, not a rule that overrides the team.
   */
  const statusSource = pick('status') ?? pick('statusFrom');
  const status = normaliseStatus(statusSource) ?? 'Not Started';
  const priority = normalisePriority(pick('priority')) ?? 'Medium';

  const title = pick('title');
  const ref = pick('ref');

  return {
    ref: ref === null ? null : String(ref),
    title: title === null ? null : String(title),
    // The phrase behind an unparseable due date ("Next Shutdown", "SEP"), kept so
    // the table can show why a row has no date instead of showing an empty cell.
    dueText: dueDate ? null : dueRaw === null ? null : String(dueRaw),
    dueDate,
    issuedDate: toDateOnly(pick('issued')),
    closedDate: toDateOnly(pick('closed')),
    priority,
    priorityRaw: pick('priority') === null ? null : String(pick('priority')),
    status,
    statusRaw: statusSource === null ? null : String(statusSource),
    actionBy: pick('actionBy') === null ? null : String(pick('actionBy')).trim(),
    initiator: pick('initiator') === null ? null : String(pick('initiator')).trim(),
    area: pick('area') === null ? null : String(pick('area')).trim(),
    discipline: pick('discipline') === null ? null : String(pick('discipline')).trim(),
    location: pick('location') === null ? null : String(pick('location')).trim(),
  };
}

/** Serialisable definitions for the browser, so the UI is never a second source of truth. */
export function registerCatalogue() {
  return REGISTERS.map((r) => ({
    id: r.id,
    name: r.name,
    short: r.short,
    description: r.description,
    fields: r.fields,
    tableColumns: r.tableColumns,
    roles: r.roles,
    // So the form knows to ask for a number and to label the field as automatic.
    autoNumber: r.autoNumber ?? null,
  }));
}
