// Server-side Sarvam Voice Agents client. Field names follow docs.sarvam.ai/conversations/api.
// Every request sends X-API-Key. Errors carry the HTTP status + Sarvam's response body.
import { config, redact, webhookUrl } from './config.js';

const BASE = 'https://apps.sarvam.ai/api';
const scheduling = () => `${BASE}/scheduling/v1/orgs/${enc(config.orgId)}/workspaces/${enc(config.workspaceId)}`;
const analytics = () => `${BASE}/analytics/v1/${enc(config.orgId)}/${enc(config.workspaceId)}/${enc(config.appId)}`;
const enc = encodeURIComponent;

export class SarvamError extends Error {
  constructor(status, body, method, url) {
    const hint =
      status === 401 || status === 403 ? ' — check SARVAM_API_KEY / org / workspace'
      : status === 404 ? ' — check the IDs in .env (org, workspace, app, campaign)'
      : status === 422 ? ' — Sarvam rejected the request shape (see body)'
      : '';
    super(`Sarvam ${method} ${new URL(url).pathname} → HTTP ${status}${hint}`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      'X-API-Key': config.apiKey,
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  console.log(`[sarvam] ${method} ${new URL(url).pathname} → ${res.status}`);
  if (!res.ok) {
    const err = new SarvamError(res.status, data, method, url);
    console.error('[sarvam] error body:', redact(JSON.stringify(data)));
    throw err;
  }
  return data;
}

/** Pretty, redacted dump of an outgoing request (used for dry-runs). */
export function describeRequest(method, url, body) {
  return redact(
    [`${method} ${url}`, 'X-API-Key: [REDACTED]', 'Content-Type: application/json', '', JSON.stringify(body, null, 2)].join('\n'),
  );
}

// ── Campaigns ───────────────────────────────────────────────────────────────

export const campaignUrl = (id = '') => `${scheduling()}/campaigns${id ? `/${enc(id)}` : ''}`;

export const getCampaign = (campaignId) => request('GET', campaignUrl(campaignId));
export const listCampaigns = () => request('GET', campaignUrl());

/**
 * Body for POST /scheduling/.../campaigns.
 * Shape follows the docs' request example (connection_configs[].phone_numbers,
 * webhook_config inside app_config). See README "Doc discrepancies".
 */
export function buildCreateCampaignBody({
  name = `${config.clinicName} patient calls`,
  days = 60,
  startTime = '00:00',
  endTime = '23:59',
  allowedDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  maxRetries = 2,
  retryIntervalMinutes = 30,
} = {}) {
  const start = new Date(Date.now() + 5 * 60 * 1000); // must be in the future
  const end = new Date(start.getTime() + days * 24 * 3600 * 1000);
  const hook = webhookUrl();
  return {
    name,
    description: `Outbound patient calls queued by ${config.clinicName} reception`.slice(0, 150),
    app_config: {
      app_id: config.appId,
      app_type: 'agent',
      app_version: config.appVersion,
      attempts_per_second: 0.5,
      connection_configs: [
        { connection_id: config.connectionId, phone_numbers: [config.agentPhoneNumber], weight: 1 },
      ],
      retry_config: {
        max_retries: maxRetries,
        retry_interval_minutes: retryIntervalMinutes,
        retry_on: { busy: { enabled: true }, no_answer: { enabled: true } },
      },
      ...(hook ? { webhook_config: { url: hook, metadata: { source: 'premere-clinic' } } } : {}),
    },
    start_timestamp: start.toISOString(),
    end_timestamp: end.toISOString(),
    allowed_schedule: {
      allowed_start_time: startTime,
      allowed_end_time: endTime,
      allowed_days: allowedDays,
      timezone: 'Asia/Kolkata',
    },
  };
}

export const createCampaign = (body) => request('POST', campaignUrl(), body);

/** action: pause | resume | cancel */
export const updateCampaignStatus = (campaignId, action) =>
  request('PUT', `${campaignUrl(campaignId)}/status`, { action });

// ── Cohorts (Stream cohort = JSON, up to 1000 users) ────────────────────────

export const streamCohortUrl = (campaignId) => `${campaignUrl(campaignId)}/cohorts/stream`;

export function buildStreamCohortBody(name, users) {
  return {
    name: name.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 50),
    users: users.map((u) => ({
      user_phone_number: u.user_phone_number,
      user_identifier: u.user_identifier,
      app_variables: u.app_variables,
      ...(u.language ? { app_overrides: { initial_language_name: u.language } } : {}),
    })),
  };
}

export const streamCohort = (campaignId, body) => request('POST', streamCohortUrl(campaignId), body);

export const getCohort = (campaignId, cohortId) =>
  request('GET', `${campaignUrl(campaignId)}/cohorts/${enc(cohortId)}`);

// ── Analytics ───────────────────────────────────────────────────────────────

/**
 * GET /analytics/v1/{org}/{ws}/{app}/attempts — start/end datetimes are required.
 * filters: [{ field, operator, value }]
 */
export function getAttempts({ start, end, filters = [], limit = 50, offset = 0, sortBy = 'start_datetime', sortOrder = 'desc' }) {
  const q = new URLSearchParams({
    start_datetime: start.toISOString(),
    end_datetime: end.toISOString(),
    limit: String(limit),
    offset: String(offset),
    sort_by: sortBy,
    sort_order: sortOrder,
  });
  if (filters.length) {
    q.set('filter_conditions', JSON.stringify(filters.map((f, i) => ({ id: String(i + 1), ...f }))));
  }
  return request('GET', `${analytics()}/attempts?${q}`);
}

export const getTranscript = (interactionId) =>
  request('GET', `${analytics()}/transcripts/${enc(interactionId)}`);
