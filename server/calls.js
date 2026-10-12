// Business logic: queue patients into the Sarvam campaign, then pull results back
// (polling analytics by default; the webhook feeds the same ingest path).
import { config, missingConfig, redact } from './config.js';
import * as sarvam from './sarvam.js';
import * as store from './db.js';
import { buildInputVariables, readOutputVariables } from './agent-variables.js';

export const USER_ID_PREFIX = 'patient-';
const userIdFor = (patientId) => `${USER_ID_PREFIX}${patientId}`;
const patientIdFrom = (userIdentifier) => {
  const m = /^patient-(\d+)$/.exec(userIdentifier ?? '');
  return m ? Number(m[1]) : null;
};

export class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function activeCampaignId() {
  return store.getSetting('campaign_id') || config.campaignIdEnv || null;
}

/** Normalise Indian numbers to E.164 and validate. Returns null if invalid. */
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '');
  let p = digits;
  if (/^\d{10}$/.test(p)) p = `+91${p}`;
  else if (/^0\d{10}$/.test(p)) p = `+91${p.slice(1)}`;
  else if (/^91\d{10}$/.test(p)) p = `+${p}`;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

function requireReady({ needCampaign = true } = {}) {
  const missing = missingConfig();
  if (missing.length) throw new AppError(400, `Fill these in .env first: ${missing.join(', ')}`);
  const campaignId = activeCampaignId();
  if (needCampaign && !campaignId) {
    throw new AppError(400, 'No campaign configured. Create one on the Campaign tab or set SARVAM_CAMPAIGN_ID.');
  }
  return campaignId;
}

// ── Queue patients ──────────────────────────────────────────────────────────

