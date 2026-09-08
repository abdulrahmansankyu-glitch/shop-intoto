/**
 * Reading and writing the team's workbooks.
 *
 * The uploaded files are real working spreadsheets, not exports, so the reader is
 * built around what they actually contain rather than an idealised table:
 *
 *  * Row 1 is a merged banner ("Solid Handling Plant's IWS Track"); the real header
 *    is row 2. The header row is found by matching, not assumed.
 *  * "Routine Inspection" starts in column B, so column positions are discovered
 *    rather than counted from 1.
 *  * Header wording drifts between files ("Action By " with a trailing space,
 *    "Refrence", "Plan date for callibration"), so matching ignores case, spacing
 *    and punctuation, and every field carries the spellings seen in the wild.
 *  * A column the app does not recognise is preserved as an extra field instead of
 *    being dropped — losing a column on import is worse than carrying one it has
 *    no opinion about.
 */

import ExcelJS from 'exceljs';

import {
  CLOSED_STATUSES,
  REGISTERS,
  daysUntil,
  deriveRecord,
  dueState,
  exportTitle,
  getRegister,
  normaliseKey,
  toClockTime,
  toDateOnly,
} from './registers.js';

/** How many leading rows to consider when hunting for the header. */
const HEADER_SEARCH_ROWS = 10;

/** Below this many recognised columns, a row is not a header. */
const MIN_HEADER_MATCHES = 3;

/**
 * Row-number columns, dropped rather than stored.
 *
 * Every sheet opens with one and spells it differently ("Sl no", "Ser.", "SL.NO",
 * "S.", "sl"). It is a position, not data: it renumbers itself whenever rows are
 * sorted or inserted, so keeping it would preserve a value that is wrong as soon
 * as anyone filters. Ignoring it also fixes row detection — the Action Notice
 * sheet carries a dozen pre-numbered empty rows waiting for next month's entries,
 * and a serial alone must not make a row count as data.
 */
const SERIAL_HEADERS = new Set(['slno', 'sl', 'sno', 'srno', 'sr', 'ser', 'serial', 's', 'no', 'item']);

/**
 * Columns this app adds on export, ignored when reading.
 *
 * Exporting and re-importing is a normal round trip here — someone downloads the
 * master file, edits it offline, uploads it back. Without this, each pass would
 * bolt another copy of the app's own computed columns onto every row.
 */
const COMPUTED_HEADERS = new Set([
  'trackerpriority',
  'trackerstatus',
  'trackerduedate',
  'daystodue',
  'duestate',
  'lastupdated',
  'updatedby',
]);

/** Every spelling that resolves to a field, for one register. */
function aliasIndex(register) {
  const index = new Map();
  for (const field of register.fields) {
    const spellings = [field.key, field.label, ...(field.aliases ?? [])];
    for (const spelling of spellings) {
      const key = normaliseKey(spelling);
      if (key && !index.has(key)) index.set(key, field.key);
    }
  }
  return index;
}

const ALIAS_INDEXES = new Map(REGISTERS.map((r) => [r.id, aliasIndex(r)]));

/**
 * Flatten an ExcelJS cell to plain text.
 *
 * Cells in these files arrive as rich text runs, formula wrappers and hyperlink
 * objects as well as primitives; `String(value)` on any of those yields
 * "[object Object]".
 */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value;
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map((r) => r.text ?? '').join('');
    if ('text' in value) return String(value.text ?? '');
    if ('result' in value) return cellText(value.result);
    if ('hyperlink' in value) return String(value.hyperlink ?? '');
    if ('error' in value) return '';
    return '';
  }
  return value;
}

function asTrimmedString(value) {
  const flat = cellText(value);
  if (flat instanceof Date) return flat;
  return typeof flat === 'string' ? flat.trim() : flat;
}

/**
 * Find the header row for `register` in `worksheet`, and which column holds which
 * field. Returns null when the sheet does not look like this register at all.
 */
