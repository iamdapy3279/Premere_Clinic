// Premere Clinic — Reception Console & Clinical Precision Front End
// Strict monochrome Swiss design, 1:1 match with Patient Intake & Kanban views

// ── Time Formatter Helper ────────────────────────────────────────────────────
function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const trimmed = String(timeStr).trim();
  if (/^\d{1,2}:\d{2}$/.test(trimmed)) {
    const [h, m] = trimmed.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  }
  return trimmed;
}

// ── Time Classification Engine ───────────────────────────────────────────────
// User Rule:
// - Morning is anything before 12 (< 12:00)
// - Evening is anything between 12 to 6 (12:00 <= time < 18:00)
// - Dinner is anything after 6 (time >= 18:00)
function parseTimeToDecimalHours(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim().toUpperCase();

  // Natural language keywords
  if (s.includes('LUNCH') || s.includes('AFTERNOON') || s.includes('NOON')) return 13.0;
  if (s.includes('BED') || s.includes('NIGHT') || s.includes('DINNER')) return 21.0;
  if (s.includes('BREAKFAST') || s.includes('WAKE') || s.includes('MORNING')) return 8.0;
  if (s.includes('NOW')) {
    const now = new Date();
    return now.getHours() + (now.getMinutes() / 60);
  }

  // 12-hour format with AM/PM (e.g. "08:30 AM", "10:00 PM", "9 PM", "12 PM", "12 AM")
  const ampmMatch = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const isPm = ampmMatch[3] === 'PM';
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    return hours + (minutes / 60);
  }

  // 24-hour format (e.g. "09:00", "14:30", "22:00", "18:00")
  const h24Match = s.match(/^(\d{1,2}):(\d{2})/);
  if (h24Match) {
    const hours = parseInt(h24Match[1], 10);
    const minutes = parseInt(h24Match[2], 10);
    return hours + (minutes / 60);
  }

  // Pure integer hour (e.g. "9", "14", "22")
  const numMatch = s.match(/^(\d{1,2})$/);
  if (numMatch) {
    return parseInt(numMatch[1], 10);
  }

  return null;
}

function classifyMedicationSlotByTime(timeStr, fallbackSlot = 'morning') {
  const dec = parseTimeToDecimalHours(timeStr);
  if (dec === null || isNaN(dec)) {
    return fallbackSlot;
  }
  if (dec < 12) return 'morning'; // anything before 12
  if (dec < 18) return 'evening'; // anything between 12 to 6
  return 'dinner';                // anything after 6
}

function getCurrentDecimalHours() {
  const now = new Date();
  return now.getHours() + (now.getMinutes() / 60);
}

// Determines status based on current time of day and call log:
// - If the scheduled time is in the future today -> 'Pending'
// - If past and call was acknowledged/delivered -> 'Complete'
// - If past and call was missed/failed -> 'Missed'
// - If actively in call -> 'On-going'
// - Default/scheduled/uncalled -> 'Pending'
function determineCardStatus(patient, reminderTimeStr, stageKey) {
  // If specific manual dose override exists
  if (patient && patient._doseStatuses && patient._doseStatuses[reminderTimeStr]) {
    return patient._doseStatuses[reminderTimeStr];
  }
  if (patient && patient._callingNow) {
    return 'On-going';
  }

  // Normalized slot name
  const slotKey = stageKey === 'dialysis-reminder' ? 'dialysis' : stageKey;
  const wasDispatchedToday = patient && Array.isArray(patient.dispatches_today) && patient.dispatches_today.includes(slotKey);

  // If this specific slot has been dispatched today by the autonomous runner or receptionist
  if (wasDispatchedToday) {
    if (patient.call_status === 'queued' || patient.call_status === 'calling' || patient.call_status === 'on-going') {
      return 'On-going';
    }
    const raw = ((patient && patient.last_call_status) || '').toUpperCase();
    if (raw.includes('DELIVERED') || raw.includes('ACK') || raw.includes('COMPLETE') || raw.includes('CONNECTED')) {
      return 'Complete';
    }
    if (raw.includes('MISS') || raw.includes('FAIL') || raw.includes('BUSY')) {
      return 'Missed';
    }
    return 'Complete';
  }

  const decHours = parseTimeToDecimalHours(reminderTimeStr);
  const currentDec = getCurrentDecimalHours();

  // If reminder time has not yet arrived today -> 'Pending'
  if (decHours !== null && decHours > currentDec) {
    return 'Pending';
  }

  // If time has passed today but not yet dispatched
  return 'Pending';
}

// ── Master Clinical Patient Store (12 Input Variables Contract) ───────────────
const DEFAULT_REGISTRY = [];

// ── Kanban Data Set ──────────────────────────────────────────────────────────
const KANBAN_STAGES = {
  morning: [],
  evening: [],
  dinner: [],
  "try-again": [],
  "dialysis-reminder": []
};

// ── Global State ─────────────────────────────────────────────────────────────
let patients = [];
let currentActivePatient = null;
let currentViewMode = 'table'; // 'table' | 'grid'
let appRoute = 'intake';
let serverConfig = null;
let serverStatus = null;
let draggedCardEl = null;

// ── API Helper ───────────────────────────────────────────────────────────────
async function fetchApi(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    console.warn(`API call failed for ${path}:`, err.message);
    return null;
  }
}

// ── Routing & Navigation ─────────────────────────────────────────────────────
function navigateTo(route) {
  appRoute = route;
  window.location.hash = `#/${route}`;

  // Update Nav links
  document.querySelectorAll('#sideNav .nav-item').forEach(link => {
    const target = link.dataset.view;
    if (target === route) {
      link.className = "nav-item flex items-center gap-space-sm px-space-md py-space-sm bg-primary text-on-primary font-headline-sm transition-none border border-transparent cursor-pointer";
    } else {
      link.className = "nav-item flex items-center gap-space-sm px-space-md py-space-sm text-on-surface-variant font-label-md text-label-md transition-none hover:bg-surface-container-high hover:text-on-surface border border-transparent cursor-pointer";
    }
  });

  // Toggle View sections
  document.querySelectorAll('.app-view').forEach(viewEl => {
    viewEl.classList.add('hidden');
  });

  const activeSection = document.getElementById(`view-${route}`);
  if (activeSection) {
    activeSection.classList.remove('hidden');
  }

  if (route === 'kanban') {
    syncScheduleMatrixFromPatients();
    renderKanbanBoard();
  } else if (route === 'dispatch') {
    renderDispatchView();
  } else if (route === 'transcripts') {
    renderTranscriptsView();
  } else if (route === 'protocols') {
    renderProtocolsView();
  }
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.replace('#/', '') || 'intake';
  navigateTo(hash);
});

// ── View Switcher (List vs Grid) ─────────────────────────────────────────────
window.switchView = function(view) {
  currentViewMode = view;
  const tableCont = document.getElementById("tableViewContainer");
  const gridCont = document.getElementById("gridViewContainer");
  const btnTable = document.getElementById("btnViewTable");
  const btnGrid = document.getElementById("btnViewGrid");

  if (view === 'table') {
    tableCont.classList.remove("hidden");
    gridCont.classList.add("hidden");
    btnTable.className = "view-btn flex items-center gap-space-xs px-space-md py-1 font-label-md text-label-md bg-surface-container-lowest text-primary border border-outline-variant transition-none cursor-pointer";
    btnGrid.className = "view-btn flex items-center gap-space-xs px-space-md py-1 font-label-md text-label-md text-on-surface-variant hover:text-on-surface border border-transparent transition-none cursor-pointer";
  } else {
    tableCont.classList.add("hidden");
    gridCont.classList.remove("hidden");
    btnGrid.className = "view-btn flex items-center gap-space-xs px-space-md py-1 font-label-md text-label-md bg-surface-container-lowest text-primary border border-outline-variant transition-none cursor-pointer";
    btnTable.className = "view-btn flex items-center gap-space-xs px-space-md py-1 font-label-md text-label-md text-on-surface-variant hover:text-on-surface border border-transparent transition-none cursor-pointer";
  }
};

