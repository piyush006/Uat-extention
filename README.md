# UAT Session Tracker

A lightweight Chrome extension, Node.js backend, PostgreSQL storage, and QA dashboard for capturing recent UAT user activity when a tester reports an issue.

This is intentionally separate from API Tracker & Flow Runner. It does not include API replay, API flows, assertions, loop fire, or automation features.

## Architecture

- `extension/`: Chrome MV3 extension that auto-records only on configured UAT origins.
- `backend/`: Node.js + Express API using PostgreSQL.
- `dashboard/`: Simple authenticated QA dashboard served by the backend.

Data flow:

1. User opens a configured UAT domain.
2. Extension creates a session ID like `UAT-20260907-A8F21C`.
3. Content script records UI events, navigation, errors, and network activity in a rolling local buffer.
4. User clicks `Report Issue` in the extension popup.
5. Extension uploads recent buffered data to the backend.
6. Backend stores sessions, issues, events, and network events in PostgreSQL.
7. QA opens the dashboard and reviews timeline/network/error details.

## Folder Structure

```text
uat-session-tracker/
  extension/
    manifest.json
    background/
    content/
    injected/
    popup/
  backend/
    package.json
    .env.example
    src/
      database/
      routes/
      services/
      server.js
  dashboard/
    index.html
    styles.css
    app.js
  README.md
```

## Free PostgreSQL Credentials

You have three free options.

### Option 1: Local PostgreSQL

Install PostgreSQL on your machine and create a database:

```sql
create database uat_session_tracker;
```

Use:

```text
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/uat_session_tracker
DATABASE_SSL=false
```

### Option 2: Neon Free Postgres

1. Go to `https://neon.tech`.
2. Create a free account.
3. Create a new project.
4. Copy the connection string.
5. Paste it in `backend/.env` as `DATABASE_URL`.
6. Set:

```text
DATABASE_SSL=true
```

### Option 3: Supabase Free Postgres

1. Go to `https://supabase.com`.
2. Create a free project.
3. Open Project Settings -> Database.
4. Copy the connection string.
5. Paste it in `backend/.env` as `DATABASE_URL`.
6. Set:

```text
DATABASE_SSL=true
```

Do not paste database credentials into the Chrome extension. Only the backend uses `DATABASE_URL`.

## Backend Setup

```powershell
cd C:\Users\47Billion\Desktop\uat-session-tracker\backend
copy .env.example .env
npm install
npm run dev
```

Edit `backend/.env`:

```text
PORT=4010
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL=true
DATABASE_FORCE_IPV4=true
API_BASE_URL=http://localhost:4010
DASHBOARD_USER=change_me
DASHBOARD_PASSWORD=change_me
SESSION_RETENTION_MINUTES=15
```

The backend creates database tables automatically on startup.

Health check:

```text
http://localhost:4010/health
```

## Dashboard

Open:

```text
http://localhost:4010
```

Login:

```text
Username: value from DASHBOARD_USER
Password: value from DASHBOARD_PASSWORD
```

For production/internal server use, change the password in `.env`.

## Chrome Extension Setup

1. Open Chrome.
2. Go to:

```text
chrome://extensions
```

3. Enable Developer Mode.
4. Click `Load unpacked`.
5. Select:

```text
C:\Users\47Billion\Desktop\uat-session-tracker\extension
```

6. Open the extension popup.
7. Set:

```text
Backend URL: http://localhost:4010
Allowed UAT origins: https://your-uat-domain.com
Tester/User name: tester name or email
Capture tokens and cookies: off by default
Keep last activity for: 15
```

8. Save settings.
9. Refresh the UAT app page.

`Keep last activity for` means the extension keeps only the most recent clicks, errors, and API calls for that many minutes before the tester reports an issue.

## UAT User Flow

1. User opens configured UAT domain.
2. Tracking starts automatically.
3. User performs normal testing.
4. User clicks the extension icon.
5. User enters optional issue description.
6. User clicks `Report Issue`.
7. Extension uploads recent activity.
8. User sees an issue ID like `UAT-1042`.

## QA Flow

1. QA opens dashboard.
2. QA logs in.
3. QA sees issue list.
4. QA opens an issue.
5. QA reviews:
   - timeline
   - UI events
   - network/API calls
   - errors
   - browser/environment info

## Privacy And Security

- Recording only runs on configured UAT origins.
- Password fields are masked.
- Elements with `data-uat-mask="true"` are masked.
- Authorization, cookies, tokens, passwords, API keys, and secrets are masked by default.
- Turn on `Capture tokens and cookies` in the tracker only when QA explicitly needs to inspect raw auth values for a UAT report.
- Dashboard is protected with Basic Auth.
- Database credentials are backend-only.

## Known Limitations

- Phase 1 does not include rrweb session replay.
- Chrome extension popup cannot capture a screenshot without extra active tab handling.
- Some network response bodies may not be readable, especially streams, binary payloads, or browser-restricted responses.
- Console error capture is limited to window errors and unhandled promise rejections in Phase 1.

## Recommended Next Improvements

- Add rrweb replay.
- Add screenshot on report.
- Add configurable masking rules in the dashboard.
- Add dashboard filters/search.
- Add stronger dashboard authentication.
- Add issue assignment and comments.
