// Premere Clinic — receptionist console server (zero dependencies).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { config, publicConfig, redact, webhookUrl } from './config.js';
import * as store from './db.js';
import * as calls from './calls.js';
import * as sarvam from './sarvam.js';
import {
  CALL_PURPOSES, LANGUAGES, CALL_OUTCOMES, INPUT_VARIABLE_DOCS, OUTPUT_VARIABLE_DOCS,
} from './agent-variables.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

// ── helpers ─────────────────────────────────────────────────────────────────
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new calls.AppError(413, 'Payload too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new calls.AppError(400, 'Invalid JSON body'); }
}

function validatePatient(input, { partial = false } = {}) {
  const out = {};
  const errors = {};
  const s = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
  const has = (k) => input[k] !== undefined;

  if (!partial || has('name')) {
    out.name = s(input.name);
    if (!out.name) errors.name = 'Name is required';
  }
  if (!partial || has('phone')) {
    out.phone = calls.normalizePhone(input.phone);
    if (!out.phone) errors.phone = 'Enter a valid mobile number (10 digits or +91…)';
  }
  if (!partial || has('call_purpose')) {
    out.call_purpose = s(input.call_purpose) || 'medication_reminder';
    if (!CALL_PURPOSES[out.call_purpose]) errors.call_purpose = 'Choose a call purpose';
  }
  if (!partial || has('language') || has('preferred_language')) {
    const lang = s(input.preferred_language || input.language) || 'Hindi';
    out.language = lang;
    out.preferred_language = lang;
    if (!LANGUAGES.includes(out.language)) errors.language = 'Unsupported language (choose Hindi, English, or Bengali)';
  }
  for (const k of [
    'emergency_contact', 'front_desk_number', 'dialysis_bay',
    'morning_medicines', 'evening_medicines', 'dinner_medicines',
    'morning_reminder_time', 'evening_reminder_time', 'dinner_reminder_time',
    'dialysis_appointment_date', 'dialysis_appointment_time',
    'medicine_name', 'dose_instructions', 'scheduled_dose_time', 'prescribing_doctor_name',
    'remaining_doses_today', 'next_medicine_name', 'next_call_time', 'notes',
    'preferred_language', 'dose_slot'
  ]) if (has(k)) out[k] = s(input[k]) || null;

  if (has('auto_call_enabled')) {
    out.auto_call_enabled = input.auto_call_enabled === false || input.auto_call_enabled === 0 || input.auto_call_enabled === '0' ? 0 : 1;
  }

  if (has('appointment_date')) {
    out.appointment_date = s(input.appointment_date) || null;
    if (out.appointment_date && !/^\d{4}-\d{2}-\d{2}$/.test(out.appointment_date)) errors.appointment_date = 'Use YYYY-MM-DD';
  }
  if (has('appointment_time')) {
    out.appointment_time = s(input.appointment_time) || null;
  }
  if (Object.keys(errors).length) throw new calls.AppError(422, 'Please fix the highlighted fields', { errors });
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ── routes ──────────────────────────────────────────────────────────────────
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/config', async () => ({
  ...publicConfig(),
  autoDispatchEnabled: calls.isGlobalAutoDispatchEnabled(),
  campaignId: calls.activeCampaignId(),
  webhookUrl: webhookUrl() ? webhookUrl().replace(/token=[^&]+/, 'token=•••') : null,
  purposes: CALL_PURPOSES,
  languages: LANGUAGES,
  outcomes: CALL_OUTCOMES,
  inputVariables: INPUT_VARIABLE_DOCS,
  outputVariables: OUTPUT_VARIABLE_DOCS,
}));

route('GET', '/api/patients', async () => ({
  patients: store.listPatients(calls.getKolkataDateTime().dateIST)
}));

route('POST', '/api/patients', async ({ body }) => {
  const p = store.createPatient(validatePatient(body));
  store.logActivity('patient', `Added ${p.name}.`);
  return { patient: p };
});

route('GET', '/api/patients/:id', async ({ params }) => {
  const p = store.getPatient(Number(params.id));
  if (!p) throw new calls.AppError(404, 'Patient not found');
  return { patient: p, attempts: store.attemptsForPatient(p.id) };
});

route('PUT', '/api/patients/:id', async ({ params, body }) => {
  const id = Number(params.id);
  if (!store.getPatient(id)) throw new calls.AppError(404, 'Patient not found');
  return { patient: store.updatePatient(id, validatePatient(body, { partial: true })) };
});

route('DELETE', '/api/patients/:id', async ({ params }) => {
  const p = store.getPatient(Number(params.id));
  if (!p) throw new calls.AppError(404, 'Patient not found');
  store.deletePatient(p.id);
  store.logActivity('patient', `Removed ${p.name}.`);
  return { ok: true };
});

route('POST', '/api/patients/:id/reset', async ({ params }) => {
  const p = store.getPatient(Number(params.id));
  if (!p) throw new calls.AppError(404, 'Patient not found');
  store.patchPatientInternal(p.id, { call_status: 'new', cohort_id: null, queued_at: null });
  return { patient: store.getPatient(p.id) };
});

route('GET', '/api/patients/:id/transcript', async ({ params }) => {
  const p = store.getPatient(Number(params.id));
  if (!p) throw new calls.AppError(404, 'Patient not found');
  const fromWebhook = store.attemptsForPatient(p.id).find((a) => a.transcript)?.transcript;
  if (fromWebhook) return { source: 'webhook', transcript: fromWebhook };
  if (!p.last_interaction_id) throw new calls.AppError(404, 'No connected call yet');
  return { source: 'analytics', transcript: await sarvam.getTranscript(p.last_interaction_id) };
});

