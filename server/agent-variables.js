// ─────────────────────────────────────────────────────────────────────────────
// The contract between this app and your Sarvam agent.
// ─────────────────────────────────────────────────────────────────────────────

export const CALL_PURPOSES = {
  medication_reminder: 'Medication reminder',
};

export const LANGUAGES = ['Hindi', 'English', 'Bengali'];

export function getKolkataTomorrow() {
  const now = new Date();
  const kolkataStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const kDate = new Date(kolkataStr);
  const tomorrow = new Date(kDate.getTime() + 24 * 3600 * 1000);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
  const dd = String(tomorrow.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function detectCurrentSlot(patient = {}) {
  const now = new Date();
  const kolkataStr = now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
  const kDate = new Date(kolkataStr);
  const hour = kDate.getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'evening';
  return 'dinner';
}

export function buildInputVariables(patient, clinicName, { slot = null, tomorrowIST = null } = {}) {
  // Determine active slot
  let activeSlot = (slot || detectCurrentSlot(patient)).toLowerCase();
  if (!['morning', 'evening', 'dinner'].includes(activeSlot)) {
    activeSlot = 'morning';
  }

  // Determine slot-specific medicines and reminder time
  let slotMedicines = '';
  let slotTime = '';

  if (activeSlot === 'morning') {
    slotMedicines = String(patient.morning_medicines || '').trim();
    slotTime = String(patient.morning_reminder_time || '09:00 AM').trim();
  } else if (activeSlot === 'evening') {
    slotMedicines = String(patient.evening_medicines || '').trim();
    slotTime = String(patient.evening_reminder_time || '02:30 PM').trim();
  } else if (activeSlot === 'dinner') {
    slotMedicines = String(patient.dinner_medicines || '').trim();
    slotTime = String(patient.dinner_reminder_time || '10:30 PM').trim();
  }

  // Fallback if current slot's medicine list arrives empty
  if (!slotMedicines) {
    slotMedicines = String(
      patient.morning_medicines ||
      patient.evening_medicines ||
      patient.dinner_medicines ||
      patient.medicine_name ||
      'Prescribed daily medicines'
    ).trim();
  }
  if (!slotTime) {
    slotTime = String(patient.scheduled_dose_time || '09:00 AM').trim();
  }

  // Compute ready-made dialysis reminder note (1 day before appointment)
  const apptDate = String(patient.dialysis_appointment_date || '').trim();
  const apptTime = String(patient.dialysis_appointment_time || '10:00 AM').trim();
  const targetTomorrow = tomorrowIST || getKolkataTomorrow();
  const preferredLang = String(patient.preferred_language || patient.language || 'Hindi').trim();

  let dialysisNote = '';
  if (apptDate && apptDate === targetTomorrow) {
    const langLower = preferredLang.toLowerCase();
    if (langLower.includes('bengali') || langLower.includes('bangla')) {
      dialysisNote = `Ar haan, kal apnar dialysis appointment ache shokal ${apptTime} e, shomoymoto clinic e chole ashben.`;
    } else if (langLower.includes('english')) {
      dialysisNote = `Also, a quick reminder that your dialysis session is scheduled for tomorrow at ${apptTime} at the clinic. Please be on time.`;
    } else {
      // Hindi / Hinglish natural speech
      dialysisNote = `Aur haan, kal aapka dialysis appointment ${apptTime} baje scheduled hai clinic mein, toh samay par zaroor pahunch jaiyega.`;
    }
  }

  return {
    // Patient identity
    patient_name: String(patient.name ?? patient.patient_name ?? 'Patient').trim(),
    patient_phone: String(patient.phone ?? patient.patient_phone ?? '').trim(),
    preferred_language: preferredLang,

    // Today's reminder (drives the greeting)
    current_slot_label: activeSlot,
    current_slot_medicines: slotMedicines,
    current_slot_time: slotTime,
    dialysis_reminder_note: dialysisNote,

    // Fallback medicine sets
    morning_medicines: String(patient.morning_medicines || 'Amlodipine 1 tablet, Telmisartan 1 tablet').trim(),
    evening_medicines: String(patient.evening_medicines || 'Furosemide 1 tablet').trim(),
    dinner_medicines: String(patient.dinner_medicines || 'Atorvastatin 2 tablets').trim(),

    // Fallback preferred times
    morning_reminder_time: String(patient.morning_reminder_time || '09:00 AM').trim(),
    evening_reminder_time: String(patient.evening_reminder_time || '02:30 PM').trim(),
    dinner_reminder_time: String(patient.dinner_reminder_time || '10:30 PM').trim(),

    // Dialysis appointment details
    dialysis_appointment_date: apptDate,
    dialysis_appointment_time: apptTime,

    // Contacts
    front_desk_number: String(patient.front_desk_number || '+917965480404').trim(),
    emergency_contact: String(patient.emergency_contact || '').trim(),
  };
}

export const INPUT_VARIABLE_DOCS = [
  ['patient_name', "Patient's name, used in the greeting"],
  ['patient_phone', "Patient's number (e.g. +919874770088)"],
  ['preferred_language', "Hindi, English, or Bengali — which language to start the call in"],
  ['current_slot_label', "Which slot this call is for — morning / evening / dinner"],
  ['current_slot_medicines', "The medicines due in that slot, with dose"],
  ['current_slot_time', "The time to take them (spoken only if the patient asks)"],
  ['dialysis_reminder_note', "A ready-made sentence about tomorrow's dialysis appointment; empty = say nothing about dialysis"],
  ['morning_medicines', "Fallback morning medicine set (used if current slot's list arrives empty)"],
  ['evening_medicines', "Fallback evening medicine set"],
  ['dinner_medicines', "Fallback dinner medicine set"],
  ['morning_reminder_time', "Fallback morning reminder time (e.g. 9:00 AM)"],
  ['evening_reminder_time', "Fallback evening reminder time (e.g. 2:30 PM)"],
  ['dinner_reminder_time', "Fallback dinner reminder time (e.g. 10:30 PM)"],
  ['dialysis_appointment_date', "Dialysis appointment date (e.g. 2026-10-12)"],
  ['dialysis_appointment_time', "Dialysis appointment time (e.g. 10:00 AM)"],
  ['front_desk_number', "The clinic's front desk, shared for any questions or concerns"],
  ['emergency_contact', "Patient's emergency contact; mentioned only during an urgent symptom or emergency, never called by the agent"],
];

export const CALL_OUTCOMES = {
  acknowledged: 'Acknowledged',
  already_taken: 'Already taken',
  declined_or_concern: 'Declined or concern',
  forwarded_to_front_desk: 'Forwarded to front desk',
  wrong_person: 'Wrong person',
  no_answer_voicemail: 'No answer / Voicemail',
  callback_requested: 'Callback requested',
  no_action: 'No action',
};

export const OUTPUT_VARIABLE_DOCS = [
  ['medication_call_disposition', 'How the call ended (e.g. acknowledged, already_taken, declined, no_answer)'],
  ['reminder_call_summary', 'A short call summary'],
  ['dose_slot', 'Which slot this call covered (morning / evening / dinner)'],
];

export function readOutputVariables(vars) {
  if (!vars || typeof vars !== 'object') return null;
  const s = (v) => (v === undefined || v === null ? null : String(v).trim() || null);
  
  return {
    medication_call_disposition: s(vars.medication_call_disposition),
    reminder_call_summary: s(vars.reminder_call_summary),
    dose_slot: s(vars.dose_slot),
  };
}
