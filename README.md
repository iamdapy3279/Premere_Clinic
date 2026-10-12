# Premere Clinic — Receptionist AI Voice Console

Receptionist console for Dr. Lalit Agarwal's clinic: patient registry, automated time-triggered medication & dialysis reminder calls via Sarvam AI, and real-time call telemetry.

---

## Quick Setup (Windows Clinic PC)

### 1. Requirements
* **Node.js v22.13+** (LTS) — uses native `node:sqlite` and built-in `.env` parsing. No external npm dependencies required.

### 2. Installation & Setup
1. Clone or copy this repository to the machine (recommended directory: `C:\premere-clinic`).
2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Fill in your Sarvam credentials in `.env`:
   * `SARVAM_API_KEY`
   * `SARVAM_ORG_ID`
   * `SARVAM_WORKSPACE_ID`
   * `SARVAM_APP_ID`
   * `SARVAM_APP_VERSION`
   * `SARVAM_CONNECTION_ID`
   * `SARVAM_AGENT_PHONE_NUMBER`
   * `SARVAM_DRY_RUN=false` (to enable live calls)

### 3. Running the Server
* **Option A (Double-Click Launcher):**
  Double-click `run-clinic.bat`. It will start the server and keep an auto-restart watchdog loop running.
* **Option B (Command Line):**
  ```bash
  npm start
  ```
  *(Runs `node --env-file-if-exists=.env server/index.js`)*

4. Open browser at: **`http://localhost:5173`**

---

## 30-Day Deployment Safeguards

1. **Zero Data Loss & Windows File Locking:**
   * Configured with `PRAGMA busy_timeout = 5000;` to prevent Windows Defender / antivirus lock collisions.
   * `PRAGMA journal_mode = WAL;` (Write-Ahead Logging) ensures crash resilience during unexpected power loss.
2. **Automated Daily Rolling Backups:**
   * Runs daily at midnight and on startup via `VACUUM INTO 'data/backups/clinic-YYYY-MM-DD.db'`.
   * Automatically flushes WAL and prunes backups older than 30 days.
3. **TRAI Calling Hours Window Clamp:**
   * Automated outbound calls are strictly clamped between **08:00 AM and 09:00 PM IST**.
   * Calls outside this window are skipped to prevent disturbing patients and avoid DND violations.
4. **Rate Limiting & Cooldowns:**
   * Sliding-window rate limiting on `/api/queue` (max 10 batch dispatches per 60 seconds).
   * 3-minute cooldown per patient to prevent accidental duplicate dials.
