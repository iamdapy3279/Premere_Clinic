// Local SQLite store (Node's built-in node:sqlite — no dependencies).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, 'data', 'clinic.db');
const backupDir = join(root, 'data', 'backups');
mkdirSync(dirname(dbPath), { recursive: true });
mkdirSync(backupDir, { recursive: true });

export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
CREATE TABLE IF NOT EXISTS patients (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT NOT NULL,
  phone                  TEXT NOT NULL,
  language               TEXT NOT NULL DEFAULT 'English',
  call_purpose           TEXT NOT NULL,
  medicine_name          TEXT,
  dose_instructions      TEXT,
  scheduled_dose_time    TEXT,
  prescribing_doctor_name TEXT,
  front_desk_number      TEXT,
  remaining_doses_today  TEXT,
  next_medicine_name     TEXT,
  next_call_time         TEXT,
  notes                  TEXT,
  -- call lifecycle
  call_status            TEXT NOT NULL DEFAULT 'new',
  cohort_id              TEXT,
  queued_at              TEXT,
  attempts_count         INTEGER NOT NULL DEFAULT 0,
  last_attempt_id        TEXT,
  last_interaction_id    TEXT,
  last_called_at         TEXT,
  last_duration          REAL,
  last_failure_reason    TEXT,
  -- results written back from the conversation
  medication_call_disposition TEXT,
  patient_acknowledged_dose   TEXT,
  forwarded_to_front_desk     TEXT,
  callback_requested_time     TEXT,
  reminder_call_summary       TEXT,
  extracted_variables    TEXT,
  created_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id          TEXT PRIMARY KEY,
  patient_id          INTEGER REFERENCES patients(id) ON DELETE SET NULL,
  campaign_id         TEXT,
  cohort_id           TEXT,
  connectivity_status TEXT,
  completion_status   TEXT,
  next_action_status  TEXT,
  retry_attempt       INTEGER,
  duration            REAL,
  interaction_id      TEXT,
  failure_reason      TEXT,
  start_datetime      TEXT,
  agent_variables     TEXT,
  transcript          TEXT,
  source              TEXT NOT NULL,
  raw                 TEXT,
  received_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS cohorts (
  cohort_id    TEXT PRIMARY KEY,
  campaign_id  TEXT,
  name         TEXT,
  status       TEXT,
  patient_ids  TEXT,
  result       TEXT,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS activity (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind    TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_dispatches (
  patient_id   INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  slot         TEXT NOT NULL,
  date_ist     TEXT NOT NULL,
  dispatched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cohort_id    TEXT,
  PRIMARY KEY (patient_id, slot, date_ist)
);

CREATE INDEX IF NOT EXISTS idx_patients_status ON patients(call_status);
CREATE INDEX IF NOT EXISTS idx_attempts_patient ON attempts(patient_id);
CREATE INDEX IF NOT EXISTS idx_dispatches_date ON scheduled_dispatches(date_ist, slot);
`);

// Auto-migrate new patient columns if not present
const newColumns = [
  'emergency_contact TEXT',
  'dialysis_bay TEXT',
  'morning_medicines TEXT',
  'evening_medicines TEXT',
  'dinner_medicines TEXT',
  'morning_reminder_time TEXT',
  'evening_reminder_time TEXT',
  'dinner_reminder_time TEXT',
  'dialysis_appointment_date TEXT',
  'dialysis_appointment_time TEXT',
  'auto_call_enabled INTEGER DEFAULT 1',
  'preferred_language TEXT',
  'dose_slot TEXT',
];
for (const colDef of newColumns) {
  try {
    db.exec(`ALTER TABLE patients ADD COLUMN ${colDef};`);
  } catch {}
}

const now = () => new Date().toISOString();

// ── WAL Checkpointing & Automated Daily Backups ──────────────────────────────
export function checkpointWAL() {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    console.log('[db] WAL checkpoint executed successfully (WAL truncated).');
    return true;
  } catch (err) {
    console.warn('[db] WAL checkpoint warning:', err.message);
    return false;
  }
}

export function createDailyBackup() {
  try {
    mkdirSync(backupDir, { recursive: true });
    
    // Format current date in Kolkata timezone YYYY-MM-DD
    const nowD = new Date();
    const kDateStr = nowD.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const backupFile = join(backupDir, `clinic-${kDateStr}.db`);
    
    if (existsSync(backupFile)) {
      return { skipped: true, path: backupFile, date: kDateStr };
    }

    // Flush active WAL data first to guarantee pristine consistency
    checkpointWAL();

    // Atomic, zero-downtime database snapshot
    db.exec(`VACUUM INTO '${backupFile}';`);
    logActivity('backup', `Automated daily backup created: clinic-${kDateStr}.db`);
    console.log(`[db] Automated daily backup created: ${backupFile}`);

    // Prune backups older than 30 days
    pruneOldBackups(backupDir, 30);

    return { success: true, path: backupFile, date: kDateStr };
  } catch (err) {
    console.error('[db] Error creating daily backup:', err.message);
    logActivity('backup_error', `Backup failed: ${err.message}`);
    return { error: err.message };
  }
}

function pruneOldBackups(dir, retainDays = 30) {
  try {
    const files = readdirSync(dir);
    const nowMs = Date.now();
    const maxAgeMs = retainDays * 24 * 3600 * 1000;

    for (const f of files) {
      if (f.startsWith('clinic-') && f.endsWith('.db')) {
        const fullPath = join(dir, f);
        const stats = statSync(fullPath);
        if (nowMs - stats.mtimeMs > maxAgeMs) {
          unlinkSync(fullPath);
          console.log(`[db] Pruned old backup (>30 days): ${f}`);
        }
      }
    }
  } catch (err) {
    console.warn('[db] Warning during backup pruning:', err.message);
  }
}

export function listBackups() {
  try {
    mkdirSync(backupDir, { recursive: true });
    const files = readdirSync(backupDir);
    return files
      .filter((f) => f.startsWith('clinic-') && f.endsWith('.db'))
      .map((f) => {
        const p = join(backupDir, f);
        const s = statSync(p);
        return {
          filename: f,
          sizeBytes: s.size,
          createdAt: s.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.filename.localeCompare(a.filename));
  } catch {
    return [];
  }
}

// ── settings ────────────────────────────────────────────────────────────────
export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value ?? null;
export const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

// ── scheduled dispatches (deduplication) ────────────────────────────────────
export function isDispatched(patientId, slot, dateIst) {
  const row = db.prepare('SELECT 1 FROM scheduled_dispatches WHERE patient_id = ? AND slot = ? AND date_ist = ?').get(patientId, slot, dateIst);
  return Boolean(row);
}

export function recordDispatch(patientId, slot, dateIst, cohortId = null) {
  db.prepare(`
    INSERT INTO scheduled_dispatches(patient_id, slot, date_ist, cohort_id)
    VALUES(?, ?, ?, ?)
    ON CONFLICT(patient_id, slot, date_ist) DO UPDATE SET
      dispatched_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      cohort_id = excluded.cohort_id
  `).run(patientId, slot, dateIst, cohortId);
}

export function recentScheduledDispatches(dateIst, limit = 50) {
  return db.prepare('SELECT * FROM scheduled_dispatches WHERE date_ist = ? ORDER BY dispatched_at DESC LIMIT ?').all(dateIst, limit);
}

// ── activity log ────────────────────────────────────────────────────────────
export function logActivity(kind, message) {
  db.prepare('INSERT INTO activity(kind, message) VALUES(?, ?)').run(kind, message);
}
export const recentActivity = (limit = 40) =>
  db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit);

// ── patients ────────────────────────────────────────────────────────────────
const EDITABLE = [
  'name', 'phone', 'language', 'preferred_language', 'call_purpose',
  'front_desk_number', 'emergency_contact', 'dialysis_bay',
  'morning_medicines', 'evening_medicines', 'dinner_medicines',
  'morning_reminder_time', 'evening_reminder_time', 'dinner_reminder_time',
  'dialysis_appointment_date', 'dialysis_appointment_time',
  'medicine_name', 'dose_instructions', 'scheduled_dose_time', 'prescribing_doctor_name',
  'remaining_doses_today', 'next_medicine_name', 'next_call_time', 'notes',
  'auto_call_enabled', 'dose_slot'
];

export function listPatients(dateIst = null) {
  const patients = db.prepare('SELECT * FROM patients ORDER BY updated_at DESC').all().map(hydrate);
  if (dateIst) {
    const dispatches = db.prepare('SELECT patient_id, slot, dispatched_at FROM scheduled_dispatches WHERE date_ist = ?').all(dateIst);
    const map = new Map();
    for (const d of dispatches) {
      if (!map.has(d.patient_id)) map.set(d.patient_id, []);
      map.get(d.patient_id).push(d.slot);
    }
    for (const p of patients) {
      p.dispatches_today = map.get(p.id) || [];
    }
  } else {
    for (const p of patients) {
      p.dispatches_today = [];
    }
  }
  return patients;
}

export function getPatient(id) {
  const p = db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
  return p ? hydrate(p) : null;
}

export function createPatient(data) {
  const cols = EDITABLE.filter((c) => data[c] !== undefined);
  const info = db
    .prepare(`INSERT INTO patients(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => data[c] ?? null));
  return getPatient(Number(info.lastInsertRowid));
}

export function updatePatient(id, data) {
  const cols = EDITABLE.filter((c) => data[c] !== undefined);
  if (cols.length) {
    db.prepare(`UPDATE patients SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...cols.map((c) => data[c] ?? null), now(), id);
  }
  return getPatient(id);
}

/** Internal field update (call status / results). Not exposed to the browser directly. */
export function patchPatientInternal(id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  db.prepare(`UPDATE patients SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...cols.map((c) => fields[c]), now(), id);
}

export function deletePatient(id) {
  db.prepare('DELETE FROM patients WHERE id = ?').run(id);
}

export function patientsAwaitingResults() {
  return db
    .prepare(`SELECT * FROM patients WHERE call_status IN ('queued','no_answer','busy','failed') AND queued_at IS NOT NULL
              AND queued_at > ? ORDER BY queued_at`)
    .all(new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString());
}

function hydrate(p) {
  return {
    ...p,
    preferred_language: p.preferred_language || p.language || 'Hindi',
    auto_call_enabled: p.auto_call_enabled === null || p.auto_call_enabled === undefined ? 1 : Number(p.auto_call_enabled),
    needs_doctor_attention: p.needs_doctor_attention === null ? null : Boolean(p.needs_doctor_attention),
    extracted_variables: p.extracted_variables ? JSON.parse(p.extracted_variables) : null,
  };
}

// ── attempts ────────────────────────────────────────────────────────────────
export function getAttempt(attemptId) {
  return db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId) ?? null;
}

export function upsertAttempt(a) {
  db.prepare(`
    INSERT INTO attempts(attempt_id, patient_id, campaign_id, cohort_id, connectivity_status, completion_status,
      next_action_status, retry_attempt, duration, interaction_id, failure_reason, start_datetime,
      agent_variables, transcript, source, raw)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(attempt_id) DO UPDATE SET
      patient_id = COALESCE(excluded.patient_id, patient_id),
      connectivity_status = COALESCE(excluded.connectivity_status, connectivity_status),
      completion_status = COALESCE(excluded.completion_status, completion_status),
      next_action_status = excluded.next_action_status,
      duration = COALESCE(excluded.duration, duration),
      interaction_id = COALESCE(excluded.interaction_id, interaction_id),
      failure_reason = COALESCE(excluded.failure_reason, failure_reason),
      start_datetime = COALESCE(excluded.start_datetime, start_datetime),
      agent_variables = COALESCE(excluded.agent_variables, agent_variables),
      transcript = COALESCE(excluded.transcript, transcript),
      source = CASE WHEN source = 'webhook' THEN source ELSE excluded.source END,
      raw = COALESCE(excluded.raw, raw)
  `).run(
    a.attempt_id, a.patient_id ?? null, a.campaign_id ?? null, a.cohort_id ?? null,
    a.connectivity_status ?? null, a.completion_status ?? null, a.next_action_status ?? null,
    a.retry_attempt ?? null, a.duration ?? null, a.interaction_id ?? null, a.failure_reason ?? null,
    a.start_datetime ?? null,
    a.agent_variables ? JSON.stringify(a.agent_variables) : null,
    a.transcript ? JSON.stringify(a.transcript) : null,
    a.source, a.raw ? JSON.stringify(a.raw) : null,
  );
}

export function attemptsForPatient(patientId) {
  return db
    .prepare('SELECT * FROM attempts WHERE patient_id = ? ORDER BY COALESCE(start_datetime, received_at) DESC')
    .all(patientId)
    .map((a) => ({
      ...a,
      agent_variables: a.agent_variables ? JSON.parse(a.agent_variables) : null,
      transcript: a.transcript ? JSON.parse(a.transcript) : null,
      raw: undefined,
    }));
}

export function listRecentAttempts(limit = 100) {
  return db
    .prepare(`
      SELECT a.*, p.name as db_patient_name, p.phone as db_patient_phone
      FROM attempts a
      LEFT JOIN patients p ON a.patient_id = p.id
      ORDER BY COALESCE(a.start_datetime, a.received_at) DESC
      LIMIT ?
    `)
    .all(limit)
    .map((a) => {
      let raw = null;
      try { raw = a.raw ? JSON.parse(a.raw) : null; } catch {}
      let agentVars = null;
      try { agentVars = a.agent_variables ? JSON.parse(a.agent_variables) : null; } catch {}
      const durationSec = typeof a.duration === 'number' ? Math.round(a.duration * 10) / 10 : 0;
      return {
        attempt_id: a.attempt_id,
        patient_id: a.patient_id,
        patient_name: a.db_patient_name || agentVars?.patient_name || raw?.patient_name || 'Patient',
        user_phone: raw?.user_contact || agentVars?.patient_phone || a.db_patient_phone || '—',
        campaign_id: a.campaign_id,
        cohort_id: a.cohort_id,
        connectivity_status: a.connectivity_status || 'unknown',
        is_picked_up: a.connectivity_status === 'connected',
        duration_seconds: durationSec,
        start_datetime: a.start_datetime || a.received_at,
        ended_by: raw?.ended_by || (a.connectivity_status === 'connected' ? 'COMPLETED' : 'NO_ANSWER'),
        failure_reason: a.failure_reason,
      };
    });
}

// ── cohorts ─────────────────────────────────────────────────────────────────
export function insertCohort(c) {
  db.prepare(`INSERT INTO cohorts(cohort_id, campaign_id, name, status, patient_ids, result, dry_run)
              VALUES(?,?,?,?,?,?,?)`)
    .run(c.cohort_id, c.campaign_id, c.name, c.status, JSON.stringify(c.patient_ids), c.result ? JSON.stringify(c.result) : null, c.dry_run ? 1 : 0);
}

export function updateCohort(cohortId, { status, result }) {
  db.prepare('UPDATE cohorts SET status = ?, result = ?, updated_at = ? WHERE cohort_id = ?')
    .run(status, result ? JSON.stringify(result) : null, now(), cohortId);
}

export const processingCohorts = () =>
  db.prepare("SELECT * FROM cohorts WHERE status = 'processing' AND dry_run = 0").all();

export const recentCohorts = (limit = 10) =>
  db.prepare('SELECT * FROM cohorts ORDER BY created_at DESC LIMIT ?').all(limit).map((c) => ({
    ...c,
    patient_ids: JSON.parse(c.patient_ids || '[]'),
    result: c.result ? JSON.parse(c.result) : null,
    dry_run: Boolean(c.dry_run),
  }));