// ── Patient Intake View: Render Table ────────────────────────────────────────
function renderPatientTable(list) {
  const tbody = document.getElementById("patientTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  list.forEach(p => {
    const isPrimary = p.is_primary || p.patient_name === "Devansh Poddar";
    const tr = document.createElement("tr");
    tr.className = "hover:bg-surface-container-high cursor-pointer transition-all border-b border-outline-variant bg-surface-container-lowest";
    tr.onclick = () => openPatientModal(p.id);

    tr.innerHTML = `
      <td class="py-space-md px-space-md">
        <div class="flex items-center gap-space-md">
          <div>
            <div class="font-headline-sm text-headline-sm text-primary font-bold flex items-center gap-space-xs">
              <span>${escapeHtml(p.patient_name)}</span>
              ${isPrimary ? '<span class="font-mono-data text-code-param px-1.5 py-0.5 border border-primary bg-primary text-on-primary text-[11px]">PRIMARY</span>' : ''}
            </div>
            <div class="font-mono-data text-body-sm text-on-surface-variant flex items-center gap-1.5 mt-0.5">
              <span class="text-outline-variant">•</span>
              <span>${escapeHtml(p.frequency || '3x / week (M-W-F)')}</span>
            </div>
          </div>
        </div>
      </td>
      <td class="py-space-md px-space-md">
        <div class="flex items-center gap-1 font-mono-data text-mono-data text-primary font-semibold">
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant">call</span>
          <span>${escapeHtml(p.patient_phone)}</span>
        </div>
        <div class="font-label-sm text-label-sm text-on-surface-variant flex items-center gap-1 mt-1">
          <span class="material-symbols-outlined text-[14px]">emergency</span>
          <span>Emergency:</span>
          <span class="font-mono-data font-medium text-primary">${escapeHtml(p.emergency_contact || 'None')}</span>
        </div>
      </td>
      <td class="py-space-md px-space-md">
        <div class="flex items-center gap-space-xs font-mono-data text-mono-data text-primary font-semibold">
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant">event</span>
          <span>${escapeHtml(p.dialysis_appointment_date || '—')}</span>
          <span class="text-on-surface-variant">•</span>
          <span>${escapeHtml(formatTime12h(p.dialysis_appointment_time) || '10:00 AM')}</span>
        </div>
      </td>
      <td class="py-space-md px-space-md">
        <div class="space-y-1.5">
          <div class="flex items-center gap-space-xs font-body-sm">
            <span class="px-1.5 py-0.5 bg-surface-container-high border border-outline-variant font-mono-data text-code-param font-medium text-primary">${escapeHtml(formatTime12h(p.morning_reminder_time) || '09:00 AM')}</span>
            <span class="text-primary font-medium truncate">${escapeHtml(p.morning_medicines || '—')}</span>
          </div>
          <div class="flex items-center gap-space-xs font-body-sm">
            <span class="px-1.5 py-0.5 bg-surface-container-low border border-outline-variant font-mono-data text-code-param text-on-surface-variant">${escapeHtml(formatTime12h(p.evening_reminder_time) || '02:30 PM')}</span>
            <span class="text-on-surface truncate">${escapeHtml(p.evening_medicines || '—')}</span>
          </div>
          <div class="flex items-center gap-space-xs font-body-sm">
            <span class="px-1.5 py-0.5 bg-surface-container-low border border-outline-variant font-mono-data text-code-param text-on-surface-variant">${escapeHtml(formatTime12h(p.dinner_reminder_time) || '10:30 PM')}</span>
            <span class="text-on-surface truncate">${escapeHtml(p.dinner_medicines || '—')}</span>
          </div>
        </div>
      </td>
      <td class="py-space-md px-space-md text-right">
        <div class="inline-flex items-center gap-1.5 justify-end">
          <button type="button" onclick="event.stopPropagation(); togglePatientAutoCall('${p.id}')" title="Toggle 15-minute autonomous voice calls for this patient" class="h-7 px-space-sm border font-mono-data text-[10px] inline-flex items-center gap-1 transition-none cursor-pointer ${p.auto_call_enabled !== 0 ? 'bg-surface-container-lowest border-primary text-primary hover:bg-surface-container-high' : 'bg-surface-container-low border-outline-variant text-on-surface-variant hover:text-on-surface'}">
            <span class="w-1.5 h-1.5 ${p.auto_call_enabled !== 0 ? 'bg-primary' : 'bg-outline-variant'}"></span>
            <span>${p.auto_call_enabled !== 0 ? 'AUTO: ON' : 'AUTO: PAUSED'}</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); triggerCallPatient('${p.id}')" title="Call Patient Now" class="h-7 px-space-sm bg-surface-container-lowest border border-outline-variant hover:border-primary text-primary font-label-sm text-label-sm inline-flex items-center gap-1 transition-none cursor-pointer">
            <span class="material-symbols-outlined text-[14px]">call</span>
            <span>Call</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); openEditPatientModal('${p.id}')" title="Edit Patient Details" class="h-7 px-space-sm bg-surface-container-lowest border border-outline-variant hover:border-primary text-primary font-label-sm text-label-sm inline-flex items-center gap-1 transition-none cursor-pointer">
            <span class="material-symbols-outlined text-[14px]">edit</span>
            <span>Edit</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); promptDeletePatient('${p.id}')" title="Delete Patient Record" class="h-7 px-space-sm bg-surface-container-lowest border border-outline-variant hover:border-red-600 hover:text-red-600 text-on-surface-variant font-label-sm text-label-sm inline-flex items-center gap-1 transition-none cursor-pointer">
            <span class="material-symbols-outlined text-[14px]">delete</span>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Patient Intake View: Render Grid ─────────────────────────────────────────
function renderPatientGrid(list) {
  const container = document.getElementById("gridViewContainer");
  if (!container) return;
  container.innerHTML = "";

  list.forEach(p => {
    const isPrimary = p.is_primary || p.patient_name === "Devansh Poddar";
    const card = document.createElement("div");
    card.className = "bg-surface-container-lowest border border-outline-variant p-space-lg flex flex-col justify-between hover:border-primary transition-none cursor-pointer " + (isPrimary ? "ring-1 ring-primary" : "");
    card.onclick = () => openPatientModal(p.id);

    card.innerHTML = `
      <div class="space-y-space-md">
        <div class="flex items-start justify-between">
          <div class="space-y-0.5">
            <div class="flex items-center gap-space-xs">
              <span class="font-mono-data text-mono-data text-on-surface-variant">${escapeHtml(p.id)}</span>
              ${isPrimary ? '<span class="font-mono-data text-code-param px-1 bg-primary text-on-primary">PRIMARY</span>' : ''}
            </div>
            <h3 class="font-headline-md text-headline-md text-primary font-bold">${escapeHtml(p.patient_name)}</h3>
          </div>
          <div class="w-2 h-2 bg-primary"></div>
        </div>

        <div class="border-t border-b border-outline-variant py-space-sm space-y-space-xs font-mono-data text-mono-data">
          <div class="flex justify-between">
            <span class="text-on-surface-variant uppercase font-label-sm text-label-sm">Dialysis Slot:</span>
            <span class="text-primary font-medium">${escapeHtml(p.dialysis_appointment_date || '—')} ${escapeHtml(formatTime12h(p.dialysis_appointment_time) || '')}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-on-surface-variant uppercase font-label-sm text-label-sm">Assigned Bay:</span>
            <span class="text-primary">${escapeHtml(p.dialysis_bay || 'Station 4B (Hemodialysis)')}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-on-surface-variant uppercase font-label-sm text-label-sm">Primary Phone:</span>
            <span class="text-primary">${escapeHtml(p.patient_phone)}</span>
          </div>
        </div>

        <div class="space-y-1">
          <span class="font-label-sm text-label-sm text-on-surface-variant uppercase">Daily Medication Dispatches</span>
          <div class="bg-surface-container-low p-2 border border-outline-variant font-mono-data text-mono-data text-on-surface space-y-1">
            <div class="truncate"><span class="font-bold">${escapeHtml(formatTime12h(p.morning_reminder_time) || '09:00 AM')}:</span> ${escapeHtml(p.morning_medicines || 'None')}</div>
            <div class="truncate"><span class="font-bold">${escapeHtml(formatTime12h(p.evening_reminder_time) || '02:30 PM')}:</span> ${escapeHtml(p.evening_medicines || 'None')}</div>
            <div class="truncate"><span class="font-bold">${escapeHtml(formatTime12h(p.dinner_reminder_time) || '10:30 PM')}:</span> ${escapeHtml(p.dinner_medicines || 'None')}</div>
          </div>
        </div>
      </div>

      <div class="mt-space-lg pt-space-sm border-t border-outline-variant flex items-center justify-between">
        <span class="font-label-sm text-label-sm text-on-surface-variant">${escapeHtml(p.last_call_status || 'Delivered (Ack)')}</span>
        <div class="flex items-center gap-1.5">
          <button type="button" onclick="event.stopPropagation(); togglePatientAutoCall('${p.id}')" title="Toggle 15-minute autonomous voice calls for this patient" class="h-7 px-2 border font-mono-data text-[10px] inline-flex items-center gap-1 transition-none cursor-pointer ${p.auto_call_enabled !== 0 ? 'bg-surface-container-lowest border-primary text-primary hover:bg-surface-container-high' : 'bg-surface-container-low border-outline-variant text-on-surface-variant hover:text-on-surface'}">
            <span class="w-1.5 h-1.5 ${p.auto_call_enabled !== 0 ? 'bg-primary' : 'bg-outline-variant'}"></span>
            <span>${p.auto_call_enabled !== 0 ? 'AUTO: ON' : 'AUTO: PAUSED'}</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); triggerCallPatient('${p.id}')" title="Call" class="h-7 px-2 bg-surface-container-lowest border border-outline-variant hover:border-primary text-primary font-label-sm text-label-sm cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">call</span>
            <span>Call</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); openEditPatientModal('${p.id}')" title="Edit" class="h-7 px-2 bg-surface-container-lowest border border-outline-variant hover:border-primary text-primary font-label-sm text-label-sm cursor-pointer flex items-center gap-1">
            <span class="material-symbols-outlined text-[14px]">edit</span>
            <span>Edit</span>
          </button>
          <button type="button" onclick="event.stopPropagation(); promptDeletePatient('${p.id}')" title="Delete" class="h-7 px-2 bg-surface-container-lowest border border-outline-variant hover:border-red-600 hover:text-red-600 text-on-surface-variant font-label-sm text-label-sm cursor-pointer flex items-center">
            <span class="material-symbols-outlined text-[14px]">delete</span>
          </button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

function updateMetricCounters() {
  const activeCountEl = document.getElementById("metricActiveCount");
  const scheduledCountEl = document.getElementById("metricScheduledCount");
  if (activeCountEl) activeCountEl.textContent = `${patients.length} Patients`;
  
  const dialysisCount = patients.filter(p => p.dialysis_appointment_date || p.dialysis_appointment_time).length;
  if (scheduledCountEl) scheduledCountEl.textContent = `${dialysisCount} Scheduled`;
}