export async function queuePatients(patientIds, { slotsByPatientId = {}, slot = null, force = false } = {}) {
  const ids = [...new Set((patientIds ?? []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new AppError(400, 'Select at least one patient.');
  if (ids.length > 1000) throw new AppError(400, 'Sarvam accepts at most 1000 patients per batch.');

  // Automatically ensure campaign is active, valid, and using latest agent version
  const campaignId = config.dryRun ? 'DRY_RUN_NO_CAMPAIGN_YET' : await ensureActiveCampaign();

  const skipped = [];
  const users = [];
  const included = [];
  for (const id of ids) {
    const p = store.getPatient(id);
    if (!p) { skipped.push({ id, reason: 'not found' }); continue; }
    const phone = normalizePhone(p.phone);
    if (!phone) { skipped.push({ id, name: p.name, reason: 'invalid phone number' }); continue; }
    if (!config.autoAllowPatients && config.allowedNumbers.length && !config.allowedNumbers.includes(phone)) {
      skipped.push({ id, name: p.name, reason: 'not in ALLOWED_PHONE_NUMBERS' });
      continue;
    }
    if (p.call_status === 'queued') { skipped.push({ id, name: p.name, reason: 'already queued' }); continue; }

    // Rate limiting & spam prevention: 3-minute cooldown per patient unless force is passed
    if (!force && p.queued_at) {
      const queuedAgoSec = (Date.now() - new Date(p.queued_at).getTime()) / 1000;
      if (queuedAgoSec < 180) {
        skipped.push({ id, name: p.name, reason: `Rate limited: patient was already queued ${Math.round(queuedAgoSec)}s ago (3m cooldown)` });
        continue;
      }
    }

    const activeSlot = slotsByPatientId[p.id] || slot || null;
    const lang = p.preferred_language || p.language || 'Hindi';
    users.push({
      user_phone_number: phone,
      user_identifier: userIdFor(p.id),
      app_variables: buildInputVariables(p, config.clinicName, { slot: activeSlot }),
      language: lang,
    });
    included.push(p);
  }
  if (!users.length) throw new AppError(400, 'No patients could be queued.', { skipped });

  const stamp = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Kolkata' }).replace(/[:]/g, '-');
  const body = sarvam.buildStreamCohortBody(`Reception ${stamp}`, users);
  const url = sarvam.streamCohortUrl(campaignId);

  if (config.dryRun) {
    const preview = sarvam.describeRequest('POST', url, body);
    console.log('\n[dry-run] Would send (nothing was sent, no phone rang):\n' + preview + '\n');
    const cohortId = `dryrun-${Date.now()}`;
    store.insertCohort({ cohort_id: cohortId, campaign_id: campaignId, name: body.name, status: 'dry_run', patient_ids: included.map((p) => p.id), dry_run: true });
    for (const p of included) store.patchPatientInternal(p.id, { call_status: 'dry_run', cohort_id: cohortId });
    store.logActivity('dry_run', `Dry run: built a batch of ${users.length} patient(s). Nothing sent to Sarvam.`);
    return { dryRun: true, queued: included.length, skipped, request: preview };
  }

  const res = await sarvam.streamCohort(campaignId, body);
  const queuedAt = new Date().toISOString();
  store.insertCohort({
    cohort_id: res.cohort_id, campaign_id: campaignId, name: res.name ?? body.name,
    status: res.status ?? 'processing', patient_ids: included.map((p) => p.id), result: res.result ?? null,
  });
  for (const p of included) {
    store.patchPatientInternal(p.id, { call_status: 'queued', cohort_id: res.cohort_id, queued_at: queuedAt });
  }
  store.logActivity('queued', `Queued ${included.length} patient(s) into the campaign (cohort ${res.cohort_id}).`);
  return { dryRun: false, queued: included.length, skipped, cohort: res };
}

// ── Ingest an attempt (from polling OR webhook) and update the patient ──────

export function ingestAttempt(a) {
  let patientId = patientIdFrom(a.user_identifier);
  if (!patientId && a.user_phone_number) {
    const match = store.listPatients().find((p) => normalizePhone(p.phone) === a.user_phone_number);
    patientId = match?.id ?? null;
  }
  const before = a.attempt_id ? store.getAttempt(a.attempt_id) : null;
  store.upsertAttempt({ ...a, patient_id: patientId });
  if (!patientId) return null;

  const attempts = store.attemptsForPatient(patientId);
  const latest = attempts[0];
  if (!latest) return patientId;

  const fields = {
    attempts_count: attempts.length,
    last_attempt_id: latest.attempt_id,
    last_interaction_id: latest.interaction_id,
    last_called_at: latest.start_datetime ?? latest.received_at,
    last_duration: latest.duration,
    last_failure_reason: latest.failure_reason,
    call_status: latest.connectivity_status || 'calling',
  };

  // Results come from the most recent attempt that actually has variables.
  const withVars = attempts.find((x) => x.agent_variables && Object.keys(x.agent_variables).length);
  if (withVars) {
    const out = readOutputVariables(withVars.agent_variables);
    Object.assign(fields, out, { extracted_variables: JSON.stringify(withVars.agent_variables) });
  }
  store.patchPatientInternal(patientId, fields);

  const changed = !before || before.connectivity_status !== a.connectivity_status;
  if (changed && a.connectivity_status) {
    const p = store.getPatient(patientId);
    store.logActivity('result', `${p?.name ?? 'Patient'}: ${a.connectivity_status.replace('_', ' ')}${fields.call_outcome ? ` → ${fields.call_outcome}` : ''} (${a.source}).`);
  }
  return patientId;
}

// Analytics item → our attempt shape
function fromAnalytics(item) {
  return {
    attempt_id: item.attempt_id,
    user_identifier: item.user_identifier,
    campaign_id: item.campaign_id,
    cohort_id: item.cohort_id,
    connectivity_status: item.connectivity_status,
    failure_reason: item.failure_reason,
    duration: item.duration_in_seconds,
    interaction_id: item.interaction_id,
    start_datetime: item.start_datetime,
    retry_attempt: item.retry_attempt,
    agent_variables: item.agent_variables,
    user_phone_number: item.user_contact, // Fallback if user_identifier is hashed
    source: 'poll',
    raw: item,
  };
}

// Campaign webhook payload → our attempt shape
export function fromWebhook(p) {
  const vars = p.final_agent_variables || p.output_agent_variables
    ? { ...(p.final_agent_variables ?? {}), ...(p.output_agent_variables ?? {}) }
    : null;
  return {
    attempt_id: p.attempt_id,
    user_identifier: p.user_identifier,
    user_phone_number: p.user_phone_number,
    campaign_id: p.campaign_id,
    cohort_id: p.cohort_id,
    connectivity_status: p.connectivity_status,
    completion_status: p.completion_status,
    next_action_status: p.next_action_status,
    failure_reason: p.failure_reason,
    duration: p.duration,
    interaction_id: p.interaction_id,
    start_datetime: p.start_datetime ?? p.executed_at,
    retry_attempt: p.retry_attempt,
    agent_variables: vars,
    transcript: p.interaction_transcript,
    source: 'webhook',
    raw: p,
  };
}

// ── Polling sync ────────────────────────────────────────────────────────────

export const syncState = { running: false, lastRunAt: null, lastError: null, lastFetched: 0, filterSupported: true };

export async function syncNow() {
  if (syncState.running) return syncState;
  if (config.dryRun || missingConfig().length || !activeCampaignId()) return syncState;
  syncState.running = true;
  syncState.lastError = null;
  try {
    const campaignId = activeCampaignId();

    // 1) Cohort processing status
    for (const c of store.processingCohorts()) {
      const res = await sarvam.getCohort(c.campaign_id, c.cohort_id);
      if (res.status !== c.status) {
        store.updateCohort(c.cohort_id, { status: res.status, result: res.result ?? null });
        const r = res.result;
        store.logActivity('cohort', `Batch ${c.name}: ${res.status}${r ? ` (${r.valid_records}/${r.total_records} valid, ${r.rejected_records} rejected)` : ''}.`);
        if (res.status === 'failed') {
          for (const pid of JSON.parse(c.patient_ids || '[]')) store.patchPatientInternal(pid, { call_status: 'rejected' });
        }
      }
    }

    // 2) Attempts for patients still waiting on a result
    const waiting = store.patientsAwaitingResults();
    if (waiting.length) {
      const start = new Date(new Date(waiting[0].queued_at).getTime() - 10 * 60 * 1000);
      const end = new Date(Date.now() + 10 * 60 * 1000);
      const items = await fetchAttempts(start, end, campaignId);
      syncState.lastFetched = items.length;
      for (const item of items) {
        if (!patientIdFrom(item.user_identifier) && !item.user_contact) continue;
        ingestAttempt(fromAnalytics(item));
      }
    }
  } catch (e) {
    syncState.lastError = redact(e.message);
    console.error('[sync]', syncState.lastError);
  } finally {
    syncState.running = false;
    syncState.lastRunAt = new Date().toISOString();
  }
  return syncState;
}

async function fetchAttempts(start, end, campaignId) {
  const filters = syncState.filterSupported ? [{ field: 'campaign_id', operator: 'equals', value: campaignId }] : [];
  const all = [];
  for (let page = 0, offset = 0; page < 10; page++) {
    let res;
    try {
      res = await sarvam.getAttempts({ start, end, filters, limit: 50, offset });
    } catch (e) {
      // If Sarvam doesn't accept campaign_id as a filter field, fall back to local filtering.
      if (e.status === 422 && filters.length) {
        syncState.filterSupported = false;
        return fetchAttempts(start, end, campaignId);
      }
      throw e;
    }
    const items = res?.items ?? [];
    all.push(...items);
    offset += items.length;
    if (!items.length || offset >= (res.total ?? 0)) break;
  }
  return all;
}

// ── Autonomous Time-Triggered Dispatcher (15-Minute Cadence) ──────────────

export function isGlobalAutoDispatchEnabled() {
  const val = store.getSetting('auto_dispatch_enabled');
  if (val === null) return true; // Enabled by default
  return val === '1' || val === 'true';
}

export function setGlobalAutoDispatchEnabled(enabled) {
  store.setSetting('auto_dispatch_enabled', enabled ? '1' : '0');
  store.logActivity('settings', `Autonomous Calling ${enabled ? 'ENABLED' : 'PAUSED'} by Reception.`);
  return isGlobalAutoDispatchEnabled();
}

export function parseTimeToDecimal(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toUpperCase();
  const ampmMatch = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const isPm = ampmMatch[3] === 'PM';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    return hours + (minutes / 60);
  }
  const h24Match = s.match(/^(\d{1,2}):(\d{2})/);
  if (h24Match) {
    const hours = parseInt(h24Match[1], 10);
    const minutes = parseInt(h24Match[2], 10);
    return hours + (minutes / 60);
  }
  const numMatch = s.match(/^(\d{1,2})$/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }
  return null;
}

export function getKolkataDateTime() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false
  }).formatToParts(now);

  const m = {};
  for (const p of parts) m[p.type] = p.value;

  const dateIST = `${m.year}-${m.month}-${m.day}`;
  const hours = parseInt(m.hour, 10);
  const minutes = parseInt(m.minute, 10);
  const decHours = hours + (minutes / 60);

  // Compute tomorrow in IST (for 1-day prior dialysis reminders)
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tParts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(tomorrow);
  const tm = {};
  for (const p of tParts) tm[p.type] = p.value;
  const tomorrowIST = `${tm.year}-${tm.month}-${tm.day}`;

  return { dateIST, tomorrowIST, decHours, timeFormatted: `${m.hour}:${m.minute}` };
}