export function detectHeader(worksheet, register) {
  const index = ALIAS_INDEXES.get(register.id);
  let best = null;

  const limit = Math.min(worksheet.rowCount || HEADER_SEARCH_ROWS, HEADER_SEARCH_ROWS);
  for (let rowNumber = 1; rowNumber <= limit; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    if (!row || !row.cellCount) continue;

    const columnMap = new Map();
    const unmapped = [];
    const seen = new Set();

    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const header = asTrimmedString(cell.value);
      const label = header instanceof Date ? '' : String(header ?? '').trim();
      if (!label) return;

      const key = normaliseKey(label);
      if (SERIAL_HEADERS.has(key) || COMPUTED_HEADERS.has(key)) return;

      const field = index.get(key);
      // A repeated header (some sheets duplicate "Status") maps once; the second
      // occurrence is kept as an extra column rather than silently overwriting.
      if (field && !seen.has(field)) {
        seen.add(field);
        columnMap.set(colNumber, { field, label, extra: false });
      } else {
        unmapped.push({ colNumber, label });
      }
    });

    const matched = columnMap.size;
    if (matched >= MIN_HEADER_MATCHES && (!best || matched > best.matched)) {
      best = { rowNumber, columnMap, unmapped, matched };
    }
  }

  return best;
}

/** Rank every register against a sheet and return the closest fit. */
export function suggestRegister(worksheet) {
  const sheetKey = normaliseKey(worksheet.name);
  let best = null;

  for (const register of REGISTERS) {
    const header = detectHeader(worksheet, register);
    if (!header) continue;

    // Sheet-name agreement is a tiebreaker only, never a contribution to the
    // score. Both uploaded workbooks contain a sheet literally called "Sheet1",
    // and a name that happens to match must not outrank a register whose columns
    // genuinely fit better — weighting the name instead of ranking after it let a
    // truncated IWS sheet named "Sheet1" resolve to Action Notice.
    const nameMatch = register.sheetAliases.some((alias) => normaliseKey(alias) === sheetKey);

    const better =
      !best ||
      header.matched > best.header.matched ||
      (header.matched === best.header.matched && nameMatch && !best.nameMatch);

    if (better) best = { register, header, score: header.matched, nameMatch };
  }

  return best;
}

/** Describe every sheet in a workbook so the user can confirm the mapping. */
export async function inspectWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];
  workbook.eachSheet((worksheet) => {
    const suggestion = suggestRegister(worksheet);

    if (!suggestion) {
      sheets.push({
        name: worksheet.name,
        rowCount: worksheet.rowCount ?? 0,
        suggestedRegister: null,
        headerRow: null,
        headers: [],
        mappedColumns: [],
        unmappedColumns: [],
        dataRows: 0,
        sample: [],
      });
      return;
    }

    const { register, header } = suggestion;
    const extracted = extractRows(worksheet, register, header);

    // Columns that carry a cross-cutting role and were not found in this sheet.
    //
    // A missing due-date column is the dangerous one: the rows import cleanly, the
    // counts look right, and every one of them is quietly invisible to Overdue and
    // Due-in-30-days for ever. That happened to a DCU master sheet whose target
    // date column was spelled differently from the SHP one beside it, and nothing
    // in the import summary said so.
    const mapped = new Set([...header.columnMap.values()].map((c) => c.field));
    const missingKeyColumns = ['due', 'ref', 'status']
      .map((role) => ({ role, key: register.roles[role] }))
      .filter(({ key }) => key && !mapped.has(key))
      .map(({ role, key }) => ({
        role,
        key,
        label: register.fields.find((f) => f.key === key)?.label ?? key,
      }));

    sheets.push({
      name: worksheet.name,
      // `actualRowCount` counts rows holding something; `rowCount` is the last
      // row Excel has touched, which on the QC sheet is 1,048,568 because of a
      // stray AVERAGE left at the bottom of the column.
      rowCount: worksheet.actualRowCount ?? worksheet.rowCount ?? 0,
      suggestedRegister: register.id,
      suggestedRegisterName: register.name,
      confidence: header.matched,
      headerRow: header.rowNumber,
      headers: [...header.columnMap.values()].map((c) => c.label),
      mappedColumns: [...header.columnMap.values()].map((c) => ({ label: c.label, field: c.field })),
      unmappedColumns: header.unmapped.map((c) => c.label),
      missingKeyColumns,
      dataRows: extracted.rows.length,
      skippedRows: extracted.skipped,
      sample: extracted.rows.slice(0, 3),
    });
  });

  return { sheets };
}