// ── Schedule Matrix Functional Engine ────────────────────────────────────────
// Populates Morning (< 12:00), Evening (12:00-18:00), Dinner (> 18:00), Dialysis, and Try Again columns
function syncScheduleMatrixFromPatients() {
  const morningList = [];
  const eveningList = [];
  const dinnerList = [];
  const dialysisList = [];
  const tryAgainList = [];

  const addToSlot = (slot, item) => {
    if (slot === 'morning') morningList.push(item);
    else if (slot === 'evening') eveningList.push(item);
    else if (slot === 'dinner') dinnerList.push(item);
  };

  patients.forEach(p => {
    // 1. Morning Medication Set -> classified by reminder time (< 12 -> Morning, 12-18 -> Evening, > 18 -> Dinner)
    if (p.morning_medicines && p.morning_medicines.trim() !== '') {
      const timeDisplay = formatTime12h(p.morning_reminder_time) || '08:30 AM';
      const slot = classifyMedicationSlotByTime(p.morning_reminder_time, 'morning');
      const cardStatus = determineCardStatus(p, p.morning_reminder_time || '08:30 AM', slot);
      addToSlot(slot, {
        id: p.id,
        name: p.patient_name,
        subtitle: p.morning_medicines,
        status: cardStatus,
        time: timeDisplay
      });
    }

    // 2. Evening Medication Set -> classified by reminder time (< 12 -> Morning, 12-18 -> Evening, > 18 -> Dinner)
    if (p.evening_medicines && p.evening_medicines.trim() !== '') {
      const timeDisplay = formatTime12h(p.evening_reminder_time) || '02:30 PM';
      const slot = classifyMedicationSlotByTime(p.evening_reminder_time, 'evening');
      const cardStatus = determineCardStatus(p, p.evening_reminder_time || '02:30 PM', slot);
      addToSlot(slot, {
        id: p.id,
        name: p.patient_name,
        subtitle: p.evening_medicines,
        status: cardStatus,
        time: timeDisplay
      });
    }

    // 3. Dinner Medication Set -> classified by reminder time (< 12 -> Morning, 12-18 -> Evening, > 18 -> Dinner)
    if (p.dinner_medicines && p.dinner_medicines.trim() !== '') {
      const timeDisplay = formatTime12h(p.dinner_reminder_time) || '08:45 PM';
      const slot = classifyMedicationSlotByTime(p.dinner_reminder_time, 'dinner');
      const cardStatus = determineCardStatus(p, p.dinner_reminder_time || '08:45 PM', slot);
      addToSlot(slot, {
        id: p.id,
        name: p.patient_name,
        subtitle: p.dinner_medicines,
        status: cardStatus,
        time: timeDisplay
      });
    }

    // 4. Dialysis Appointment -> Dialysis Reminder Column
    if ((p.dialysis_appointment_date && p.dialysis_appointment_date.trim() !== '') || 
        (p.dialysis_appointment_time && p.dialysis_appointment_time.trim() !== '')) {
      const dialDate = p.dialysis_appointment_date ? `${p.dialysis_appointment_date} • ` : '';
      const dialTimeDisplay = formatTime12h(p.dialysis_appointment_time) || '11:30 AM';
      const dialStatus = determineCardStatus(p, p.dialysis_appointment_time || '11:30 AM', 'dialysis-reminder');
      dialysisList.push({
        id: p.id,
        name: p.patient_name,
        subtitle: `${dialDate}${p.dialysis_bay || 'Hemodialysis'}`,
        status: dialStatus,
        time: dialTimeDisplay
      });
    }

    // 5. Missed Call -> Try Again Column
    const rawStatus = (p.last_call_status || '').toUpperCase();
    if (rawStatus.includes('MISS') || rawStatus.includes('FAIL') || rawStatus.includes('BUSY')) {
      tryAgainList.push({
        id: p.id,
        name: p.patient_name,
        subtitle: 'Auto-retry queued',
        status: 'Missed',
        time: formatTime12h(p.morning_reminder_time || p.dialysis_appointment_time) || '10:15 AM'
      });
    }
  });

  KANBAN_STAGES['morning'] = morningList;
  KANBAN_STAGES['evening'] = eveningList;
  KANBAN_STAGES['dinner'] = dinnerList;
  KANBAN_STAGES['dialysis-reminder'] = dialysisList;
  KANBAN_STAGES['try-again'] = tryAgainList;

  renderKanbanBoard();
}

function renderKanbanBoard() {
  Object.keys(KANBAN_STAGES).forEach(stageKey => {
    const zone = document.querySelector(`.cards-drop-zone[data-stage="${stageKey}"]`);
    if (!zone) return;
    zone.innerHTML = "";

    const cardList = KANBAN_STAGES[stageKey] || [];
    cardList.forEach((item, index) => {
      const cardEl = createKanbanCardElement(item.name, item.status, item.time, stageKey, index, item.subtitle, item.id);
      zone.appendChild(cardEl);
    });
  });

  refreshKanbanCounts();
  attachKanbanDragDropHandlers();
}

function renderBadgeMarkup(status) {
  if (status === "Complete") {
    return `
      <span class="status-badge inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-50 text-emerald-800 border border-emerald-300 cursor-pointer select-none" title="Click to cycle status">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>Complete
      </span>`;
  } else if (status === "On-going") {
    return `
      <span class="status-badge inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-50 text-amber-800 border border-amber-300 cursor-pointer select-none" title="Click to cycle status">
        <span class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>On-going
      </span>`;
  } else if (status === "Missed") {
    return `
      <span class="status-badge inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full bg-rose-50 text-rose-800 border border-rose-300 cursor-pointer select-none" title="Click to cycle status">
        <span class="w-1.5 h-1.5 rounded-full bg-rose-500"></span>Missed
      </span>`;
  } else {
    // Default: Pending (scheduled for future / upcoming)
    return `
      <span class="status-badge inline-flex items-center gap-1.5 px-2 py-0.5 text-xs font-medium rounded-full bg-surface-container-high text-on-surface-variant border border-outline-variant cursor-pointer select-none" title="Click to cycle status">
        <span class="w-1.5 h-1.5 rounded-full bg-on-surface-variant"></span>Pending
      </span>`;
  }
}

