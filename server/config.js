// Central config. Reads env only on the server; nothing here is ever sent to the browser
// except via publicConfig(), which deliberately omits secrets.

const env = process.env;

const str = (k, d = '') => (env[k] ?? d).trim();

export const config = {
  apiKey: str('SARVAM_API_KEY'),
  orgId: str('SARVAM_ORG_ID'),
  workspaceId: str('SARVAM_WORKSPACE_ID'),
  appId: str('SARVAM_APP_ID'),
  appVersionRaw: str('SARVAM_APP_VERSION'),
  connectionId: str('SARVAM_CONNECTION_ID'),
  agentPhoneNumber: str('SARVAM_AGENT_PHONE_NUMBER'),
  campaignIdEnv: str('SARVAM_CAMPAIGN_ID'),
  dryRun: str('SARVAM_DRY_RUN', 'true').toLowerCase() !== 'false',
  allowedNumbers: str('ALLOWED_PHONE_NUMBERS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  autoAllowPatients: true, // newly added/existing registered patients are automatically permitted to be dialed
  publicBaseUrl: str('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  webhookSecret: str('WEBHOOK_SECRET'),
  clinicName: str('CLINIC_NAME', 'Premere Clinic'),
  port: Number(str('PORT', '5173')) || 5173,
  syncIntervalSeconds: Math.max(10, Number(str('SYNC_INTERVAL_SECONDS', '30')) || 30),
  costPerMinute: Number(str('SARVAM_COST_PER_MINUTE', '1.80')) || 1.80,
};

config.appVersion = /^\d+$/.test(config.appVersionRaw) ? Number(config.appVersionRaw) : null;

const REQUIRED = {
  SARVAM_API_KEY: config.apiKey,
  SARVAM_ORG_ID: config.orgId,
  SARVAM_WORKSPACE_ID: config.workspaceId,
  SARVAM_APP_ID: config.appId,
  SARVAM_APP_VERSION: config.appVersion,
  SARVAM_CONNECTION_ID: config.connectionId,
  SARVAM_AGENT_PHONE_NUMBER: config.agentPhoneNumber,
};

export function missingConfig() {
  return Object.entries(REQUIRED)
    .filter(([, v]) => v === null || v === '')
    .map(([k]) => k);
}

export function webhookUrl() {
  if (!config.publicBaseUrl) return null;
  const q = config.webhookSecret ? `?token=${encodeURIComponent(config.webhookSecret)}` : '';
  return `${config.publicBaseUrl}/api/webhooks/sarvam${q}`;
}

/** Safe-to-show subset for the UI. Never includes the API key or webhook secret. */
export function publicConfig() {
  return {
    clinicName: config.clinicName,
    dryRun: config.dryRun,
    allowlistActive: !config.autoAllowPatients && config.allowedNumbers.length > 0,
    allowedNumbersMasked: config.allowedNumbers.map(maskPhone),
    autoAllowPatients: config.autoAllowPatients,
    missing: missingConfig(),
    appId: config.appId || null,
    appVersion: config.appVersion,
    agentPhoneNumber: config.agentPhoneNumber || null,
    webhookConfigured: Boolean(config.publicBaseUrl),
    syncIntervalSeconds: config.syncIntervalSeconds,
  };
}

export function maskPhone(p = '') {
  if (p.length < 6) return p;
  return p.slice(0, 3) + '•'.repeat(Math.max(0, p.length - 7)) + p.slice(-4);
}

/** Replace any occurrence of secrets in a string before logging. */
export function redact(text) {
  let out = String(text);
  for (const secret of [config.apiKey, config.webhookSecret]) {
    if (secret) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