/**
 * Pull data rows out of a worksheet.
 *
 * Blank rows are common in these files — the Action Notice sheet carries pre-numbered
 * empty rows 20–31 ready for next month's entries. A row counts as data only if a
 * field other than the serial number holds something.
 */
export function extractRows(worksheet, register, header = null) {
  const detected = header ?? detectHeader(worksheet, register);
  if (!detected) return { rows: [], skipped: 0, issues: [] };

  const fieldTypes = new Map(register.fields.map((f) => [f.key, f.type]));
  const rows = [];
  const issues = [];
  let skipped = 0;
  let pendingSkipped = 0;

  const lastRow = worksheet.rowCount ?? 0;
  for (let rowNumber = detected.rowNumber + 1; rowNumber <= lastRow; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);

    // Wholly empty rows are held back rather than counted, and the tally is
    // discarded if nothing follows them.
    //
    // `rowCount` is the last row Excel has touched, not the last row with data:
    // the QC sheet's stray AVERAGE sits at row 1,048,568, so counting these
    // directly reported "846 imported, 1,047,717 blank rows skipped". A gap
    // inside the data is worth mentioning; the empty million past the end of it
    // is not.
    if (!row || !row.cellCount) {
      pendingSkipped += 1;
      continue;
    }

    const data = {};
    let hasValue = false;
    // Whether anything identifying this as a job was found — see below.
    let hasIdentity = false;

    for (const [colNumber, column] of detected.columnMap) {
      const raw = asTrimmedString(row.getCell(colNumber).value);
      if (raw === '' || raw === null || raw === undefined) continue;

      const type = fieldTypes.get(column.field);
      let value;

      if (type === 'date') {
        // A date column holding "Next Shutdown" keeps the phrase; the derived due
        // date simply stays empty rather than the note being thrown away.
        value = toDateOnly(raw) ?? (raw instanceof Date ? null : String(raw));
      } else if (type === 'number') {
        const n = Number(raw);
        value = Number.isFinite(n) ? n : String(raw);
      } else if (type === 'time') {
        value = toClockTime(raw);
      } else if (type === 'percent') {
        // Excel's `0%` format stores 90% as 0.9. Anything above 1 is already a
        // percentage — so a sheet holding a plain 90 is read correctly too.
        const n = Number(raw);
        value = Number.isFinite(n) ? (n > 0 && n <= 1 ? Math.round(n * 1000) / 10 : n) : String(raw);
      } else if (raw instanceof Date) {
        value = toDateOnly(raw) ?? raw.toISOString().slice(0, 10);
      } else {
        value = String(raw);
      }

      if (value === null || value === '') continue;
      data[column.field] = value;
      hasValue = true;
      // A number on its own never makes a job.
      //
      // The QC workbook ends with four rows carrying nothing but a SUM and two
      // AVERAGEs in the quality column — a running total somebody left below
      // the data. Every one of them satisfied "some field is filled" and would
      // have imported as an audit with no work order, no equipment and no
      // findings. A real record always names something: a work order, a tag, a
      // description, a date.
      if (type !== 'number' && type !== 'percent') hasIdentity = true;
    }

    // Unrecognised columns ride along under their sheet heading.
    for (const { colNumber, label } of detected.unmapped) {
      const raw = asTrimmedString(row.getCell(colNumber).value);
      if (raw === '' || raw === null || raw === undefined) continue;
      const value = raw instanceof Date ? toDateOnly(raw) ?? String(raw) : String(raw);
      if (!value) continue;
      data[`extra:${label}`] = value;
      hasValue = true;
      hasIdentity = true;
    }

    // A row holding nothing the app reads is as empty as one with no cells at
    // all, and is held back on the same terms.
    //
    // Excel disagrees: a row inside a bordered table has cells, so `cellCount`
    // is not zero, and the Quality Audit sheet's ten ruled-but-blank rows below
    // the data reported as "3 imported, 18 skipped" — a number that reads like
    // a mapping failure. What decides emptiness is whether any column the app
    // reads held a value, not whether somebody drew a border.
    if (!hasValue) {
      pendingSkipped += 1;
      continue;
    }

    // A row that held something and was still rejected always counts. That is
    // the number worth reporting — the QC sheet's four stray totals, a row with
    // a quality figure and no work order. Somebody should be told those were
    // passed over.
    if (!hasIdentity) {
      skipped += 1;
      continue;
    }

    skipped += pendingSkipped;
    pendingSkipped = 0;
    rows.push(data);
  }

  return { rows, skipped, issues };
}