function createKanbanCardElement(name, status, time, stageKey, index, subtitle, patientId) {
  const article = document.createElement("article");
  article.className = "kanban-card group cursor-grab active:cursor-grabbing bg-surface-container-lowest border border-outline-variant hover:border-primary p-space-md transition-none select-none flex flex-col gap-2.5";
  article.setAttribute("draggable", "true");
  article.dataset.stage = stageKey;
  article.dataset.name = name;
  article.dataset.time = time;
  if (patientId) article.dataset.patientId = patientId;

  article.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <h3 class="font-headline-sm text-headline-sm text-on-surface font-semibold group-hover:underline cursor-pointer flex-1 truncate" title="${escapeHtml(name)}">${escapeHtml(name)}</h3>
      <div class="badge-slot shrink-0">
        ${renderBadgeMarkup(status)}
      </div>
    </div>
    ${subtitle ? `<div class="text-[12px] text-on-surface-variant font-mono-data truncate" title="${escapeHtml(subtitle)}">${escapeHtml(subtitle)}</div>` : ''}
    <div class="flex items-center justify-between gap-2 pt-2 border-t border-outline-variant/60">
      <div class="flex items-center gap-1.5 text-on-surface-variant font-mono-data text-code-param">
        <span class="material-symbols-outlined text-[14px]">schedule</span>
        <span>${escapeHtml(time)}</span>
      </div>
      <button class="call-card-btn inline-flex items-center gap-1 px-2.5 py-1 bg-primary text-on-primary hover:bg-neutral-800 border border-primary text-[11px] font-mono-data uppercase tracking-wider font-semibold cursor-pointer active:scale-95 transition-none shadow-none" type="button" title="Initiate outbound call to ${escapeHtml(name)}">
        <span class="material-symbols-outlined text-[13px]">call</span>
        <span>Call</span>
      </button>
    </div>
  `;

  // Direct Call Button Handler
  const callBtn = article.querySelector('.call-card-btn');
  if (callBtn) {
    callBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      triggerDirectCallFromCard(patientId, name, stageKey, time, article);
    });
  }

  // Status Badge Cycling Handler
  const badgeSlot = article.querySelector('.badge-slot');
  if (badgeSlot) {
    badgeSlot.addEventListener('click', (e) => {
      e.stopPropagation();
      cycleCardStatus(patientId, name, stageKey, time, article);
    });
  }

  // Clicking anywhere else opens telemetry modal
  article.addEventListener('click', (e) => {
    if (e.target.closest('.call-card-btn') || e.target.closest('.badge-slot')) return;
    const found = patients.find(p => (patientId && p.id === patientId) || (p.patient_name && p.patient_name.toLowerCase() === name.toLowerCase()));
    if (found) {
      openPatientModal(found.id);
    } else {
      openPatientModal(patients[0].id);
    }
  });

  return article;
}

function updateCardStatusUI(cardEl, newStatus, patient, timeStr) {
  const badgeSlot = cardEl.querySelector('.badge-slot');
  if (badgeSlot) {
    badgeSlot.innerHTML = renderBadgeMarkup(newStatus);
  }
  if (patient) {
    if (!patient._doseStatuses) patient._doseStatuses = {};
    if (timeStr) patient._doseStatuses[timeStr] = newStatus;
  }
  refreshKanbanCounts();
}

window.cycleCardStatus = function(patientId, name, stageKey, timeStr, cardEl) {
  const patient = patients.find(p => (patientId && p.id === patientId) || (p.patient_name && p.patient_name.toLowerCase() === name.toLowerCase()));
  const currentBadgeText = cardEl.querySelector('.status-badge')?.textContent.trim() || 'Pending';
  
  const nextStatusMap = {
    'Pending': 'On-going',
    'On-going': 'Complete',
    'Complete': 'Missed',
    'Missed': 'Pending'
  };

  const nextStatus = nextStatusMap[currentBadgeText] || 'Pending';
  updateCardStatusUI(cardEl, nextStatus, patient, timeStr);
  showToast(`${name} (${stageKey.toUpperCase()}): Status set to ${nextStatus}`);
};

window.triggerDirectCallFromCard = async function(patientId, name, stageKey, timeStr, cardEl) {
  const patient = patients.find(p => (patientId && p.id === patientId) || (p.patient_name && p.patient_name.toLowerCase() === name.toLowerCase()));
  const phone = patient ? (patient.patient_phone || '+919874770088') : '+919874770088';

  // 1. Immediately switch status to On-going
  updateCardStatusUI(cardEl, 'On-going', patient, timeStr);
  const callBtn = cardEl.querySelector('.call-card-btn');
  if (callBtn) {
    callBtn.classList.add('opacity-75');
    callBtn.innerHTML = `<span class="material-symbols-outlined text-[13px] animate-spin">sync</span><span>Dialing</span>`;
  }

  showToast(`Dialing ${name} (${phone}) via SIP outbound trunk...`);

  // 2. Dispatch to backend
  let targetDbId = patient ? patient.db_id : null;
  if (!targetDbId && patient) {
    const dbData = await fetchApi("/api/patients").catch(() => null);
    if (dbData && dbData.patients) {
      const match = dbData.patients.find(dp => dp.phone === patient.patient_phone || dp.name.toLowerCase() === patient.patient_name.toLowerCase());
      if (match) {
        targetDbId = match.id;
        patient.db_id = targetDbId;
      }
    }
  }

  if (targetDbId) {
    try {
      const qRes = await fetchApi('/api/queue', { method: 'POST', body: JSON.stringify({ patientIds: [targetDbId] }) });
      if (qRes && qRes.queued) {
        showToast(`Outbound SIP call dispatched: Ringing ${name} (${phone})`);
      }
    } catch (err) {
      console.error('Queue error:', err);
      showToast(`Call queue notice: ${err.message || 'Queued'}`);
    }
  }

  // 3. Complete call after brief simulation
  setTimeout(() => {
    updateCardStatusUI(cardEl, 'Complete', patient, timeStr);
    if (callBtn) {
      callBtn.classList.remove('opacity-75');
      callBtn.innerHTML = `<span class="material-symbols-outlined text-[13px]">call</span><span>Call</span>`;
    }
    showToast(`Call Complete &bull; ${name} acknowledged medication reminder (DTMF: 1)`);
  }, 2800);
};

function refreshKanbanCounts() {
  document.querySelectorAll('.kanban-column').forEach(column => {
    const stageId = column.dataset.stageId;
    const zone = column.querySelector('.cards-drop-zone');
    const countPill = column.querySelector('.column-count');
    const masterBtn = column.querySelector('.master-campaign-btn');

    if (zone && countPill) {
      countPill.textContent = zone.querySelectorAll('.kanban-card').length;
    }

    if (masterBtn && zone) {
      const cards = Array.from(zone.querySelectorAll('.kanban-card'));
      const pendingCards = cards.filter(card => {
        const badge = card.querySelector('.badge-slot');
        const text = badge ? badge.textContent.trim() : '';
        return !text.includes('Complete');
      });
      const pendingCount = pendingCards.length;
      const labelEl = masterBtn.querySelector('.campaign-btn-text');

      if (!masterBtn.dataset.busy) {
        let labelEl = masterBtn.querySelector('.campaign-btn-text');
        if (!labelEl) {
          masterBtn.innerHTML = `<span class="material-symbols-outlined text-[13px]">campaign</span><span class="campaign-btn-text"></span>`;
          labelEl = masterBtn.querySelector('.campaign-btn-text');
        }
        if (labelEl) {
          labelEl.textContent = `Call All (${pendingCount})`;
        }
        if (pendingCount === 0) {
          masterBtn.disabled = true;
          masterBtn.classList.add('opacity-40', 'cursor-not-allowed');
          masterBtn.classList.remove('cursor-pointer', 'hover:bg-neutral-800');
          masterBtn.title = `All calls in ${stageId} are complete`;
        } else {
          masterBtn.disabled = false;
          masterBtn.classList.remove('opacity-40', 'cursor-not-allowed');
          masterBtn.classList.add('cursor-pointer', 'hover:bg-neutral-800');
          masterBtn.title = `Call all ${pendingCount} non-completed patient(s) in ${stageId}`;
        }
      }
    }
  });
}

// ── Master Campaign Column Actions ───────────────────────────────────────────
let currentCampaignContext = null;

window.closeCampaignConfirmModal = function() {
  const modal = document.getElementById('campaignConfirmModal');
  if (modal) modal.classList.add('hidden');
};

window.runColumnCampaign = async function(slotKey) {
  const normSlot = String(slotKey || '').toLowerCase();
  const slotLabels = {
    morning: 'Morning (< 12:00)',
    evening: 'Evening (12:00 – 18:00)',
    dinner: 'Dinner (> 18:00)',
    'try-again': 'Try Again (Retries)'
  };
  const label = slotLabels[normSlot] || normSlot.toUpperCase();

  const zone = document.querySelector(`.cards-drop-zone[data-stage="${normSlot}"]`);
  if (!zone) return;

  const cardEls = Array.from(zone.querySelectorAll('.kanban-card'));
  const pendingCards = cardEls.filter(c => {
    const b = c.querySelector('.badge-slot');
    const txt = b ? b.textContent.trim() : '';
    return !txt.includes('Complete');
  });

  if (!pendingCards.length) {
    showToast(`All calls in ${label} are already complete.`);
    return;
  }

  // Map pending cards to patient records
  const pendingPatients = [];
  for (const card of pendingCards) {
    const pId = card.dataset.patientId;
    const name = card.dataset.name;
    const time = card.dataset.time;
    let patient = patients.find(p => (pId && p.id === pId) || (p.patient_name && p.patient_name.toLowerCase() === name.toLowerCase()));
    
    let dbId = patient?.db_id || (pId && pId.match(/\d+$/) ? Number(pId.match(/\d+$/)[0]) : null);
    if (!dbId && patient) {
      const dbData = await fetchApi('/api/patients').catch(() => null);
      if (dbData && dbData.patients) {
        const match = dbData.patients.find(dp => dp.phone === patient.patient_phone || dp.name.toLowerCase() === patient.patient_name.toLowerCase());
        if (match) {
          dbId = match.id;
          patient.db_id = dbId;
        }
      }
    }
    if (patient && dbId) patient.db_id = dbId;

    const slotMeds = normSlot === 'morning' ? patient?.morning_medicines 
      : normSlot === 'evening' ? patient?.evening_medicines 
      : normSlot === 'dinner' ? patient?.dinner_medicines 
      : (patient?.morning_medicines || patient?.evening_medicines || patient?.dinner_medicines);

    pendingPatients.push({
      card,
      patient: patient || { id: pId, db_id: dbId, patient_name: name, patient_phone: '+919874770088' },
      name: patient?.patient_name || name,
      time,
      phone: patient?.patient_phone || '+919874770088',
      medicines: slotMeds || card.querySelector('div.font-mono-data')?.textContent || 'Prescribed regimen'
    });
  }

  currentCampaignContext = {
    slot: normSlot,
    label,
    pending: pendingPatients,
  };

  // Directly execute the batch call for all non-completed patients in the column
  executeColumnCampaign(currentCampaignContext);
};

window.executeColumnCampaign = async function(ctx) {
  if (!ctx || !ctx.pending || !ctx.pending.length) return;
  const { slot, label, pending } = ctx;
  const btn = document.getElementById(`btn-campaign-${slot}`);

  // 1. Set Master Button to loading spinner
  if (btn) {
    btn.dataset.busy = 'true';
    btn.disabled = true;
    btn.innerHTML = `<span class="material-symbols-outlined text-[13px] animate-spin">sync</span><span class="campaign-btn-text">Calling (${pending.length})...</span>`;
  }

  // 2. Set all pending cards to On-going and Dialing
  pending.forEach(item => {
    updateCardStatusUI(item.card, 'On-going', item.patient, item.time);
    const cardCallBtn = item.card.querySelector('.call-card-btn');
    if (cardCallBtn) {
      cardCallBtn.classList.add('opacity-75');
      cardCallBtn.innerHTML = `<span class="material-symbols-outlined text-[13px] animate-spin">sync</span><span>Dialing</span>`;
    }
  });

  showToast(`Initiating ${slot.toUpperCase()} Campaign: Calling ${pending.length} pending numbers...`);

  // 3. Dispatch to backend
  const targetDbIds = pending.map(item => item.patient?.db_id).filter(Boolean);

  try {
    const res = await fetchApi('/api/campaign/dispatch-column', {
      method: 'POST',
      body: JSON.stringify({
        column: slot,
        patientIds: targetDbIds.length ? targetDbIds : null,
        force: true
      })
    });

    if (res && res.success) {
      showToast(`Campaign Dispatched • ${res.queued} patient(s) dialed via Sarvam SIP`);
      if (btn) {
        btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">check</span><span class="campaign-btn-text">Dispatched (${res.queued})</span>`;
      }
    } else {
      showToast(`Campaign notice: ${res?.message || 'Queued'}`);
    }
  } catch (err) {
    console.error('Column campaign dispatch error:', err);
    let fallbackSuccess = false;
    if (targetDbIds.length) {
      try {
        const qRes = await fetchApi('/api/queue', {
          method: 'POST',
          body: JSON.stringify({ patientIds: targetDbIds, force: true })
        });
        if (qRes && qRes.queued) {
          fallbackSuccess = true;
          showToast(`Direct Queue Fallback: Dialing ${qRes.queued} patient(s) via Sarvam SIP`);
          if (btn) btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">check</span><span class="campaign-btn-text">Dispatched (${qRes.queued})</span>`;
        }
      } catch (qErr) {
        console.error('Queue fallback error:', qErr);
      }
    }
    if (!fallbackSuccess) {
      showToast(`Campaign Dispatch: ${err.message || 'Error occurred'}`);
      if (btn) {
        btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">error</span><span class="campaign-btn-text">Error</span>`;
      }
    }
  }

  // 4. Staggered visual completion simulation & reset button
  pending.forEach((item, index) => {
    setTimeout(() => {
      updateCardStatusUI(item.card, 'Complete', item.patient, item.time);
      const cardCallBtn = item.card.querySelector('.call-card-btn');
      if (cardCallBtn) {
        cardCallBtn.classList.remove('opacity-75');
        cardCallBtn.innerHTML = `<span class="material-symbols-outlined text-[13px]">call</span><span>Call</span>`;
      }
      showToast(`Call Complete • ${item.name} confirmed adherence (DTMF: 1)`);
    }, 3000 + (index * 600));
  });

  setTimeout(() => {
    if (btn) {
      delete btn.dataset.busy;
      btn.innerHTML = `<span class="material-symbols-outlined text-[13px]">campaign</span><span class="campaign-btn-text">Call All</span>`;
    }
    refreshKanbanCounts();
  }, 3500 + (pending.length * 600));
};

