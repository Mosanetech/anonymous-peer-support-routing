# Deployment Guide

This app can run as one Node.js service. The server serves both the built React app from `dist/` and the API routes from `server.js`.

## Required Environment

Set these variables in the hosting dashboard:

```text
NODE_ENV=production
HOST=0.0.0.0
PORT=<provided by host, or 4020>
DB_PATH=<persistent disk path>/db.json
ALLOWED_ORIGINS=https://your-public-domain.example
```

Optional tuning:

```text
GROUP_CAPACITY=5
GROUP_LIFETIME_MINUTES=90
BODY_LIMIT_BYTES=16384
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=80
THERAPIST_ACCOUNTS=[{"id":"therapist-1","name":"Dr. Your Therapist Name","username":"therapist1","password":"change-this-password"}]
```

`ALLOWED_ORIGINS` must be an exact origin only: protocol plus domain, no path and no trailing slash. Example:

```text
ALLOWED_ORIGINS=https://anonymous-peer-support-routing.onrender.com
```

`THERAPIST_ACCOUNTS` is a JSON array. Add real support staff here before deployment. Example with two accounts:

```text
THERAPIST_ACCOUNTS=[{"id":"therapist-1","name":"Campus Counsellor","username":"counsellor","password":"use-a-strong-password"},{"id":"therapist-2","name":"ICT Therapist","username":"icttherapist","password":"use-another-strong-password"}]
```

## Node Host Deployment

Use these commands:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd start
```

Health check path:

```text
/health
```

## Docker Deployment

Build:

```powershell
docker build -t anonymous-peer-support-routing .
```

Run locally:

```powershell
docker run --rm -p 4020:4020 -e ALLOWED_ORIGINS=http://127.0.0.1:4020 -v peer-support-data:/app/data anonymous-peer-support-routing
```

## Production Requirements Before Student Use

The current deployment package is suitable for a private pilot or demonstration. Before using it with real students, complete these items:

- Replace JSON file storage with a managed database and backups.
- Add audited end-to-end encryption or a clearly documented server-side encryption policy.
- Add therapist/admin authentication, escalation ownership, and audit logs.
- Add abuse reporting, moderation, block lists, and spam controls.
- Define a crisis-response policy with trained staff, emergency contacts, and response-time commitments.
- Add monitoring, error logging, uptime alerts, and regular security review.