/** Load a workbook and return the rows for one sheet, mapped to one register. */
export async function readSheet(buffer, sheetName, registerId) {
  const register = getRegister(registerId);
  if (!register) throw new Error(`Unknown register: ${registerId}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Sheet not found: ${sheetName}`);

  return { register, ...extractRows(worksheet, register) };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The exported sheet looks like the team's own workbook.
 *
 * A pale header with black text and a thin border on every cell, matching the
 * Action Notice file this replaces. The earlier dark-navy banded style was the
 * app's taste rather than theirs, and an export nobody recognises is one people
 * reformat by hand before sending it on.
 */
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCE6F1' } };
const HEADER_FONT = { bold: true, color: { argb: 'FF000000' }, size: 11 };

/**
 * How every date in an export is shown.
 *
 * Month/day/year, as the team asked for. It is a display format only — the cell
 * holds a real date, so Excel sorts and filters it correctly whatever this says,
 * and changing this one string changes every date in every export.
 *
 * Worth knowing before changing it: the workbooks this replaces were written
 * day/month/year (`16/08/2026` meaning 16 August), so the two conventions
 * disagree for any day of the month up to the twelfth. `dd/mm/yyyy` is the
 * switch back.
 */
const DATE_FORMAT = 'mm/dd/yyyy';

/**
 * The two cells the team colours by hand, now coloured on the way out.
 *
 * Deliberately narrow. Whole rows were tinted once and the team asked for it
 * gone, because on a document they forward it read as mark-up rather than as
 * information. A priority and a missed date are different: they are facts about
 * that one cell, and they are what somebody scans the sheet for.
 *
 * Low and Planned carry no fill at all — colouring every priority would leave
 * nothing standing out, which is the state the team was already in.
 */
const PRIORITY_FILLS = {
  Critical: { argb: 'FFC00000', text: 'FFFFFFFF' },
  High: { argb: 'FFFF0000', text: 'FFFFFFFF' },
  Medium: { argb: 'FFE36C0A', text: 'FF000000' },
};

const OVERDUE_FILL = { argb: 'FFFF0000', text: 'FFFFFFFF' };

const solid = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const THIN = { style: 'thin', color: { argb: 'FFB7BEC8' } };
const CELL_BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN };

/**
 * Columns appended after the register's own, carrying what the app worked out.
 *
 * The team asked for these out of the export: an exported sheet is one they
 * forward to other people, and it should carry their columns, not the app's
 * bookkeeping. `Days To Due` is the one they kept — it answers a question the
 * sheet cannot, and unlike the others it is not a restatement of a column
 * already there.
 *
 * The reader still ignores all seven headers on the way back in, so workbooks
 * exported before this change re-import without their old columns turning into
 * data.
 */
const COMPUTED_COLUMNS = [
  {
    header: 'Days To Due',
    width: 12,
    value: (r) => (r.dueDate && !CLOSED_STATUSES.has(r.status) ? daysUntil(r.dueDate) : ''),
  },
];

/**
 * How wide a column is allowed to get, by the kind of thing in it.
 *
 * `min` is the floor even for an empty column — enough for its own heading to
 * be readable, since a column nobody has filled in yet still has to be findable
 * when they come to fill it.
 */
const WIDTH_LIMITS = {
  longtext: { min: 24, max: 52 },
  date: { min: 11, max: 14 },
  number: { min: 8, max: 12 },
  percent: { min: 8, max: 12 },
  select: { min: 10, max: 18 },
  text: { min: 10, max: 30 },
};

/**
 * Size every column to what is actually in it.
 *
 * Fixed widths meant Priority, Status and Remarks took their full allowance
 * while sitting empty, and Description — the column people actually read — was
 * cramped into two wrapped lines beside them. Worse, the total came to more
 * than a page, so printing meant dragging every column by hand first.
 *
 * A long-text column is measured against its longest *line* rather than its
 * whole value, because it wraps: a 400-character description does not want a
 * 400-character column, it wants a sensible one and three rows of height.
 */