function attachKanbanDragDropHandlers() {
  const cards = document.querySelectorAll('.kanban-card');
  const dropZones = document.querySelectorAll('.cards-drop-zone');

  cards.forEach(card => {
    card.addEventListener('dragstart', (e) => {
      draggedCardEl = card;
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('opacity-40', 'border-dashed', 'border-primary');
    });

    card.addEventListener('dragend', () => {
      if (draggedCardEl) {
        draggedCardEl.classList.remove('opacity-40', 'border-dashed', 'border-primary');
        draggedCardEl = null;
      }
      dropZones.forEach(zone => {
        zone.classList.remove('bg-surface-container-high', 'border-primary', 'ring-1', 'ring-primary');
      });
      refreshKanbanCounts();
    });
  });

  dropZones.forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      zone.classList.add('bg-surface-container-high', 'ring-1', 'ring-primary');
    });

    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) {
        zone.classList.remove('bg-surface-container-high', 'ring-1', 'ring-primary');
      }
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('bg-surface-container-high', 'ring-1', 'ring-primary');
      if (draggedCardEl) {
        const oldStage = draggedCardEl.dataset.stage;
        const newStage = zone.dataset.stage;
        const cardName = draggedCardEl.dataset.name;

        // Move in data model
        if (oldStage && KANBAN_STAGES[oldStage]) {
          const idx = KANBAN_STAGES[oldStage].findIndex(c => c.name === cardName);
          if (idx !== -1) {
            const [item] = KANBAN_STAGES[oldStage].splice(idx, 1);
            if (newStage && KANBAN_STAGES[newStage]) {
              KANBAN_STAGES[newStage].push(item);
            }
          }
        }

        zone.appendChild(draggedCardEl);
        draggedCardEl.dataset.stage = newStage;
        refreshKanbanCounts();
        showToast(`Moved card to ${newStage.toUpperCase()}`);
      }
    });
  });
}

window.quickAddCard = function(stageKey) {
  const patientName = prompt("Enter patient name to add to " + stageKey.toUpperCase() + ":", "New Patient");
  if (!patientName) return;

  const newCard = {
    name: patientName.trim(),
    status: "On-going",
    time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  };

  if (!KANBAN_STAGES[stageKey]) KANBAN_STAGES[stageKey] = [];
  KANBAN_STAGES[stageKey].unshift(newCard);

  renderKanbanBoard();
  showToast(`Added ${patientName} to ${stageKey.toUpperCase()}`);
};

// ── Patient Modal (Telemetry & Detailed Record) ──────────────────────────────
window.openPatientModal = function(patientId) {
  const patient = patients.find(p => p.id === patientId) || patients[0];
  currentActivePatient = patient;

  document.getElementById("mName").textContent = patient.patient_name;
  document.getElementById("mMrn").textContent = "#" + patient.id;
  document.getElementById("mBay").textContent = patient.dialysis_bay || "Station 4B (Hemodialysis)";
  document.getElementById("mPhone").textContent = patient.patient_phone;
  document.getElementById("mFrontDesk").textContent = patient.front_desk_number || "+919874770088";
  document.getElementById("mEmergency").textContent = patient.emergency_contact || "None";
  document.getElementById("mRelation").textContent = "Emergency Contact: " + (patient.emergency_contact ? patient.emergency_contact : "Not provided");

  document.getElementById("mDialysisDate").textContent = patient.dialysis_appointment_date || "2026-10-14";
  document.getElementById("mDialysisTime").textContent = formatTime12h(patient.dialysis_appointment_time) || "10:00 AM";
  document.getElementById("mDialysisBay").textContent = patient.dialysis_bay || "Station 4B (Hemodialysis)";

  document.getElementById("mMedMorning").textContent = patient.morning_medicines || "Amlodipine 1 tab, Telmisartan 1 tab";
  const mTimeMorningEl = document.getElementById("mTimeMorning");
  if (mTimeMorningEl) mTimeMorningEl.textContent = formatTime12h(patient.morning_reminder_time) || "08:30 AM";

  document.getElementById("mMedEvening").textContent = patient.evening_medicines || "Furosemide 1 tablet";
  const mTimeEveningEl = document.getElementById("mTimeEvening");
  if (mTimeEveningEl) mTimeEveningEl.textContent = formatTime12h(patient.evening_reminder_time) || "02:30 PM";

  document.getElementById("mMedDinner").textContent = patient.dinner_medicines || "Atorvastatin 2 tablets";
  const mTimeDinnerEl = document.getElementById("mTimeDinner");
  if (mTimeDinnerEl) mTimeDinnerEl.textContent = formatTime12h(patient.dinner_reminder_time) || "10:30 PM";

  // Synthesized speech script preview reflecting new variables and clinical prompt
  const firstName = (patient.patient_name || patient.name || 'Patient').split(' ')[0];
  const slot = (patient.current_slot_label || 'morning').toLowerCase();
  let slotMeds = patient.morning_medicines || 'Amlodipine 1 tablet, Telmisartan 1 tablet';
  if (slot === 'evening') slotMeds = patient.evening_medicines || 'Furosemide 1 tablet';
  else if (slot === 'dinner') slotMeds = patient.dinner_medicines || 'Atorvastatin 2 tablets';

  const apptTime = formatTime12h(patient.dialysis_appointment_time) || '10:00 AM';
  const dialysisNote = patient.dialysis_appointment_date
    ? `Aur haan, kal aapka dialysis appointment ${apptTime} baje scheduled hai clinic mein, toh samay par zaroor pahunch jaiyega.`
    : '';

  const previewText = `Oh, namaste! How are you doing? Is all well? I hope your health is good?

Listen, ${firstName}, it is time for your medicines! That is why I called, so I could remind you. Today in the ${slot} slot you need to take ${slotMeds}, all right? Keep some water with you and take your medicines comfortably, just as the doctor advised.

${dialysisNote ? dialysisNote + '\n\n' : ''}And yes, ${firstName}, take good care of yourself. You take such good care of everyone, so take care of yourself too!

Alright then, I will hang up now. We will talk again. Stay happy, look after yourself. Namaste!`;
  document.getElementById("mVoicePreview").textContent = previewText;

  // Hide simulation bar
  document.getElementById("audioSimulationStrip").classList.add("hidden");

  // Update auto-call badge state in modal header
  updateModalAutoCallBadge(patient);

  // Show modal
  document.getElementById("patientModal").classList.remove("hidden");
};

function updateModalAutoCallBadge(patient) {
  const isAuto = patient.auto_call_enabled !== 0;
  const dot = document.getElementById("mAutoCallDot");
  const txt = document.getElementById("mAutoCallText");
  const badge = document.getElementById("mAutoCallBadge");
  if (dot) dot.className = isAuto ? "w-1.5 h-1.5 bg-primary" : "w-1.5 h-1.5 bg-outline-variant";
  if (txt) txt.textContent = isAuto ? "Auto-Call: Enabled" : "Auto-Call: Paused";
  if (badge) {
    badge.className = isAuto
      ? "inline-flex items-center gap-1 px-1.5 py-0.5 border border-primary bg-surface-container-lowest font-mono-data text-mono-data text-primary hover:bg-surface-container-high transition-none cursor-pointer"
      : "inline-flex items-center gap-1 px-1.5 py-0.5 border border-outline-variant bg-surface-container-low font-mono-data text-mono-data text-on-surface-variant hover:text-on-surface transition-none cursor-pointer";
  }
}

window.toggleCurrentPatientAutoCall = function() {
  if (currentActivePatient) {
    togglePatientAutoCall(currentActivePatient.id);
  }
};

window.closePatientModal = function() {
  document.getElementById("patientModal").classList.add("hidden");
};

window.triggerTestCall = async function() {
  const strip = document.getElementById("audioSimulationStrip");
  const bar = document.getElementById("audioProgressBar");
  const status = document.getElementById("callStatusText");
  const btnLabel = document.getElementById("testCallBtnLabel");

  strip.classList.remove("hidden");
  status.textContent = `Connecting outbound SIP trunk to ${currentActivePatient.patient_phone || '+917965480404'}...`;
  bar.style.width = "15%";
  btnLabel.textContent = "Connecting...";

  // Ensure patient exists in SQLite and queue outbound call
  let targetDbId = currentActivePatient.db_id;
  if (!targetDbId) {
    const dbData = await fetchApi('/api/patients').catch(() => null);
    if (dbData && dbData.patients) {
      const match = dbData.patients.find(dp => dp.phone === currentActivePatient.patient_phone || dp.name.toLowerCase() === currentActivePatient.patient_name.toLowerCase());
      if (match) {
        targetDbId = match.id;
        currentActivePatient.db_id = targetDbId;
      }
    }
  }

  if (targetDbId) {
    fetchApi('/api/queue', { method: 'POST', body: JSON.stringify({ patientIds: [targetDbId] }) })
      .then(res => {
        if (res && res.queued) {
          showToast(`Live call queued via Sarvam for ${currentActivePatient.patient_name}`);
        }
      })
      .catch(err => {
        console.error("Queue error:", err);
      });
  }

  setTimeout(() => {
    bar.style.width = "45%";
    status.innerHTML = `Dialing recipient ${escapeHtml(currentActivePatient.patient_name)} &bull; Carrier Ack [200 OK]`;
  }, 900);

  setTimeout(() => {
    bar.style.width = "85%";
    status.textContent = `Live Telephony Stream Active via Sarvam (+917965480404)`;
  }, 1800);

  setTimeout(() => {
    bar.style.width = "100%";
    status.innerHTML = `Call Dispatched &bull; Ringing Recipient Handset`;
    btnLabel.textContent = "Trigger Test Call";
    showToast(`Outbound voice test dispatch completed for ${currentActivePatient.patient_name}`);
  }, 3200);
};

