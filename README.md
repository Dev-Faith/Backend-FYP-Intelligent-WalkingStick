# Wakatech Backend

Backend API for **Wakatech**, a caregiver application connected to an intelligent walking stick. The service authenticates caregivers, controls access to physical sticks, persists emergency contacts, accepts device telemetry, records fall alerts and activity, and exposes durable state to the Expo mobile application.

> Current maturity: functional FYP backend and frontend-integration baseline. It is not yet a production emergency-response platform. See [Implementation status](#implementation-status).

## What works

- Caregiver registration, login, logout and onboarding
- Short-lived JWT access tokens
- Hashed refresh tokens with rotation and replay-family revocation
- Neon PostgreSQL persistence through Prisma
- One-time device claiming and caregiver/device authorization
- Durable primary emergency contacts
- Notification-installation registration
- Walking-stick heartbeat and cloud status
- Idempotent fall, activity and walk-session ingestion
- Durable fall history, acknowledgement and resolution
- Transactional fall-event/outbox creation
- Walking-stick activity snapshots
- Exact Expo `FALL_ALERT` v2 push-payload builder
- Swagger, migrations, seed data, health checks and a device simulator

## System boundaries

```text
Expo caregiver app
        |
        | HTTPS + caregiver JWT
        v
Wakatech NestJS API --------> Neon PostgreSQL
        ^                         users, devices, contacts,
        |                         falls, activity, audit, outbox
        |
        | authenticated device events
Intelligent walking stick
```

- BLE provisioning happens directly between the phone and stick.
- Wi-Fi passwords must never pass through this backend.
- A BLE connection does not mean the stick is cloud-online.
- Fall locations are time-stamped reported points, not live tracking.
- Step activity belongs to the stick user, never the caregiver’s phone.
- Push notifications attract attention; REST and Neon remain the durable source of truth.

## Technology

- Node.js and TypeScript
- NestJS 11
- Prisma 6
- Neon serverless Prisma adapter for runtime/seed connectivity over HTTP/WebSockets
- Neon serverless PostgreSQL
- Argon2id-compatible password hashing
- Jest
- Redis/BullMQ delivery queue and Mosquitto MQTT device ingest

## Prerequisites

- Node.js 22 LTS recommended
- npm
- A [Neon](https://neon.com/) project
- PowerShell examples below assume Windows
- Docker Desktop for the Redis delivery queue and local MQTT broker

## Quick start with Neon

### 1. Install dependencies

```powershell
cd C:\Users\USER\Desktop\codeProjects\FYP\Backend
npm install
```

### 2. Configure the environment

```powershell
Copy-Item .env.example .env
```

From Neon’s **Connect** dialog, obtain:

- A pooled connection string whose hostname contains `-pooler`
- A direct connection string whose hostname does not contain `-pooler`

Configure `.env`:

```dotenv
NODE_ENV=development
PORT=3000

# Runtime connection; hostname contains -pooler
DATABASE_URL="postgresql://USER:PASSWORD@HOST-pooler.REGION.aws.neon.tech/neondb?sslmode=require"

# Migration connection; hostname does not contain -pooler
DIRECT_URL="postgresql://USER:PASSWORD@HOST.REGION.aws.neon.tech/neondb?sslmode=require"

JWT_SECRET="GENERATE_A_RANDOM_SECRET"
JWT_ISSUER=wakatech-api
JWT_AUDIENCE=wakatech-mobile
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_DAYS=30

DEVICE_INGEST_KEY="GENERATE_A_DIFFERENT_RANDOM_SECRET"
SEEDED_DEVICE_SECRET="GENERATE_A_UNIQUE_DEVICE_SECRET"
REDIS_URL=redis://localhost:6379
MQTT_URL=mqtt://localhost:1883
EXPO_ACCESS_TOKEN=
EXPO_RECEIPT_DELAY_MS=900000
OUTBOX_POLL_MS=2000
ONLINE_AFTER_SECONDS=120
STALE_AFTER_SECONDS=600
```

Generate each secret separately:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Never commit `.env`, expose database URLs through `EXPO_PUBLIC_*`, or share screenshots containing credentials. If a credential is exposed, rotate it immediately.

### 3. Generate Prisma and initialize Neon

```powershell
npm run prisma:generate
npm run db:deploy
npm run seed
```

The seed creates a development stick:

```text
Hardware ID: WK-2026-000042
Claim code:   WAKA-2026
```

The claim code is local test data. Production devices require unique manufacturing identities, unique telemetry credentials and one-time claim proofs.

### 4. Start the API

```powershell
npm run start:dev
```

Useful URLs:

| Resource | URL |
|---|---|
| Swagger | `http://localhost:3000/v1/docs` |
| Liveness | `http://localhost:3000/v1/health/live` |
| Readiness | `http://localhost:3000/v1/health/ready` |

Readiness verifies the database connection and that the migrated `User` table exists:

```powershell
Invoke-RestMethod http://localhost:3000/v1/health/ready
```

Expected:

```text
status   : ready
database : up
schema   : migrated
```

## End-to-end smoke test

Keep `npm run start:dev` running and use a second PowerShell terminal.

### Register

```powershell
$email = "caregiver-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())@example.com"

$registration = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/v1/auth/register `
  -ContentType application/json `
  -Body (@{
    email = $email
    password = "SecurePass123!"
  } | ConvertTo-Json)

$token = $registration.accessToken
$refreshToken = $registration.refreshToken
$headers = @{ Authorization = "Bearer $token" }
$registration
```

The response must contain `accessToken`, `refreshToken`, `user`, and `onboardingComplete: false` without a wrapper object.

### Complete onboarding and rotate the refresh token

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/v1/auth/onboarding/complete `
  -Headers $headers

$refreshed = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/v1/auth/refresh `
  -ContentType application/json `
  -Body (@{ refreshToken = $refreshToken } | ConvertTo-Json)

$token = $refreshed.accessToken
$refreshToken = $refreshed.refreshToken
$headers = @{ Authorization = "Bearer $token" }
$refreshed
```

`onboardingComplete` should now be `true`. The old refresh token should no longer be used.

### Claim the seeded stick

```powershell
$claim = Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/v1/devices/claim `
  -Headers $headers `
  -ContentType application/json `
  -Body (@{
    hardwareId = "WK-2026-000042"
    claimCode = "WAKA-2026"
    displayName = "Test walking stick"
  } | ConvertTo-Json)

$deviceId = $claim.device.id
$claim
```

Claim codes are one-time. Reusing the seeded database after a successful claim will correctly return `409 Conflict`.

### Save the primary contact

```powershell
Invoke-RestMethod `
  -Method Put `
  -Uri "http://localhost:3000/v1/devices/$deviceId/emergency-contact" `
  -Headers $headers `
  -ContentType application/json `
  -Body (@{
    fullName = "Amina Yusuf"
    phoneNumber = "+2348012345678"
    relationship = "Family"
  } | ConvertTo-Json)
```

### Simulate the stick

The simulator loads `DEVICE_INGEST_KEY` from `.env` automatically:

```powershell
npm run simulator -- heartbeat
npm run simulator -- activity
npm run simulator -- fall
npm run simulator -- mqtt-heartbeat
npm run simulator -- mqtt-activity
npm run simulator -- mqtt-fall
npm run simulator:settings
```

`simulator:settings` behaves like the Raspberry Pi: it subscribes to the retained
settings command, verifies the backend HMAC, applies the command and publishes a
signed `settings.applied` acknowledgement. See
[`docs/RASPBERRY_PI_MQTT.md`](docs/RASPBERRY_PI_MQTT.md) for the hardware contract.

Each successful ingest returns HTTP `202`:

```json
{"accepted":true,"duplicate":false}
```

A primary emergency contact should exist before simulating a fall. If setup is incomplete, the backend still persists the safety event and uses an explicit not-configured contact snapshot rather than discarding it.

### Read the resulting state

```powershell
Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/devices/$deviceId/status" `
  -Headers $headers

Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/devices/$deviceId/activity/snapshot" `
  -Headers $headers

$alerts = Invoke-RestMethod `
  -Uri "http://localhost:3000/v1/devices/$deviceId/fall-alerts" `
  -Headers $headers

$alertId = $alerts.items[0].id
$alerts.items
```

### Acknowledge and resolve the fall

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/v1/fall-alerts/$alertId/acknowledge" `
  -Headers $headers `
  -ContentType application/json `
  -Body '{}'

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/v1/fall-alerts/$alertId/resolve" `
  -Headers $headers `
  -ContentType application/json `
  -Body '{"resolution":"confirmed_safe"}'
```

Repeated acknowledgement or resolution requests are safe and return the current event state.

## Connect the Expo frontend

For an Android emulator, the host is commonly `10.0.2.2`. For a physical phone, use the computer’s LAN address:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object {
    $_.IPAddress -notlike "127.*" -and
    $_.IPAddress -notlike "169.254*" -and
    $_.InterfaceAlias -notlike "*Loopback*"
  } |
  Select-Object InterfaceAlias, IPAddress
```

Set the frontend environment variable:

```dotenv
EXPO_PUBLIC_API_URL=http://192.168.1.105:3000/v1
```

Replace the sample IP with the active Wi-Fi/Ethernet address. The phone and computer must be on the same network. Test from the phone browser:

```text
http://192.168.1.105:3000/v1/health/live
```

If it cannot connect, allow Node.js or inbound TCP port `3000` through Windows Firewall and check that the Wi-Fi does not use client/AP isolation.

## API overview

All routes are under `/v1`.

| Area | Method and route | Authentication |
|---|---|---|
| Health | `GET /health/live` | Public |
| Health | `GET /health/ready` | Public |
| Auth | `POST /auth/register` | Public |
| Auth | `POST /auth/login` | Public |
| Auth | `POST /auth/refresh` | Refresh token |
| Auth | `POST /auth/logout` | Refresh token; bearer optional |
| Auth | `POST /auth/forgot-password` | Public |
| Auth | `POST /auth/onboarding/complete` | Bearer |
| User | `GET /me` | Bearer |
| User | `GET /me/bootstrap` | Bearer |
| Device | `POST /devices/claim` | Bearer |
| Device | `GET /devices` | Bearer |
| Device | `GET /devices/:id` | Bearer + access |
| Device | `GET /devices/:id/status` | Bearer + access |
| Contact | `GET/PUT/DELETE /devices/:id/emergency-contact` | Bearer + access |
| Settings | `GET/PATCH /devices/:id/safety-settings` | Bearer + access |
| Activity | `GET /devices/:id/activity/snapshot` | Bearer + access |
| Alerts | `GET /devices/:id/fall-alerts` | Bearer + access |
| Alerts | `GET /fall-alerts/:id` | Bearer + access |
| Alerts | `POST /fall-alerts/:id/acknowledge` | Bearer + access |
| Alerts | `POST /fall-alerts/:id/resolve` | Bearer + access |
| Push registration | `POST /notification-installations` | Bearer |
| Device ingest | `POST /device-ingest/events` | `X-Device-Key` |

Swagger provides the authoritative interactive route listing for the running build.

## Authentication model

- Passwords are normalized by email and hashed with Argon2.
- Access tokens are signed JWTs and default to a 15-minute lifetime.
- Refresh tokens are high-entropy random values.
- Only refresh-token hashes are stored in Neon.
- Refreshing rotates the token.
- Replaying a rotated token revokes its session family.
- Logout is idempotent and supports refresh-token-only revocation.
- Onboarding completion is durable and returned by future login/refresh responses.

Never log or store plaintext passwords, access tokens, refresh tokens or reset tokens.

## Device claiming

Claiming establishes durable authorization between a caregiver and a physical stick:

1. The backend already knows the device’s immutable `hardwareId`.
2. A one-time, expiring claim code is stored only as a hash.
3. An authenticated caregiver submits the hardware ID and code.
4. The backend validates both, marks the code used, records `claimedAt`, creates `DeviceAccess`, and writes an audit event in one transaction.

A BLE identifier is not proof of ownership and is never treated as the permanent device identity.

## Device ingest and idempotency

The current working transport is HTTPS with `X-Device-Key`. Supported event types are:

- `device.heartbeat`
- `fall.opened`
- `activity.checkpoint`
- `walk-session.completed`

Messages deduplicate on `(deviceId, messageId)`. Falls additionally deduplicate on `(deviceId, fallEventId)`. Escalating an existing fall from `high` to `critical` increments its dispatch revision instead of creating a second event.

The shared ingest key is suitable only for local/FYP integration. Production firmware requires unique device credentials, TLS and scoped MQTT/HTTPS authorization.

## Data and migrations

Schema: [`prisma/schema.prisma`](prisma/schema.prisma)

Initial migration: [`prisma/migrations/20260816000000_init/migration.sql`](prisma/migrations/20260816000000_init/migration.sql)

Common commands:

```powershell
npm run prisma:generate   # Regenerate Prisma Client
npm run db:deploy         # Apply committed migrations
npm run db:migrate        # Create a development migration after schema changes
npm run seed              # Provision the local test stick and claim code
```

Use `db:deploy` for existing migrations. Use `db:migrate` only while intentionally developing a schema change.

The API and seed command use Neon's serverless Prisma adapter, so they continue to work on networks that block outbound PostgreSQL TCP port 5432. Prisma migrations are administrative operations and may still require direct database connectivity; run them from a network or CI environment that can reach Neon when necessary.

## Available scripts

| Script | Purpose |
|---|---|
| `npm run start` | Start NestJS |
| `npm run start:dev` | Start in watch mode |
| `npm run build` | Compile the application |
| `npm test` | Run Jest tests |
| `npm run format` | Format TypeScript, JSON and Prisma files |
| `npm run prisma:generate` | Generate Prisma Client |
| `npm run db:deploy` | Apply committed migrations |
| `npm run db:migrate` | Create/apply a development migration |
| `npm run seed` | Seed the development device |
| `npm run simulator -- heartbeat` | Send a heartbeat |
| `npm run simulator -- activity` | Send an activity checkpoint |
| `npm run simulator -- fall` | Send a fall event |
| `npm run simulator -- mqtt-heartbeat` | Publish an authenticated MQTT heartbeat |
| `npm run simulator -- mqtt-activity` | Publish an authenticated MQTT activity checkpoint |
| `npm run simulator -- mqtt-fall` | Publish an authenticated MQTT fall event |

## Docker services

Neon replaces the local PostgreSQL container. The HTTP API can still run without Docker, but MQTT ingest and queued push delivery require Redis and Mosquitto.

`docker-compose.yml` defines Redis for BullMQ and Mosquitto for MQTT device ingest. Start them with `docker compose up -d redis mqtt`. Mosquitto permits anonymous local connections and must never be exposed publicly or used unchanged in production.

## Testing

Run the current automated checks:

```powershell
npm run build
npm test
```

The current test suite validates the exact Expo fall-push v2 structure, Android channel `fall-alerts-v3`, and the 4 KiB provider-size guard. The end-to-end smoke test above validates Neon and the major HTTP workflows manually.

Additional automated integration and end-to-end coverage is still required for production readiness.

## Troubleshooting

### `Service temporarily unavailable` during registration

Confirm readiness and migration state:

```powershell
Invoke-RestMethod http://localhost:3000/v1/health/ready
npx prisma migrate status
```

Readiness must include `schema: migrated`.

### `Cannot find module '../generated/prisma'`

Regenerate the standard client and restart:

```powershell
npm run prisma:generate
npm run build
npm run start:dev
```

### Prisma migration cannot reach Neon

Verify that `DIRECT_URL` contains the real Neon region and does not contain either the literal word `REGION` or `-pooler`.

### `409 Conflict` when claiming

The one-time claim code was invalid, expired or already used. Seeding does not transfer an already-claimed device to another caregiver.

### Simulator returns `401`

Restart the simulator after updating `.env` and ensure `DEVICE_INGEST_KEY` is not the example placeholder.

### Phone cannot reach the API

- Use the computer’s LAN IP instead of `localhost`.
- Keep Nest running on port `3000`.
- Put the phone and computer on the same network.
- Allow Node.js/port `3000` through Windows Firewall.

## Security and privacy

- Never accept, persist or log Wi-Fi credentials.
- Never expose Neon or device-ingest secrets to Expo.
- Every caregiver device/contact/alert/activity operation checks object-level access.
- Fall events snapshot the primary contact so later edits do not rewrite history.
- Precise locations, phone numbers and safety events are sensitive data.
- The public error envelope intentionally hides unexpected internal failures.
- Rotate every secret visible in screenshots, logs or repository history.
- Use HTTPS, managed secret storage, database backups and production observability before public deployment.

## Implementation status

| Capability | Status |
|---|---|
| Neon database, schema and migrations | Working |
| Auth compatibility and refresh rotation | Working |
| Onboarding persistence | Working |
| Device claims and authorization | Working |
| Primary emergency contact | Working |
| HTTPS heartbeat/fall/activity ingest | Working FYP baseline |
| Durable fall history and lifecycle | Working |
| Activity snapshot | Working baseline |
| Notification-installation persistence | Working |
| Exact Expo v2 payload builder | Working and tested |
| Authenticated MQTT ingest | Working local/FYP baseline |
| Transactional outbox and Redis/BullMQ retries | Working |
| Expo delivery worker, tickets and receipts | Implemented; real token required for live verification |
| Password-reset email delivery/completion | Not implemented |
| MQTT TLS and broker topic ACLs | Not implemented |
| Distributed rate limiting | Not implemented |
| Firmware settings command acknowledgements | Not implemented |
| Comprehensive automated E2E tests | Not implemented |
| Production metrics, alerts, backups and runbooks | Not implemented |

Do not represent end-device push delivery, production MQTT security or automatic emergency response as guaranteed. Expo tickets and receipts have distinct meanings, and caregiver acknowledgement remains the durable human-action signal.

## Architecture decisions

See [`docs/ADR-001-foundation.md`](docs/ADR-001-foundation.md) for the accepted foundation and remaining hardware/provider decisions.

See [`docs/SAFETY_PIPELINE.md`](docs/SAFETY_PIPELINE.md) for the seven-step MQTT, outbox, queue and Expo delivery pipeline.

## License

No license has been selected. Add one before distributing the project outside its intended academic context.
