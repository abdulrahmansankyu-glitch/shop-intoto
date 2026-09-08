/**
 * The standalone build's stand-in for the server.
 *
 * `build-standalone.js` bundles this with the register definitions, the query and
 * dashboard logic, the workbook reader/writer and the UI into one HTML file that
 * runs with no server at all.
 *
 * It answers exactly the paths the real API answers, and returns real `Response`
 * objects, so `app.js` uses the same code either way. The UI is not a second
 * implementation with its own idea of what "overdue" means — the offline copy runs
 * the very same modules the hosted deployment does.
 *
 * The difference is where records live: **this browser**, not a shared database.
 * Two people opening the same file each keep their own copy; the exported workbook
 * is how work moves between them.
 */

const STORAGE_KEY = 'tracker.standalone.v1';

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { records: [], activity: [], imports: [], rota: null };
    const parsed = JSON.parse(raw);
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
      activity: Array.isArray(parsed.activity) ? parsed.activity : [],
      imports: Array.isArray(parsed.imports) ? parsed.imports : [],
      rota: parsed.rota ?? null,
    };
  } catch {
    return { records: [], activity: [], imports: [], rota: null };
  }
}

let state = load();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    // Browser storage is a few megabytes. Saying so beats a silent half-save that
    // looks fine until the page is reloaded and the newest rows are missing.
    if (error?.name === 'QuotaExceededError' || error?.code === 22) {
      throw new Error(
        'This browser is out of storage for the tracker. Export to Excel, then use "Replace everything in this register" on your next import instead of adding to it.',
      );
    }
    throw error;
  }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fail = (status, message) => json({ error: message }, status);

function logActivity(entry) {
  state.activity.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...entry });
  state.activity = state.activity.slice(0, 500);
}

/** Uploaded workbooks held between the inspect step and the confirm step. */
const pendingUploads = new Map();