export async function runAutonomousDispatch({ force = false } = {}) {
  const enabled = isGlobalAutoDispatchEnabled();
  if (!enabled && !force) {
    return { skipped: true, reason: 'Global auto-dispatch paused' };
  }
  if (!activeCampaignId() && !config.dryRun) {
    return { skipped: true, reason: 'No active campaign' };
  }

  const { dateIST, tomorrowIST, decHours, timeFormatted } = getKolkataDateTime();

  // Daily maintenance: checkpoint WAL and ensure today's compacted backup exists
  try { store.createDailyBackup(); } catch (bErr) { console.warn('[backup-trigger]', bErr.message); }

  // TRAI Calling Hours Safety Clamp (Strictly 08:00 AM - 09:00 PM IST)
  // Prevents automated calls during sleep/night hours to respect patients and avoid DND violations
  if (!force && (decHours < 8.0 || decHours >= 21.0)) {
    return {
      skipped: true,
      reason: `Outside TRAI permissible calling window (08:00 AM - 09:00 PM IST). Current time: ${timeFormatted} IST`,
      time: timeFormatted,
      date: dateIST,
    };
  }

  const allPatients = store.listPatients();
  // Filter only patients who have auto_call_enabled != 0
  const eligiblePatients = allPatients.filter((p) => p.auto_call_enabled !== 0);

  const matched = []; // { patient, slot, reason }

  for (const patient of eligiblePatients) {
    // 1) Morning medicines reminder (if due and not yet dispatched today)
    if (patient.morning_medicines && patient.morning_reminder_time) {
      const mDec = parseTimeToDecimal(patient.morning_reminder_time);
      if (mDec !== null && mDec <= decHours) {
        if (!store.isDispatched(patient.id, 'morning', dateIST)) {
          matched.push({ patient, slot: 'morning', reason: `Morning dose (${patient.morning_reminder_time})` });
        }
      }
    }

    // 2) Evening medicines reminder (if due and not yet dispatched today)
    if (patient.evening_medicines && patient.evening_reminder_time) {
      const eDec = parseTimeToDecimal(patient.evening_reminder_time);
      if (eDec !== null && eDec <= decHours) {
        if (!store.isDispatched(patient.id, 'evening', dateIST)) {
          matched.push({ patient, slot: 'evening', reason: `Evening dose (${patient.evening_reminder_time})` });
        }
      }
    }

    // 3) Dinner medicines reminder (if due and not yet dispatched today)
    if (patient.dinner_medicines && patient.dinner_reminder_time) {
      const dDec = parseTimeToDecimal(patient.dinner_reminder_time);
      if (dDec !== null && dDec <= decHours) {
        if (!store.isDispatched(patient.id, 'dinner', dateIST)) {
          matched.push({ patient, slot: 'dinner', reason: `Dinner dose (${patient.dinner_reminder_time})` });
        }
      }
    }

    // 4) Dialysis session reminder (Dispatched 1 DAY PRIOR to appointment)
    if (patient.dialysis_appointment_date) {
      const apptDate = String(patient.dialysis_appointment_date).trim();
      if (apptDate === tomorrowIST) {
        if (!store.isDispatched(patient.id, 'dialysis', dateIST)) {
          matched.push({
            patient,
            slot: 'dialysis',
            reason: `Dialysis tomorrow ${tomorrowIST} at ${patient.dialysis_appointment_time || '10:00 AM'}`
          });
        }
      }
    }
  }

  if (!matched.length) {
    return { dispatched: 0, time: timeFormatted, date: dateIST };
  }

  // Deduplicate unique patient IDs
  const uniquePatientIds = [...new Set(matched.map((m) => m.patient.id))];

  console.log(`[autonomous-runner] ${timeFormatted} IST: Auto-dispatching ${matched.length} reminder(s) across ${uniquePatientIds.length} patient(s)...`);

  try {
    const slotsByPatientId = {};
    for (const item of matched) {
      slotsByPatientId[item.patient.id] = item.slot;
    }
    const queueRes = await queuePatients(uniquePatientIds, { slotsByPatientId });
    const cohortId = queueRes?.cohort?.cohort_id || (queueRes?.dryRun ? 'dry_run' : null);

    // Record each slot dispatch in SQLite to guarantee zero duplicate calls today
    for (const item of matched) {
      store.recordDispatch(item.patient.id, item.slot, dateIST, cohortId);
    }

    const slotSummary = [...new Set(matched.map((m) => m.slot))].join(', ');
    store.logActivity(
      'autonomous',
      `Auto-Dispatch [${timeFormatted} IST]: Dispatched ${uniquePatientIds.length} patient(s) (${slotSummary}).`
    );

    // Trigger sync immediately to refresh patient states
    syncNow().catch(() => {});

    return {
      dispatched: uniquePatientIds.length,
      slots: matched.length,
      patients: uniquePatientIds,
      time: timeFormatted,
      date: dateIST,
      queueRes
    };
  } catch (err) {
    console.error(`[autonomous-runner] Error during auto-dispatch:`, err.message);
    store.logActivity('autonomous_error', `Auto-dispatch error at ${timeFormatted} IST: ${err.message}`);
    return { error: err.message, time: timeFormatted };
  }
}