/**
 * Roughly how many characters fit across a landscape A4 page at a scale that is
 * still readable — about 70%, below which 9pt body text stops being worth
 * printing.
 *
 * Excel's fit-to-one-page-wide will scale by whatever it takes, however small,
 * so a wide register left alone prints at 43% and nobody can read it. Keeping
 * the natural width near this budget keeps the scaling it has to apply modest.
 */
const PRINT_WIDTH_BUDGET = 210;

/** The narrowest a wrapping column may be squeezed to before it stops helping. */
const LONGTEXT_FLOOR = 22;

/**
 * Bring an over-wide sheet back towards the budget by narrowing its wrapping
 * columns, which are the only ones that can lose width without losing content —
 * a description reflows onto another line, a date or a tag simply gets cut off.
 *
 * A register can still exceed the budget afterwards. QC has seventeen columns
 * including two long-text ones, and no amount of reflowing makes that a
 * comfortable single page; it just prints smaller, which is honest.
 */
function fitWidths(widths, types) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= PRINT_WIDTH_BUDGET) return widths;

  const flexible = types
    .map((type, i) => (type === 'longtext' ? i : -1))
    .filter((i) => i >= 0 && widths[i] > LONGTEXT_FLOOR);
  if (!flexible.length) return widths;

  const slack = flexible.reduce((sum, i) => sum + widths[i] - LONGTEXT_FLOOR, 0);
  const needed = Math.min(slack, total - PRINT_WIDTH_BUDGET);

  const out = [...widths];
  for (const i of flexible) {
    const share = (widths[i] - LONGTEXT_FLOOR) / slack;
    out[i] = Math.round(widths[i] - needed * share);
  }
  return out;
}

function measureColumn(header, values, type) {
  const limits = WIDTH_LIMITS[type] ?? WIDTH_LIMITS.text;
  // Two characters of breathing room, plus two more for the filter arrow the
  // header row carries — without it the last word of a heading sits under it.
  const headerWidth = String(header ?? '').length + 4;

  let content = 0;
  for (const value of values) {
    const text = value === null || value === undefined ? '' : String(value);
    if (!text) continue;
    content = Math.max(content, type === 'longtext' ? Math.min(text.length, limits.max) : text.length);
  }

  // An empty column is sized to its own heading and no more. The type minimum
  // is about readability of *content*, and applying it regardless is what left
  // an untouched Remarks column twenty-four characters wide next to the
  // Description everybody actually reads.
  if (!content) return Math.min(limits.max, headerWidth);

  return Math.min(limits.max, Math.max(headerWidth, limits.min, content + 4));
}

/** A data URI as ExcelJS wants it: raw base64 plus the extension separately. */
function imageParts(dataUri) {
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(String(dataUri ?? ''));
  if (!match) return null;
  return { extension: match[1] === 'jpg' ? 'jpeg' : match[1], base64: match[2] };
}

/**
 * The banner across the top of every sheet.
 *
 * The team's own workbooks carry the contractor's mark at the left, the title
 * centred, and the client's at the right; an export that looks like the file it
 * replaces is one people forward rather than reformat.
 *
 * The images float over the merged row rather than sitting in cells, because an
 * Excel image is an overlay in any case — anchoring it to a cell would still not
 * make the row size itself around it, so the row is given a fixed height instead.
 */
const LOGO_HEIGHT = 34;
const BANNER_ROW_HEIGHT = 42;

/**
 * Where a column boundary falls, in pixels from the left edge.
 *
 * Excel's column width is measured in characters of the default font, which is
 * roughly seven pixels each plus five of padding. The arithmetic is only needed
 * to place the right-hand logo: it has to sit at the right edge of a table whose
 * width differs for every register.
 */
function columnOffsets(widths) {
  const edges = [0];
  for (const width of widths) edges.push(edges[edges.length - 1] + Math.round(width * 7 + 5));
  return edges;
}

/** Turn a pixel offset into the fractional column index ExcelJS anchors to. */
function columnAt(edges, pixels) {
  for (let i = 1; i < edges.length; i += 1) {
    if (edges[i] >= pixels) {
      const span = edges[i] - edges[i - 1] || 1;
      return i - 1 + (pixels - edges[i - 1]) / span;
    }
  }
  return edges.length - 1;
}

