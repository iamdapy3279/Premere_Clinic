import { config } from './server/config.js';
import * as sarvam from './server/sarvam.js';
import * as calls from './server/calls.js';
import * as store from './server/db.js';

async function check() {
  try {
    const end = new Date(Date.now() + 10 * 60 * 1000); // add 10 mins to be safe
    const start = new Date(Date.now() - 2 * 3600 * 1000); // 2 hours ago
    const res = await sarvam.getAttempts({ start, end });
    console.log(res.items.length, 'items');
    for (const item of res.items) {
      if (!calls.patientIdFrom(item.user_identifier) && !item.user_contact) {
        console.log('Skipping', item);
        continue;
      }
      const mapped = {
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
        user_phone_number: item.user_contact,
        source: 'poll',
        raw: item,
      };
      console.log('Mapped:', mapped);
      const res = calls.ingestAttempt(mapped);
      console.log('Ingested for patientId:', res);
    }
  } catch (e) {
    console.error(e);
  }
}
check();
