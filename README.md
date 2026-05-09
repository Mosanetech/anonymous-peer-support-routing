# Anonymous Peer-Support Routing

A React and Node.js prototype that routes students into anonymous temporary peer-support rooms called Vent Groups.

## Features

- Anonymous student sessions with generated identifiers.
- Topic-based routing into small Vent Groups.
- Temporary group sessions with automatic expiry.
- Anonymous group messaging using short polling.
- Safe Valve request flow for high-risk or professional-support situations.
- Therapist account login with a Safe Valve case queue.
- Private Safe Valve chat between a student and the assigned therapist.
- Local JSON storage for prototype data.

## Run Locally

Install dependencies:

```powershell
npm.cmd install
```

Start the backend API:

```powershell
npm.cmd run api
```

Start the React development server in a second terminal:

```powershell
npm.cmd run dev
```

Open:

```text
http://127.0.0.1:5173
```

## Build

```powershell
npm.cmd run build
```

After building, the Node server can serve both the API and the frontend:

```powershell
npm.cmd start
```

Open:

```text
http://127.0.0.1:4020
```

## API Routes

- `POST /api/session`
- `GET /api/me`
- `POST /api/groups/join`
- `GET /api/groups/current`
- `GET /api/groups/:id`
- `POST /api/groups/:id/messages`
- `POST /api/groups/:id/leave`
- `POST /api/safe-valve`
- `GET /api/safe-valve`

## Production Notes

See [DEPLOYMENT.md](./DEPLOYMENT.md) for environment variables, Docker deployment, and production hardening requirements.

This deployment package includes security headers, controlled CORS, request limits, rate limiting, and a health endpoint. Before using it with real students, replace local JSON storage with a managed database, add therapist/admin roles, add audited encryption, and define a staffed crisis-response policy.