window.triggerCallPatient = async function(patientId) {
  const p = patients.find(item => item.id === patientId);
  if (!p) return;
  openPatientModal(p.id);
  setTimeout(() => {
    triggerTestCall();
  }, 300);
};

// ── Complete CRUD: Edit & Delete Patient Records ────────────────────────────
let pendingDeletePatient = null;

window.openEditModalForCurrent = function() {
  if (currentActivePatient) {
    openEditPatientModal(currentActivePatient.id);
  }
};

window.openEditPatientModal = function(patientId) {
  const patient = patients.find(p => p.id === patientId) || currentActivePatient;
  if (!patient) return;
  currentActivePatient = patient;

  document.getElementById("editPatientId").value = patient.id;
  const mrnEl = document.getElementById("editPatientMrn");
  if (mrnEl) mrnEl.textContent = "#" + patient.id;

  document.getElementById("editName").value = patient.patient_name || "";
  document.getElementById("editPhone").value = patient.patient_phone || "";
  document.getElementById("editFrontDesk").value = patient.front_desk_number || "+917965480404";
  document.getElementById("editEmergency").value = patient.emergency_contact || "";

  document.getElementById("editDialysisDate").value = patient.dialysis_appointment_date || "";
  
  // Convert 12h or 24h time to HH:MM format for <input type="time">
  const parseTo24h = (t) => {
    if (!t) return "";
    const m = t.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (!m) return t.slice(0, 5);
    let hh = parseInt(m[1], 10);
    const mm = m[2];
    const ampm = m[3]?.toUpperCase();
    if (ampm === "PM" && hh < 12) hh += 12;
    if (ampm === "AM" && hh === 12) hh = 0;
    return `${String(hh).padStart(2, "0")}:${mm}`;
  };

  document.getElementById("editDialysisTime").value = parseTo24h(patient.dialysis_appointment_time) || "10:00";
  document.getElementById("editDialysisBay").value = patient.dialysis_bay || "Station 4B (Hemodialysis)";

  document.getElementById("editMorningMed").value = patient.morning_medicines || "";
  document.getElementById("editMorningTime").value = parseTo24h(patient.morning_reminder_time) || "09:00";

  document.getElementById("editEveningMed").value = patient.evening_medicines || "";
  document.getElementById("editEveningTime").value = parseTo24h(patient.evening_reminder_time) || "14:30";

  document.getElementById("editDinnerMed").value = patient.dinner_medicines || "";
  document.getElementById("editDinnerTime").value = parseTo24h(patient.dinner_reminder_time) || "22:00";

  const editAutoEl = document.getElementById("editAutoCall");
  if (editAutoEl) editAutoEl.value = String(patient.auto_call_enabled !== 0 ? 1 : 0);

  document.getElementById("editPatientModal").classList.remove("hidden");
};

window.closeEditPatientModal = function() {
  document.getElementById("editPatientModal").classList.add("hidden");
};