let timer = null;
let autoTimer = null;

export function startAutonomousScheduler() {
  if (autoTimer) return;
  // Initial check after 5 seconds on startup
  setTimeout(() => {
    runAutonomousDispatch().catch((err) => console.warn('[autonomous-startup]', err.message));
  }, 5000);

  // Periodic check at fixed 15-minute intervals (15 * 60 * 1000 ms)
  autoTimer = setInterval(() => {
    runAutonomousDispatch().catch((err) => console.warn('[autonomous-interval]', err.message));
  }, 15 * 60 * 1000);
  autoTimer.unref?.();
  console.log(`  Autonomous Dispatcher: active (checks every 15 mins for IST reminders + 1-day prior dialysis)`);
}

export function startSyncLoop() {
  if (timer) return;
  // Proactively ensure healthy campaign on startup
  ensureActiveCampaign().catch((err) => console.warn('[campaign-startup]', err.message));

  timer = setInterval(() => {
    syncNow().catch(() => {});
  }, config.syncIntervalSeconds * 1000);
  timer.unref?.();

  // Run a daily health & auto-renewal check every 6 hours
  setInterval(() => {
    ensureActiveCampaign().catch((err) => console.warn('[campaign-interval]', err.message));
  }, 6 * 3600 * 1000).unref?.();

  // Start the 15-minute autonomous runner
  startAutonomousScheduler();
}