// Rate limiting: maximum 10 call dispatch requests per 60 seconds across the clinic console
const queueRateLimiter = {
  windowMs: 60 * 1000,
  maxRequests: 10,
  timestamps: [],
  check() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      throw new calls.AppError(429, 'Rate limit exceeded: Too many call requests triggered rapidly. Please wait 60 seconds.');
    }
    this.timestamps.push(now);
  }
};

route('POST', '/api/queue', async ({ body }) => {
  queueRateLimiter.check();
  return calls.queuePatients(body.patientIds, {
    slot: body.slot,
    force: body.force === true,
    cohortName: body.cohortName || null,
  });
});

route('GET', '/api/backups', async () => ({
  backups: store.listBackups(),
}));

route('POST', '/api/backups/create', async () => store.createDailyBackup());

route('POST', '/api/sync', async () => {
  await calls.syncNow();
  return { sync: calls.syncState };
});

route('GET', '/api/status', async () => {
  const { dateIST, timeFormatted } = calls.getKolkataDateTime();
  return {
    sync: calls.syncState,
    cohorts: store.recentCohorts(),
    activity: store.recentActivity(),
    dispatchesToday: store.recentScheduledDispatches(dateIST, 100),
    currentTimeIST: timeFormatted,
    currentDateIST: dateIST,
    autoDispatchEnabled: calls.isGlobalAutoDispatchEnabled(),
  };
});

route('GET', '/api/attempts', async () => ({
  attempts: store.listRecentAttempts(100),
  ratePerMinute: config.costPerMinute || 1.80,
  currency: 'INR'
}));

route('GET', '/api/campaign', async () => calls.campaignOverview());
route('POST', '/api/campaign', async ({ body }) => calls.createCampaign(body.options ?? {}, { confirm: body.confirm === true }));
route('POST', '/api/campaign/status', async ({ body }) => calls.setCampaignStatus(body.action));
route('POST', '/api/campaign/dispatch-column', async ({ body }) => {
  return calls.dispatchColumnCampaign({
    column: body.column,
    patientIds: body.patientIds,
    createCampaign: body.createCampaign === true,
    force: body.force !== false,
  });
});

// Autonomous Runner & Toggles
route('POST', '/api/settings/auto-dispatch', async ({ body }) => ({
  autoDispatchEnabled: calls.setGlobalAutoDispatchEnabled(body.enabled === true)
}));

route('POST', '/api/autonomous/run', async () => calls.runAutonomousDispatch({ force: true }));

route('POST', '/api/patients/:id/toggle-auto-call', async ({ params }) => {
  const p = store.getPatient(Number(params.id));
  if (!p) throw new calls.AppError(404, 'Patient not found');
  const nextVal = p.auto_call_enabled === 0 ? 1 : 0;
  const updated = store.updatePatient(p.id, { auto_call_enabled: nextVal });
  store.logActivity('patient', `${nextVal ? 'Enabled' : 'Paused'} automated calls for ${p.name}.`);
  return { patient: updated };
});

// Optional: Sarvam campaign webhook. Needs a public tunnel to reach localhost.
route('POST', '/api/webhooks/sarvam', async ({ body, url, res }) => {
  if (config.webhookSecret && !safeEqual(url.searchParams.get('token') ?? '', config.webhookSecret)) {
    throw new calls.AppError(401, 'Bad webhook token');
  }
  send(res, 200, { ok: true }); // acknowledge immediately
  try {
    if (body?.attempt_id) calls.ingestAttempt(calls.fromWebhook(body));
    console.log(`[webhook] attempt ${body?.attempt_id ?? '?'} → ${body?.connectivity_status ?? '?'}`);
  } catch (e) {
    console.error('[webhook] ingest failed:', redact(e.message));
  }
  return undefined; // already responded
});

// ── server ──────────────────────────────────────────────────────────────────
async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) file = join(PUBLIC_DIR, 'index.html');
  try {
    const data = await readFile(file.endsWith('/') || !extname(file) ? join(PUBLIC_DIR, 'index.html') : file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, must-revalidate'
    });
    res.end(data);
  } catch {
    const data = await readFile(join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Cache-Control': 'no-cache, must-revalidate'
    });
    res.end(data);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJson(req) : {};
      const data = await r.handler({ req, res, url, params, body });
      if (data !== undefined && !res.headersSent) send(res, 200, data);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof sarvam.SarvamError) {
        return send(res, 502, { error: redact(e.message), sarvamStatus: e.status, sarvamBody: e.body });
      }
      if (e instanceof calls.AppError) return send(res, e.status, { error: e.message, ...e.details });
      console.error(redact(e.stack ?? e.message));
      return send(res, 500, { error: redact(e.message) });
    }
    return;
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(config.port, '127.0.0.1', () => {
  const pc = publicConfig();
  console.log(`\n  ${config.clinicName} → http://localhost:${config.port}`);
  console.log(`  Mode: ${pc.dryRun ? 'DRY RUN (no calls are placed)' : 'LIVE (queuing places real calls)'}`);
  if (pc.allowlistActive) console.log(`  Allowlist: ${pc.allowedNumbersMasked.join(', ')}`);
  if (pc.missing.length) console.log(`  Missing in .env: ${pc.missing.join(', ')}`);
  console.log(`  Results sync: every ${config.syncIntervalSeconds}s${pc.webhookConfigured ? ' + webhook' : ''}\n`);
  calls.startSyncLoop();
});

// Process crash guards & graceful shutdown
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', redact(err?.stack || err?.message || err));
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', redact(reason?.stack || reason));
});

const gracefulShutdown = () => {
  console.log('\n[server] Shutting down gracefully... Flushing SQLite WAL.');
  store.checkpointWAL();
  process.exit(0);
};
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