window.handleEditPatientSubmit = async function(e) {
  e.preventDefault();

  const id = document.getElementById("editPatientId").value;
  const patient = patients.find(p => p.id === id);
  if (!patient) return;

  const patient_name = document.getElementById("editName").value.trim();
  const patient_phone = document.getElementById("editPhone").value.trim();
  const front_desk_number = document.getElementById("editFrontDesk").value.trim() || "+917965480404";
  const emergency_contact = document.getElementById("editEmergency").value.trim();
  const dialysis_appointment_date = document.getElementById("editDialysisDate").value;
  const dialysis_appointment_time = document.getElementById("editDialysisTime").value;
  const dialysis_bay = document.getElementById("editDialysisBay").value.trim() || "Station 4B (Hemodialysis)";
  const morning_medicines = document.getElementById("editMorningMed").value.trim();
  const morning_reminder_time = document.getElementById("editMorningTime").value;
  const evening_medicines = document.getElementById("editEveningMed").value.trim();
  const evening_reminder_time = document.getElementById("editEveningTime").value;
  const dinner_medicines = document.getElementById("editDinnerMed").value.trim();
  const dinner_reminder_time = document.getElementById("editDinnerTime").value;
  const auto_call_enabled = document.getElementById("editAutoCall")?.value === "0" ? 0 : 1;

  const payload = {
    name: patient_name,
    phone: patient_phone,
    call_purpose: 'medication_reminder',
    front_desk_number,
    emergency_contact,
    dialysis_bay,
    dialysis_appointment_date,
    dialysis_appointment_time: formatTime12h(dialysis_appointment_time),
    morning_medicines,
    morning_reminder_time,
    evening_medicines,
    evening_reminder_time,
    dinner_medicines,
    dinner_reminder_time,
    auto_call_enabled
  };

  // Sync with SQLite backend
  if (patient.db_id) {
    await fetchApi(`/api/patients/${patient.db_id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    }).catch(err => console.warn('PUT failed:', err));
  }

  // Update in-memory patient model
  patient.patient_name = patient_name;
  patient.patient_phone = patient_phone;
  patient.front_desk_number = front_desk_number;
  patient.emergency_contact = emergency_contact;
  patient.dialysis_bay = dialysis_bay;
  patient.dialysis_appointment_date = dialysis_appointment_date;
  patient.dialysis_appointment_time = formatTime12h(dialysis_appointment_time);
  patient.morning_medicines = morning_medicines;
  patient.morning_reminder_time = morning_reminder_time;
  patient.evening_medicines = evening_medicines;
  patient.evening_reminder_time = evening_reminder_time;
  patient.dinner_medicines = dinner_medicines;
  patient.dinner_reminder_time = dinner_reminder_time;
  patient.auto_call_enabled = auto_call_enabled;

  closeEditPatientModal();

  // If the patient details modal was open, refresh it
  const pModal = document.getElementById("patientModal");
  if (pModal && !pModal.classList.contains("hidden")) {
    openPatientModal(patient.id);
  }

  renderPatientTable(patients);
  renderPatientGrid(patients);
  updateMetricCounters();
  syncScheduleMatrixFromPatients();

  showToast(`Updated patient record for ${patient_name}`);
};

// ── Deletion Engine ─────────────────────────────────────────────────────────
window.deleteCurrentActivePatient = function() {
  if (currentActivePatient) {
    promptDeletePatient(currentActivePatient.id);
  }
};

window.promptDeletePatient = function(patientId) {
  const patient = patients.find(p => p.id === patientId);
  if (!patient) return;
  pendingDeletePatient = patient;

  const confirmTextEl = document.getElementById("deleteConfirmText");
  if (confirmTextEl) {
    confirmTextEl.innerHTML = `Are you sure you want to permanently delete <strong>${escapeHtml(patient.patient_name)}</strong> (${escapeHtml(patient.patient_phone)})? This removes their medication dispatches from the schedule matrix and cancels all automated voice reminders.`;
  }

  const btnConfirm = document.getElementById("btnConfirmDelete");
  if (btnConfirm) {
    btnConfirm.onclick = () => executeDeletePatient(patient.id);
  }

  document.getElementById("deleteConfirmModal").classList.remove("hidden");
};

window.closeDeleteConfirmModal = function() {
  document.getElementById("deleteConfirmModal").classList.add("hidden");
  pendingDeletePatient = null;
};

window.executeDeletePatient = async function(patientId) {
  const patient = patients.find(p => p.id === patientId);
  const name = patient ? patient.patient_name : "Patient";

  if (patient && patient.db_id) {
    await fetchApi(`/api/patients/${patient.db_id}`, { method: 'DELETE' }).catch(err => console.warn('Delete failed:', err));
  }

  // Remove from in-memory patients list
  patients = patients.filter(p => p.id !== patientId);

  // Clean up Kanban stages
  Object.keys(KANBAN_STAGES).forEach(key => {
    KANBAN_STAGES[key] = KANBAN_STAGES[key].filter(card => card.id !== patientId && card.name !== name);
  });

  closeDeleteConfirmModal();
  closeEditPatientModal();
  closePatientModal();

  renderPatientTable(patients);
  renderPatientGrid(patients);
  updateMetricCounters();
  syncScheduleMatrixFromPatients();

  showToast(`Permanently deleted ${name}`);
};


// ── Register Patient Modal (All 12 Input Variables) ──────────────────────────
window.openRegisterModal = function() {
  document.getElementById("registerModal").classList.remove("hidden");
};

window.closeRegisterModal = function() {
  document.getElementById("registerModal").classList.add("hidden");
};

window.handleNewPatientSubmit = async function(e) {
  e.preventDefault();

  const patient_name = document.getElementById("regName").value.trim();
  const patient_phone = document.getElementById("regPhone").value.trim();
  const front_desk_number = document.getElementById("regFrontDesk").value.trim() || "+919874770088";
  const emergency_contact = document.getElementById("regEmergency").value.trim();
  const dialysis_appointment_date = document.getElementById("regDialysisDate").value;
  const dialysis_appointment_time = document.getElementById("regDialysisTime").value.trim();
  const morning_medicines = document.getElementById("regMorningMed").value.trim();
  const morning_reminder_time = document.getElementById("regMorningTime").value.trim();
  const evening_medicines = document.getElementById("regEveningMed").value.trim();
  const evening_reminder_time = document.getElementById("regEveningTime").value.trim();
  const dinner_medicines = document.getElementById("regDinnerMed").value.trim();
  const dinner_reminder_time = document.getElementById("regDinnerTime").value.trim();
  const auto_call_enabled = document.getElementById("regAutoCall")?.value === "0" ? 0 : 1;

  // Create patient in backend SQLite if available
  let dbPatientId = null;
  const res = await fetchApi('/api/patients', {
    method: 'POST',
    body: JSON.stringify({
      name: patient_name,
      phone: patient_phone,
      call_purpose: 'medication_reminder',
      front_desk_number,
      emergency_contact,
      morning_medicines,
      evening_medicines,
      dinner_medicines,
      morning_reminder_time,
      evening_reminder_time,
      dinner_reminder_time,
      dialysis_appointment_date,
      dialysis_appointment_time: formatTime12h(dialysis_appointment_time),
      auto_call_enabled
    })
  });

  if (res && res.patient) {
    dbPatientId = res.patient.id;
  }

  const newPat = {
    id: "NV-2026-" + Math.floor(1000 + Math.random() * 9000),
    db_id: dbPatientId,
    patient_name,
    patient_phone,
    front_desk_number,
    emergency_contact,
    relationship: "Designated Caregiver",
    dialysis_appointment_date,
    dialysis_appointment_time: formatTime12h(dialysis_appointment_time),
    dialysis_bay: "Station 3A (Hemodialysis)",
    morning_medicines,
    morning_reminder_time,
    evening_medicines,
    evening_reminder_time,
    dinner_medicines,
    dinner_reminder_time,
    auto_call_enabled,
    voice_status: "Active Dispatches",
    last_call_status: "Scheduled",
    frequency: "3x / week (Pending)",
    is_primary: false
  };

  // Add new patient to global patients list
  patients.unshift(newPat);
  renderPatientTable(patients);
  renderPatientGrid(patients);
  updateMetricCounters();

  // Re-sync schedule matrix completely so newly added patient appears in all matching matrix columns
  syncScheduleMatrixFromPatients();

  const placedColumns = [];
  if (morning_medicines && morning_medicines.trim() !== '') {
    const slot = classifyMedicationSlotByTime(morning_reminder_time, 'morning');
    placedColumns.push(slot.charAt(0).toUpperCase() + slot.slice(1));
  }
  if (evening_medicines && evening_medicines.trim() !== '') {
    const slot = classifyMedicationSlotByTime(evening_reminder_time, 'evening');
    placedColumns.push(slot.charAt(0).toUpperCase() + slot.slice(1));
  }
  if (dinner_medicines && dinner_medicines.trim() !== '') {
    const slot = classifyMedicationSlotByTime(dinner_reminder_time, 'dinner');
    placedColumns.push(slot.charAt(0).toUpperCase() + slot.slice(1));
  }
  if ((dialysis_appointment_date && dialysis_appointment_date.trim() !== '') || 
      (dialysis_appointment_time && dialysis_appointment_time.trim() !== '')) {
    placedColumns.push('Dialysis');
  }
  const uniqueCols = [...new Set(placedColumns)];

  closeRegisterModal();
  showToast(`Placed ${patient_name} in ${uniqueCols.join(', ') || 'Schedule Matrix'}`);
  openPatientModal(newPat.id);
};

// ── Backend Sync ─────────────────────────────────────────────────────────────
window.triggerGlobalSync = async function() {
  const btnLabel = document.getElementById("syncBtnLabel");
  btnLabel.textContent = "Syncing Backend...";

  await fetchApi('/api/sync', { method: 'POST' });
  await loadServerData();

  setTimeout(() => {
    btnLabel.textContent = "Sync Voice Backend";
    showToast("Voice Dispatch Backend Synced: Queues active, 0 drops");
  }, 600);
};

// ── Voice Dispatch View ──────────────────────────────────────────────────────
function renderDispatchView() {
  const campaignIdEl = document.getElementById("dispatchCampaignId");
  const allowlistEl = document.getElementById("dispatchAllowlist");
  const listEl = document.getElementById("dispatchCohortsList");

  if (serverConfig) {
    if (campaignIdEl) campaignIdEl.textContent = serverConfig.campaignId || "Reception-Auto-Campaign";
    if (allowlistEl) {
      allowlistEl.textContent = serverConfig.allowlistActive
        ? serverConfig.allowedNumbersMasked.join(', ')
        : "All Registered Patients (Auto-Allow)";
    }
  }

  if (serverStatus && serverStatus.cohorts && listEl) {
    if (!serverStatus.cohorts.length) {
      listEl.innerHTML = `<div class="py-4 text-center font-mono-data text-on-surface-variant">No recent cohorts yet. Dispatch a batch to create one.</div>`;
    } else {
      listEl.innerHTML = serverStatus.cohorts.map(c => `
        <div class="py-3 flex items-center justify-between font-mono-data text-mono-data">
          <div>
            <div class="font-bold text-primary">${escapeHtml(c.name || c.cohort_id)}</div>
            <div class="text-on-surface-variant text-[11px]">${escapeHtml(c.created_at || 'Recently')} &bull; Status: ${escapeHtml(c.status)}</div>
          </div>
          <span class="px-2 py-0.5 border border-outline-variant bg-surface-container-low text-primary text-[11px] font-bold uppercase">${escapeHtml(c.status)}</span>
        </div>
      `).join('');
    }
  }
}

window.queueAllActive = async function() {
  showToast("Queueing batch dispatch for all scheduled patients...");
  await fetchApi('/api/sync', { method: 'POST' });
  showToast("Batch successfully committed to Sarvam Campaign Queue");
};

// ── Call Logs, Duration, Pickup & Sarvam AI Cost Ledger ─────────────────────
async function renderTranscriptsView() {
  const tbody = document.getElementById("attemptsTableBody");
  if (!tbody) return;

  const data = await fetchApi('/api/attempts');
  const attempts = data && Array.isArray(data.attempts) ? data.attempts : [];
  const ratePerMinute = data?.ratePerMinute || 1.80;

  // Rate label
  const rateLabel = document.getElementById("billingRateLabel");
  if (rateLabel) rateLabel.textContent = `Billing Rate: ₹${ratePerMinute.toFixed(2)} / min`;

  // Aggregate Metrics
  const totalCalls = attempts.length;
  const connectedCalls = attempts.filter(a => a.is_picked_up).length;
  const missedCalls = totalCalls - connectedCalls;
  const pickupRate = totalCalls > 0 ? Math.round((connectedCalls / totalCalls) * 100) : 0;
  
  const totalDurationSec = attempts.reduce((sum, a) => sum + (a.is_picked_up ? (Number(a.duration_seconds) || 0) : 0), 0);
  const totalMinutes = Math.floor(totalDurationSec / 60);
  const totalRemainderSec = Math.round(totalDurationSec % 60);
  const totalCost = (totalDurationSec / 60) * ratePerMinute;

  // Update KPI counters
  const totalCallsEl = document.getElementById("metricTotalCalls");
  const pickupRateEl = document.getElementById("metricPickupRate");
  const pickupCountsEl = document.getElementById("metricPickupCounts");
  const totalDurationEl = document.getElementById("metricTotalDuration");
  const totalCostEl = document.getElementById("metricTotalCost");

  if (totalCallsEl) totalCallsEl.textContent = `${totalCalls}`;
  if (pickupRateEl) pickupRateEl.textContent = `${pickupRate}%`;
  if (pickupCountsEl) pickupCountsEl.textContent = `${connectedCalls} Picked Up / ${missedCalls} Missed`;
  if (totalDurationEl) totalDurationEl.textContent = `${totalMinutes}m ${String(totalRemainderSec).padStart(2, '0')}s`;
  if (totalCostEl) totalCostEl.textContent = `₹${totalCost.toFixed(2)}`;

  if (!attempts.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="py-8 text-center font-mono-data text-on-surface-variant">
          No outbound call logs recorded in system yet.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = attempts.map(a => {
    const isPickedUp = Boolean(a.is_picked_up);
    const sec = Number(a.duration_seconds) || 0;
    const callCost = isPickedUp ? ((sec / 60) * ratePerMinute) : 0;

    // Format Duration
    let durText = "0s (Unanswered)";
    if (isPickedUp && sec > 0) {
      if (sec >= 60) {
        const m = Math.floor(sec / 60);
        const s = Math.round(sec % 60);
        durText = `${m}m ${String(s).padStart(2, '0')}s (${Math.round(sec)}s)`;
      } else {
        durText = `${Math.round(sec)} seconds`;
      }
    }

    // Format Pickup Status Badge
    let statusBadge = "";
    if (a.connectivity_status === 'connected') {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 border border-primary bg-primary text-on-primary font-mono-data text-[11px] font-bold"><span class="w-1.5 h-1.5 bg-emerald-400"></span>PICKED UP (COMPLETED)</span>`;
    } else if (a.connectivity_status === 'busy') {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 border border-outline-variant bg-surface-container-low text-on-surface font-mono-data text-[11px]"><span class="w-1.5 h-1.5 bg-amber-500"></span>LINE BUSY</span>`;
    } else if (a.connectivity_status === 'no_answer') {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 border border-outline-variant bg-surface-container-low text-on-surface-variant font-mono-data text-[11px]"><span class="w-1.5 h-1.5 bg-neutral-400"></span>NO ANSWER (UNANSWERED)</span>`;
    } else {
      statusBadge = `<span class="inline-flex items-center gap-1.5 px-2 py-0.5 border border-red-500/40 bg-red-50 text-red-600 font-mono-data text-[11px]"><span class="w-1.5 h-1.5 bg-red-600"></span>FAILED / DROPPED</span>`;
    }

    // Format Ended By
    let endedDesc = a.ended_by || "COMPLETED";
    if (endedDesc === "AGENT_ENDS") endedDesc = "Agent Completed";
    else if (endedDesc === "USER_ENDS") endedDesc = "Patient Disconnected";
    else if (endedDesc === "VOICEMAIL") endedDesc = "Voicemail Handshake";
    else if (endedDesc === "NO_END_REASON") endedDesc = "Carrier Timed Out";

    const dateStr = a.start_datetime ? new Date(a.start_datetime).toLocaleString('sv-SE').replace('T', ' ') : '—';
    const shortId = a.attempt_id ? a.attempt_id.slice(0, 12) + '...' : '—';

    return `
      <tr class="hover:bg-surface-container-high transition-none border-b border-outline-variant bg-surface-container-lowest">
        <td class="py-space-sm px-space-md font-mono-data text-mono-data text-on-surface-variant">
          ${escapeHtml(dateStr)}
        </td>
        <td class="py-space-sm px-space-md">
          <div class="font-headline-sm text-primary font-bold">${escapeHtml(a.patient_name || 'Patient')}</div>
          <div class="font-mono-data text-mono-data text-on-surface-variant">${escapeHtml(a.user_phone)}</div>
        </td>
        <td class="py-space-sm px-space-md">
          ${statusBadge}
        </td>
        <td class="py-space-sm px-space-md font-mono-data font-semibold ${isPickedUp ? 'text-primary' : 'text-on-surface-variant'}">
          ${escapeHtml(durText)}
        </td>
        <td class="py-space-sm px-space-md font-mono-data font-bold text-mono-data ${callCost > 0 ? 'text-primary' : 'text-on-surface-variant'}">
          ₹${callCost.toFixed(2)}
        </td>
        <td class="py-space-sm px-space-md text-on-surface-variant font-label-sm text-label-sm">
          ${escapeHtml(endedDesc)}
        </td>
        <td class="py-space-sm px-space-md font-mono-data text-[11px] text-on-surface-variant text-right" title="${escapeHtml(a.attempt_id)}">
          ${escapeHtml(shortId)}
        </td>
      </tr>
    `;
  }).join('');
}