function xlsxResponse(buffer, filename) {
  return new Response(buffer, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}

globalThis.__trackerLocalApi = async function localApi(path, options = {}) {
  const [pathname, search] = path.split('?');
  const params = new URLSearchParams(search ?? '');
  const method = (options.method ?? 'GET').toUpperCase();
  const actor = options.headers?.['x-user-name'] || 'Unknown';
  const payload = options.body && typeof options.body === 'string' ? JSON.parse(options.body) : null;

  const asRecords = (register = null) =>
    state.records.filter((r) => !register || r.register === register).map(toApi);

  try {
    // ---- configuration --------------------------------------------------

    if (pathname === '/api/config') {
      return json({
        requiresAccessCode: false,
        storage: 'browser',
        storageNotice:
          'Offline copy — these records are saved in this browser only. Export to Excel to share them with the team.',
        dueSoonDays: DUE_SOON_DAYS,
        priorities: PRIORITY_VALUES,
        statuses: STATUSES,
        areas: AREA_OPTIONS,
        registers: registerCatalogue(),
      });
    }

    if (pathname === '/api/session') return json({ ok: true });

    // No accounts offline: the file is the permission. Whoever can open it can
    // already read and change everything in it, so a login would be theatre.
    if (pathname === '/api/auth/state') {
      return json({ needsSetup: false, requiresSetupCode: false, disabled: true, roles: [] });
    }
    if (pathname === '/api/auth/me') {
      return json({ user: { id: 'local', name: actor, role: 'admin', registers: [] } });
    }
    if (pathname === '/api/health') return json({ ok: true, storage: 'browser' });

    // ---- records ----------------------------------------------------------

    if (pathname === '/api/records' && method === 'GET') {
      const query = Object.fromEntries(params.entries());
      return json(applyQuery(asRecords(query.register), query));
    }

    if (pathname === '/api/records' && method === 'POST') {
      const register = getRegister(payload?.register);
      if (!register) return fail(400, 'Choose a register for this entry.');

      const data = sanitiseData(register, payload?.data);
      if (!Object.keys(data).length) return fail(400, 'Fill in at least one field.');

      const row = toRow({
        register: register.id,
        data,
        derived: deriveRecord(register, data),
        source: 'manual',
        actor,
      });

      state.records.push(row);
      logActivity({
        actor,
        action: 'create',
        register: register.id,
        recordId: row.id,
        summary: `Added ${register.name}: ${row.title ?? row.ref ?? 'new entry'}`,
      });
      persist();

      return json(toApi(row), 201);
    }

    const recordMatch = pathname.match(/^\/api\/records\/(.+)$/);
    if (recordMatch) {
      const id = decodeURIComponent(recordMatch[1]);
      const index = state.records.findIndex((r) => r.id === id);
      if (index === -1) return fail(404, 'That entry no longer exists.');

      const existing = toApi(state.records[index]);

      if (method === 'GET') return json(existing);

      if (method === 'DELETE') {
        state.records.splice(index, 1);
        logActivity({
          actor,
          action: 'delete',
          register: existing.register,
          recordId: id,
          summary: `Deleted: ${existing.title ?? existing.ref ?? id}`,
        });
        persist();
        return json({ ok: true });
      }

      if (method === 'PATCH') {
        const register = getRegister(existing.register);
        if (!register) return fail(400, 'That entry belongs to an unknown register.');

        // Only the changed fields arrive, so untouched columns keep their imported
        // values; an explicit empty string clears one.
        const incoming = payload?.data ?? {};
        const merged = { ...existing.data };
        for (const [key, value] of Object.entries(incoming)) {
          if (value === null || value === '') delete merged[key];
          else merged[key] = value;
        }

        const data = sanitiseData(register, merged);
        const row = toRow({
          id,
          register: register.id,
          data,
          derived: deriveRecord(register, data),
          source: existing.source,
          actor,
          createdAt: existing.createdAt,
          createdBy: existing.createdBy,
        });

        state.records[index] = row;

        const changed = Object.keys(incoming).filter(
          (key) => String(existing.data?.[key] ?? '') !== String(incoming[key] ?? ''),
        );
        if (changed.length) {
          logActivity({
            actor,
            action: 'update',
            register: register.id,
            recordId: id,
            summary: `Updated ${register.name}: ${row.title ?? row.ref ?? id}`,
            detail: { fields: changed },
          });
        }
        persist();

        return json(toApi(row));
      }
    }

    // ---- dashboard --------------------------------------------------------

    if (pathname === '/api/dashboard') {
      const all = asRecords(params.get('register'));
      // The same range the served app applies, so the offline copy and the
      // shared one cannot disagree about what a period contains.
      const range = {
        from: params.get('from') ?? null,
        to: params.get('to') ?? null,
        dateField: DATE_FIELDS.includes(params.get('dateField')) ? params.get('dateField') : 'any',
      };
      const records = range.from || range.to ? all.filter((r) => withinDates(r, range)) : all;

      return json({
        ...summarise(records),
        activity: state.activity.slice(0, 15),
        dateFilter: { ...range, matched: records.length, excluded: all.length - records.length },
        generatedAt: new Date().toISOString(),
      });
    }

    if (pathname === '/api/filters') {
      const records = asRecords(params.get('register'));
      const distinct = (key) =>
        [...new Set(records.map((r) => r[key]).filter(Boolean))].sort((a, b) =>
          String(a).localeCompare(String(b)),
        );
      return json({
        actionBy: distinct('actionBy'),
        initiator: distinct('initiator'),
        area: distinct('area'),
        discipline: distinct('discipline'),
      });
    }

    if (pathname === '/api/activity') return json({ activity: state.activity.slice(0, 60) });

    // ---- Excel ------------------------------------------------------------

    if (pathname === '/api/import/inspect') {
      const file = options.body?.get?.('file');
      if (!file) return fail(400, 'Attach an .xlsx file to upload.');

      const buffer = await file.arrayBuffer();
      let inspection;
      try {
        inspection = await inspectWorkbook(buffer);
      } catch {
        return fail(400, 'That file could not be read as an Excel workbook (.xlsx).');
      }

      const token = crypto.randomUUID();
      pendingUploads.set(token, { filename: file.name, buffer });

      const remembered = state.imports.find((i) => i.filename === file.name)?.mapping ?? null;
      return json({ token, filename: file.name, remembered, ...inspection });
    }

    if (pathname === '/api/import/commit') {
      const pending = pendingUploads.get(payload?.token);
      if (!pending) return fail(410, 'That upload has expired — please choose the file again.');

      const selections = Array.isArray(payload?.selections) ? payload.selections : [];
      if (!selections.length) return fail(400, 'Choose at least one sheet to import.');

      const results = [];
      const cleared = new Set();
      for (const selection of selections) {
        const register = getRegister(selection.register);
        if (!register) {
          results.push({ sheet: selection.sheet, error: `Unknown register: ${selection.register}` });
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
          const before = state.records.length;
          state.records = state.records.filter((r) => r.register !== register.id);
          replaced = before - state.records.length;
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

        state.records.push(...rows);

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

        logActivity({
          actor,
          action: 'import',
          register: register.id,
          summary: `Imported ${rows.length} rows into ${register.name} from ${pending.filename}`,
          detail: { sheet: selection.sheet, replaced },
        });
      }

      // The choices are kept so the next upload of this file is one click. The
      // workbook itself is not: browser storage is a few megabytes in total, and
      // spending it on file bytes would start failing the record saves that
      // matter more. The hosted deployment does keep the files.
      state.imports.unshift({
        id: crypto.randomUUID(),
        filename: pending.filename,
        uploadedAt: new Date().toISOString(),
        uploadedBy: actor,
        sizeBytes: pending.buffer.byteLength,
        sheetNames: selections.map((sel) => sel.sheet),
        mapping: selections,
        results,
        contentStored: false,
      });
      state.imports = state.imports.slice(0, 20);

      persist();
      return json({ results });
    }

    if (pathname === '/api/imports') {
      const register = params.get('register');
      const imports = register
        ? state.imports.filter((e) => (e.results ?? []).some((r) => r.register === register))
        : state.imports;
      return json({ imports });
    }

    if (pathname === '/api/export') {
      const requested = params.get('register');
      const registers = requested ? [getRegister(requested)].filter(Boolean) : REGISTERS;
      if (!registers.length) return fail(400, 'Unknown register.');

      const groups = registers.map((register) => ({
        register,
        records: asRecords(register.id),
      }));

      const stamp = new Date().toISOString().slice(0, 10);
      const name = requested
        ? `${registers[0].name.replace(/\s+/g, '_')}_${stamp}.xlsx`
        : `Engineering_Tracker_${stamp}.xlsx`;

      return xlsxResponse(await buildWorkbook(groups), name);
    }

    if (pathname === '/api/template') {
      const register = getRegister(params.get('register'));
      if (!register) return fail(400, 'Unknown register.');
      return xlsxResponse(
        await buildWorkbook([{ register, records: [] }]),
        `${register.name.replace(/\s+/g, '_')}_template.xlsx`,
      );
    }


    // ---- duty rota --------------------------------------------------------
    //
    // The same endpoints the server answers, over the same rota module, so the
    // offline copy shares the duties out by exactly the rules the hosted one
    // does. Only the storage differs — this browser rather than the team's
    // database, which makes an offline rota one person's working copy.

    if (pathname === '/api/rota' || pathname === '/api/rota/fill') {
      const stored = state.rota ? normaliseRota(state.rota) : defaultRota();
      const answer = (doc, status = 200) =>
        json(
          {
            rota: doc,
            calendar: calendarOf(doc),
            thisWeek: currentWeek(doc),
            unfilled: unfilledCount(doc),
          },
          status,
        );

      const commit = (doc, summary) => {
        state.rota = {
          ...doc,
          rev: stored.rev + 1,
          updatedAt: new Date().toISOString(),
          updatedBy: actor,
        };
        logActivity({ actor, action: 'rota', summary });
        persist();
        return answer(state.rota);
      };

      if (pathname === '/api/rota' && method === 'GET') return answer(stored);

      if (pathname === '/api/rota' && method === 'PUT') {
        if (Number(payload?.rev) !== stored.rev) {
          return answer(stored, 409);
        }
        return commit(normaliseRota({ ...payload, rev: stored.rev }), 'Updated the safety duty rota');
      }

      if (pathname === '/api/rota/fill' && method === 'POST') {
        return commit(fillRota(stored, payload?.parts ?? {}), 'Filled the safety duty rota');
      }
    }

    return fail(404, 'Unknown endpoint.');
  } catch (error) {
    return fail(500, error?.message ?? 'Something went wrong.');
  }
};