// ── Auto-Rolling Self-Healing Campaign ──────────────────────────────────────

/**
 * Automatically inspects the current agent app version and detects if a higher
 * version has been released in Sarvam.
 */
export async function detectLatestAppVersion() {
  let best = Number(config.appVersion) || 11;
  try {
    const listRes = await sarvam.listCampaigns().catch(() => null);
    if (listRes?.items) {
      for (const item of listRes.items) {
        if (item.app_id === config.appId && typeof item.app_version === 'number') {
          if (item.app_version > best) best = item.app_version;
        }
      }
    }
  } catch (err) {
    console.warn('[version-detection] check error:', err.message);
  }
  return best;
}

/**
 * Self-healing campaign manager:
 * Ensures there is always a valid, active 24/7 campaign running on the latest agent version.
 * If expired, ending within 48h, or running an outdated version, it cancels obsolete campaigns
 * and spins up a brand new 60-day rolling campaign automatically.
 */
export async function ensureActiveCampaign() {
  if (config.dryRun) return 'DRY_RUN_CAMPAIGN';

  const latestVersion = await detectLatestAppVersion();
  if (latestVersion !== config.appVersion) {
    config.appVersion = latestVersion;
    console.log(`[campaign-auto] Synchronized latest agent version: v${latestVersion}`);
  }

  let currentId = store.getSetting('campaign_id') || config.campaignIdEnv || null;
  let currentCampaign = null;

  if (currentId) {
    try {
      currentCampaign = await sarvam.getCampaign(currentId);
    } catch (err) {
      console.warn(`[campaign-auto] Campaign ${currentId} could not be retrieved:`, err.message);
      currentCampaign = null;
    }
  }

  const nowMs = Date.now();
  const endMs = currentCampaign?.end_timestamp ? new Date(currentCampaign.end_timestamp).getTime() : 0;
  const hoursLeft = (endMs - nowMs) / (1000 * 3600);
  const isHealthyStatus = currentCampaign && (currentCampaign.status === 'active' || currentCampaign.status === 'scheduled');
  const isVersionCurrent = currentCampaign && (currentCampaign.app_version === latestVersion);

  // If campaign is active, has > 48 hours remaining, and is on the latest app version, it's healthy!
  if (currentCampaign && isHealthyStatus && hoursLeft > 48 && isVersionCurrent) {
    return currentId;
  }

  console.log(`[campaign-auto] Campaign renewal triggered (Current: ${currentId || 'none'}, Status: ${currentCampaign?.status || 'none'}, Hours left: ${hoursLeft.toFixed(1)}, Campaign Version: ${currentCampaign?.app_version}, Latest Version: ${latestVersion})`);

  // Clean up older active/scheduled campaigns to stay well within Sarvam's 5 concurrent campaign quota
  try {
    const all = await sarvam.listCampaigns().catch(() => null);
    if (all?.items) {
      for (const item of all.items) {
        if (item.campaign_id !== currentId && (item.status === 'active' || item.status === 'scheduled')) {
          console.log(`[campaign-auto] Cancelling older workspace campaign ${item.campaign_id} (version ${item.app_version}) to keep quota free...`);
          await sarvam.updateCampaignStatus(item.campaign_id, 'cancel').catch(() => {});
        }
      }
    }
  } catch (cleanErr) {
    console.warn('[campaign-auto] Quota cleanup warning:', cleanErr.message);
  }

  // Cancel current obsolete campaign if it was active
  if (currentCampaign && (currentCampaign.status === 'active' || currentCampaign.status === 'scheduled')) {
    try {
      await sarvam.updateCampaignStatus(currentId, 'cancel').catch(() => {});
    } catch {}
  }

  // Build brand new 60-day, 24/7 rolling campaign
  const body = sarvam.buildCreateCampaignBody({
    name: `${config.clinicName} Medicine Reminder`,
    days: 60,
    startTime: '00:00',
    endTime: '23:59',
    allowedDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  });
  body.app_config.app_version = latestVersion;

  console.log(`[campaign-auto] Creating new 60-day rolling campaign with Agent Version ${latestVersion}...`);
  const newCamp = await sarvam.createCampaign(body);
  console.log(`[campaign-auto] Successfully launched campaign: ${newCamp.campaign_id} (status: ${newCamp.status})`);

  // Persist into SQLite and memory
  store.setSetting('campaign_id', newCamp.campaign_id);
  config.campaignIdEnv = newCamp.campaign_id;
  store.logActivity('campaign', `Auto-renewed 60-day campaign "${newCamp.name}" (${newCamp.campaign_id}) on Agent v${latestVersion}.`);

  return newCamp.campaign_id;
}