/**
 * Register each logo with the workbook once and reuse its id.
 *
 * `addImage` was being called per sheet, so a nine-register export embedded
 * eighteen copies of two images — with the 400 KB the upload allows, megabytes
 * of the same two pictures.
 */
function registerLogos(workbook, logos = {}) {
  const ids = {};
  for (const slot of ['left', 'right']) {
    const parts = imageParts(logos[slot]);
    if (parts) ids[slot] = workbook.addImage(parts);
  }
  return ids;
}

function writeBanner(sheet, title, widths, logoIds = {}) {
  sheet.mergeCells(1, 1, 1, widths.length);
  const banner = sheet.getCell(1, 1);
  banner.value = title;
  banner.font = { bold: true, size: 13 };
  banner.alignment = { vertical: 'middle', horizontal: 'center' };
  banner.fill = HEADER_FILL;
  banner.border = CELL_BORDER;
  sheet.getRow(1).height = BANNER_ROW_HEIGHT;

  const edges = columnOffsets(widths);
  const place = (id, width, leftPx) => {
    sheet.addImage(id, {
      tl: { col: columnAt(edges, leftPx), row: 0.15 },
      ext: { width, height: LOGO_HEIGHT },
      editAs: 'absolute',
    });
  };

  if (logoIds.left !== undefined) place(logoIds.left, 118, 6);

  if (logoIds.right !== undefined) {
    // Anchored from the right edge of the table, which is a different place on
    // every register — a fixed column index would land mid-table on the wide
    // ones and off the end of the narrow ones.
    place(logoIds.right, 96, Math.max(6, edges.at(-1) - 102));
  }
}

function writeRegisterSheet(workbook, register, records, logoIds) {
  const sheet = workbook.addWorksheet(register.name, {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  const headers = ['Sl no', ...register.fields.map((f) => f.label), ...COMPUTED_COLUMNS.map((c) => c.header)];

  const types = ['number', ...register.fields.map((f) => f.type), ...COMPUTED_COLUMNS.map(() => 'number')];
  const widths = fitWidths(
    [
      // The serial column holds a row number and nothing else.
      Math.max(5, String(records.length).length + 3),
      ...register.fields.map((f) =>
        measureColumn(f.label, records.map((r) => r.data?.[f.key]), f.type),
      ),
      ...COMPUTED_COLUMNS.map((c) => measureColumn(c.header, records.map(c.value), 'number')),
    ],
    types,
  );
  // Set before the banner, which measures them to place the right-hand logo.
  sheet.columns = widths.map((width) => ({ width }));

  writeBanner(sheet, exportTitle(register), widths, logoIds);

  /**
   * Print setup, so the file arrives ready to print rather than ready to be
   * reformatted.
   *
   * `fitToWidth: 1` with `fitToHeight: 0` is the important pair: Excel scales
   * the sheet down until it is one page across, and lets it run to as many
   * pages down as the rows need. Setting both to 1 would squeeze a
   * eight-hundred-row register onto a single unreadable page.
   *
   * Rows 1–2 repeat at the top of every page, so page four still says which
   * column is which.
   */
  sheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 9, // A4
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    printTitlesRow: '1:2',
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  sheet.headerFooter = { oddFooter: '&L&F — &A&RPage &P of &N' };

  const headerRow = sheet.getRow(2);
  headerRow.values = headers;
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = CELL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  const dateColumns = new Set(
    register.fields.map((f, i) => (f.type === 'date' ? i + 2 : 0)).filter(Boolean),
  );

  // +2 for the serial column and for one-based indexing. Zero means the
  // register has no such column, which is a real case — QC has no priority of
  // its own beyond the finding classification.
  const columnOf = (key) => {
    const index = register.fields.findIndex((f) => f.key === key);
    return index < 0 ? 0 : index + 2;
  };
  const priorityColumn = register.roles.priority ? columnOf(register.roles.priority) : 0;
  const dueColumn = register.roles.due ? columnOf(register.roles.due) : 0;

  records.forEach((record, i) => {
    const values = [
      i + 1,
      ...register.fields.map((f) => {
        const value = record.data?.[f.key];
        if (value === undefined || value === null || value === '') return '';
        // A date column is written as a real date, not as whatever text it was
        // stored as. The same ETC column held "16/08/2026", "25-08-2026" and
        // "2026-09-03" at once — imported rows kept the spelling their sheet
        // used, typed ones were ISO — so the column could not be read at a
        // glance, sorted, or filtered by date.
        if (f.type === 'date') {
          const iso = toDateOnly(value);
          // A phrase is not a date and is left exactly as written. "Next sulfur
          // Shutdown" is a real, deliberate entry.
          return iso ? new Date(`${iso}T00:00:00Z`) : value;
        }
        return value;
      }),
      ...COMPUTED_COLUMNS.map((c) => c.value(record)),
    ];
    const row = sheet.addRow(values);
    // Centred, as the team's own workbooks are. `middle` with it, because
    // centred text sitting at the top of a three-line wrapped row looks like a
    // mistake rather than a choice.
    row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };

    // Applied per cell rather than per column: the cells holding a phrase must
    // stay text, and a date format on them would show nothing at all.
    for (const column of dateColumns) {
      const cell = row.getCell(column);
      if (cell.value instanceof Date) cell.numFmt = DATE_FORMAT;
    }

    row.eachCell((cell) => {
      cell.border = CELL_BORDER;
    });

    // The priority cell, coloured by the normalised value rather than by the
    // word in the sheet — so `P1` and `Critical` and `Alarm` all read the same
    // on the page, which is the whole reason those vocabularies were folded
    // onto one ladder.
    if (priorityColumn) {
      // Only when the sheet actually says one. An unset priority derives to
      // Medium so the dashboard has something to sort by, and colouring from
      // that painted empty cells orange — the sheet would have been claiming a
      // judgement nobody had made.
      const stated = String(record.data?.[register.roles.priority] ?? '').trim();
      const fill = stated ? PRIORITY_FILLS[record.priority] : null;
      if (fill) {
        const cell = row.getCell(priorityColumn);
        cell.fill = solid(fill.argb);
        cell.font = { bold: true, color: { argb: fill.text } };
      }
    }

    // The due date, red once it has passed. Closed work is left alone: a job
    // finished last month is not late, and marking it so is how a sheet ends up
    // with a column of red nobody reads any more.
    if (dueColumn && dueState(record.dueDate, record.status) === 'overdue') {
      const cell = row.getCell(dueColumn);
      cell.fill = solid(OVERDUE_FILL.argb);
      cell.font = { bold: true, color: { argb: OVERDUE_FILL.text } };
    }
  });

  if (records.length) {
    sheet.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: 2 + records.length, column: headers.length },
    };
  }

  return sheet;
}