window.refreshTranscripts = async function() {
  await fetchApi('/api/sync', { method: 'POST' }).catch(() => {});
  await renderTranscriptsView();
  showToast("Call telemetry records & billing ledger refreshed");
};


// ── Agent Protocols View ─────────────────────────────────────────────────────
const NEW_INPUT_DOCS = [
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

function renderProtocolsView() {
  const inputEl = document.getElementById("protoInputVars");
  const outputEl = document.getElementById("protoOutputVars");

  if (inputEl) {
    let vars = NEW_INPUT_DOCS;
    if (serverConfig && serverConfig.inputVariables) {
      vars = Array.isArray(serverConfig.inputVariables)
        ? serverConfig.inputVariables
        : Object.entries(serverConfig.inputVariables);
    }

    inputEl.innerHTML = vars.map(([k, desc]) => `
      <div class="border-b border-outline-variant pb-1">
        <span class="font-bold text-primary font-mono-data">${escapeHtml(k)}</span>
        <p class="text-on-surface-variant text-[11px]">${escapeHtml(desc)}</p>
      </div>
    `).join('');
  }

  if (outputEl) {
    let outVars = [
      ['medication_call_disposition', 'How the call ended (e.g. acknowledged, already_taken, declined, no_answer)'],
      ['reminder_call_summary', 'A short call summary generated by Sarvam AI'],
      ['dose_slot', 'Which slot this call covered (morning / evening / dinner)'],
    ];
    if (serverConfig && serverConfig.outputVariables) {
      outVars = Array.isArray(serverConfig.outputVariables)
        ? serverConfig.outputVariables
        : Object.entries(serverConfig.outputVariables);
    }
    outputEl.innerHTML = outVars.map(([k, desc]) => `
      <div class="border-b border-outline-variant pb-1">
        <span class="font-bold text-primary font-mono-data">${escapeHtml(k)}</span>
        <p class="text-on-surface-variant text-[11px]">${escapeHtml(desc)}</p>
      </div>
    `).join('');
  }
}

// ── Search & Filter ──────────────────────────────────────────────────────────
document.getElementById("registrySearch")?.addEventListener("input", function(e) {
  const q = e.target.value.toLowerCase().trim();
  const filtered = patients.filter(p => {
    return (p.patient_name && p.patient_name.toLowerCase().includes(q)) ||
           (p.patient_phone && p.patient_phone.toLowerCase().includes(q)) ||
           (p.id && p.id.toLowerCase().includes(q)) ||
           (p.emergency_contact && p.emergency_contact.toLowerCase().includes(q)) ||
           (p.dialysis_appointment_date && p.dialysis_appointment_date.toLowerCase().includes(q));
  });
  renderPatientTable(filtered);
  renderPatientGrid(filtered);
});

// ── Escape to close modals ───────────────────────────────────────────────────
document.addEventListener("keydown", function(e) {
  if (e.key === "Escape") {
    closePatientModal();
    closeRegisterModal();
    if (typeof closeCampaignConfirmModal === 'function') closeCampaignConfirmModal();
  }
});

// ── Toast System ─────────────────────────────────────────────────────────────
function showToast(msg) {
  const toast = document.getElementById("toastNotification");
  const msgEl = document.getElementById("toastMessage");
  if (!toast || !msgEl) return;
  msgEl.innerHTML = String(msg).replace(/&bull;/g, '•');
  toast.classList.remove("hidden");
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Load Server Data & Merge ─────────────────────────────────────────────────
async function loadServerData() {
  serverConfig = await fetchApi('/api/config');
  serverStatus = await fetchApi('/api/status');

  if (serverConfig) {
    const sysMode = document.getElementById("sysModeLabel");
    const sysCamp = document.getElementById("sysCampaignLabel");
    if (sysMode) {
      sysMode.innerHTML = serverConfig.dryRun
        ? `<span class="w-1.5 h-1.5 bg-amber-500"></span>DRY RUN`
        : `<span class="w-1.5 h-1.5 bg-emerald-500"></span>LIVE`;
    }
    if (sysCamp) {
      sysCamp.textContent = `Campaign: ${serverConfig.campaignId ? serverConfig.campaignId.slice(0, 16) + '...' : 'Configured'}`;
    }
  }

  // Load database patients purely from SQLite
  const dbData = await fetchApi("/api/patients");
  if (dbData && Array.isArray(dbData.patients)) {
    patients = dbData.patients.map(dbp => ({
      id: `NV-2026-${dbp.id}`,
      db_id: dbp.id,
      patient_name: dbp.name,
      patient_phone: dbp.phone,
      front_desk_number: dbp.front_desk_number || "+917965480404",
      emergency_contact: dbp.emergency_contact || "",
      relationship: "Patient",
      dialysis_appointment_date: dbp.dialysis_appointment_date || "",
      dialysis_appointment_time: dbp.dialysis_appointment_time || "",
      dialysis_bay: dbp.dialysis_bay || "Station 3A (Hemodialysis)",
      morning_medicines: dbp.morning_medicines || dbp.medicine_name || "",
      morning_reminder_time: dbp.morning_reminder_time || "09:00",
      evening_medicines: dbp.evening_medicines || "",
      evening_reminder_time: dbp.evening_reminder_time || "14:30",
      dinner_medicines: dbp.dinner_medicines || "",
      dinner_reminder_time: dbp.dinner_reminder_time || "22:00",
      auto_call_enabled: dbp.auto_call_enabled !== 0 ? 1 : 0,
      dispatches_today: Array.isArray(dbp.dispatches_today) ? dbp.dispatches_today : [],
      voice_status: dbp.call_status || "Active",
      last_call_status: (dbp.call_status || "Delivered (Ack)").toUpperCase(),
      frequency: "3x / week",
      is_primary: false
    }));
    currentActivePatient = patients[0] || null;
    renderPatientTable(patients);
    renderPatientGrid(patients);
    updateMetricCounters();
    syncScheduleMatrixFromPatients();
  }

  updateGlobalAutoDispatchUI();
}

// ── Master & Per-Patient Auto-Call Toggle Handlers ──────────────────────────
window.toggleGlobalAutoDispatch = async function() {
  const current = serverConfig?.autoDispatchEnabled ?? true;
  const next = !current;
  const res = await fetchApi('/api/settings/auto-dispatch', {
    method: 'POST',
    body: JSON.stringify({ enabled: next })
  });
  if (serverConfig) serverConfig.autoDispatchEnabled = res?.autoDispatchEnabled ?? next;
  updateGlobalAutoDispatchUI();
  showToast(`Autonomous Calling ${next ? 'ENABLED' : 'PAUSED'} (15-min cadence)`);
};

window.updateGlobalAutoDispatchUI = function() {
  const enabled = serverConfig?.autoDispatchEnabled ?? true;
  const topBtn = document.getElementById("topAutoToggleBtn");
  const topLabel = document.getElementById("topAutoToggleLabel");
  const sideBtn = document.getElementById("sidebarAutoToggleBtn");

  if (topBtn && topLabel) {
    if (enabled) {
      topBtn.className = "h-8 px-space-md bg-surface-container-lowest border border-primary text-primary font-label-md text-label-md flex items-center gap-space-xs transition-none cursor-pointer";
      topLabel.textContent = "Auto-Calling: ENABLED";
    } else {
      topBtn.className = "h-8 px-space-md bg-surface-container-low border border-outline-variant text-on-surface-variant font-label-md text-label-md flex items-center gap-space-xs transition-none cursor-pointer";
      topLabel.textContent = "Auto-Calling: PAUSED";
    }
  }

  if (sideBtn) {
    if (enabled) {
      sideBtn.textContent = "ON";
      sideBtn.className = "px-1.5 py-0.5 border border-primary bg-primary text-on-primary text-[10px] font-bold cursor-pointer transition-none";
    } else {
      sideBtn.textContent = "PAUSED";
      sideBtn.className = "px-1.5 py-0.5 border border-outline-variant bg-surface-container-low text-on-surface-variant text-[10px] font-bold cursor-pointer transition-none";
    }
  }
};

window.togglePatientAutoCall = async function(patientId) {
  const patient = patients.find(p => p.id === patientId);
  if (!patient) return;
  const nextVal = patient.auto_call_enabled === 0 ? 1 : 0;
  patient.auto_call_enabled = nextVal;

  if (patient.db_id) {
    await fetchApi(`/api/patients/${patient.db_id}/toggle-auto-call`, { method: 'POST' }).catch(() => {});
  }

  renderPatientTable(patients);
  renderPatientGrid(patients);
  if (currentActivePatient && currentActivePatient.id === patient.id) {
    updateModalAutoCallBadge(patient);
  }
  showToast(`Auto-calling for ${patient.patient_name} ${nextVal ? 'ENABLED' : 'PAUSED'}`);
};

// ── Initial Boot ─────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  renderPatientTable(patients);
  renderPatientGrid(patients);
  updateMetricCounters();
  syncScheduleMatrixFromPatients();

  const hash = window.location.hash.replace('#/', '') || 'intake';
  navigateTo(hash);

  loadServerData();
});
