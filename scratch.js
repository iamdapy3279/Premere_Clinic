async function request(method, path, body) {
  const res = await fetch(`http://127.0.0.1:5173${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function run() {
  try {
    console.log("Creating campaign...");
    const campaignRes = await request('POST', '/api/campaign', {
      options: {
        name: "Test Campaign",
        startTime: "00:00",
        endTime: "23:59",
        allowedDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        maxRetries: 0,
        retryIntervalMinutes: 5,
        days: 1
      },
      confirm: true
    });
    console.log("Campaign created:", campaignRes.campaign.campaign_id);

    console.log("Creating patient...");
    const patientRes = await request('POST', '/api/patients', {
      name: "Test User",
      phone: "+919874770088",
      call_purpose: "medication_reminder",
      medicine_name: "Metformin",
      dose_instructions: "after breakfast",
      scheduled_dose_time: "09:00 AM",
      prescribing_doctor_name: "Dr. Lalit Agarwal",
      front_desk_number: "033-12345678",
      remaining_doses_today: "None",
      next_medicine_name: "Metformin",
      next_call_time: "09:00 AM tomorrow"
    });
    const patientId = patientRes.patient.id;
    console.log("Patient created:", patientId);

    console.log("Queueing call...");
    const queueRes = await request('POST', '/api/queue', { patientIds: [patientId] });
    console.log("Queue response:", queueRes);

    console.log("Polling for call status (this might take a minute)...");
    let retries = 0;
    while (retries < 60) {
      await new Promise(r => setTimeout(r, 2000));
      // Trigger sync
      await request('POST', '/api/sync');
      
      const pRes = await request('GET', `/api/patients/${patientId}`);
      const status = pRes.patient.call_status;
      const outcome = pRes.patient.call_outcome;
      console.log(`Status: ${status} | Outcome: ${outcome || 'none'}`);
      
      if (['connected', 'failed', 'no_answer', 'busy', 'rejected'].includes(status)) {
        console.log("Call completed!");
        console.log("Final patient state:", JSON.stringify(pRes.patient, null, 2));
        break;
      }
      retries++;
    }
  } catch(e) {
    console.error("Error:", e.message);
  }
}

run();