function writeSummarySheet(workbook, groups, logoIds) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 2 }] });

  const widths = [24, 10, 10, 12, 15, 12, 14];
  sheet.columns = widths.map((width) => ({ width }));

  // One page, always: the Summary is a row per register.
  sheet.pageSetup = {
    orientation: 'landscape',
    paperSize: 9,
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 1,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
  };

  writeBanner(
    sheet,
    `Engineering Activity Tracker — exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    widths,
    logoIds,
  );

  const headerRow = sheet.getRow(2);
  headerRow.values = ['Register', 'Total', 'Open', 'Overdue', 'Due ≤ 30 days', 'Completed', 'No due date'];
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.border = CELL_BORDER;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const { register, records } of groups) {
    const open = records.filter((r) => !CLOSED_STATUSES.has(r.status));
    sheet.addRow([
      register.name,
      records.length,
      open.length,
      open.filter((r) => dueState(r.dueDate, r.status) === 'overdue').length,
      open.filter((r) => dueState(r.dueDate, r.status) === 'due-soon').length,
      records.filter((r) => r.status === 'Completed').length,
      open.filter((r) => !r.dueDate).length,
    ]);
  }

  return sheet;
}

/**
 * Build a workbook. With one register it produces that sheet alone; with several it
 * produces the whole master file, Summary first — the same layout the team's
 * Engineering Master file already uses.
 */
export async function buildWorkbook(groups, logos = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Engineering Activity Tracker';
  workbook.created = new Date();

  const logoIds = registerLogos(workbook, logos);
  if (groups.length > 1) writeSummarySheet(workbook, groups, logoIds);
  for (const { register, records } of groups) writeRegisterSheet(workbook, register, records, logoIds);

  return workbook.xlsx.writeBuffer();
}