// ── Campaign helpers ────────────────────────────────────────────────────────

export async function campaignOverview() {
  const campaignId = activeCampaignId();
  const out = { campaignId, source: config.campaignIdEnv ? 'env' : campaignId ? 'app' : null, campaign: null, error: null };
  if (!campaignId || missingConfig().length) return out;
  try {
    out.campaign = await sarvam.getCampaign(campaignId);
  } catch (e) {
    out.error = { message: redact(e.message), status: e.status ?? null, body: e.body ?? null };
  }
  return out;
}

export async function createCampaign(opts, { confirm }) {
  requireReady({ needCampaign: false });
  const body = sarvam.buildCreateCampaignBody(opts);
  const preview = sarvam.describeRequest('POST', sarvam.campaignUrl(), body);
  if (!confirm) return { preview: true, request: preview };
  const res = await sarvam.createCampaign(body);
  store.setSetting('campaign_id', res.campaign_id);
  config.campaignIdEnv = res.campaign_id;
  store.logActivity('campaign', `Created campaign "${res.name}" (${res.campaign_id}), status ${res.status}.`);
  return { preview: false, campaign: res };
}

export async function setCampaignStatus(action) {
  const campaignId = requireReady();
  if (!['pause', 'resume', 'cancel'].includes(action)) throw new AppError(400, 'Invalid action.');
  const res = await sarvam.updateCampaignStatus(campaignId, action);
  store.logActivity('campaign', `Campaign ${action}d → ${res.status}.`);
  return res;
}

