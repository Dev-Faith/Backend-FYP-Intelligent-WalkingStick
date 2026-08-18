# MQTT, queue and push safety pipeline

This document explains the seven infrastructure steps that turn a device event into a durable caregiver notification.

## 1. Connect NestJS to MQTT

`MqttIngestService` connects to `MQTT_URL`, reconnects automatically, and subscribes at QoS 1 to:

```text
wakatech/v1/devices/+/events/#
wakatech/v1/devices/+/telemetry/heartbeat
```

Why: MQTT is designed for constrained and intermittently connected devices. QoS 1 gives at-least-once transfer, which is appropriate for safety events as long as the consumer is idempotent.

## 2. Authenticate devices and topics

Each device has an immutable hardware ID and a unique credential hash in Neon. MQTT application messages contain an authentication timestamp and HMAC signature over the exact envelope. The consumer verifies:

- Topic hardware ID matches `envelope.deviceId`
- The device exists and has an active credential
- Authentication timestamp is within five minutes
- Signature matches with a timing-safe comparison
- Payload is below 16 KiB
- DTO fields and schema version are valid

Why: a public hardware ID is not proof of identity. The checks prevent one stick from publishing as another and reject tampered messages. Production must additionally use TLS, per-device broker credentials and topic ACLs; application HMAC is defense in depth.

## 3. Reuse the idempotent ingest domain

Authenticated MQTT messages call `IngestService.ingestTrusted`. HTTPS simulator messages still call the API-key boundary, but both transports converge on the same transaction and uniqueness constraints.

Why: transport code must not duplicate safety behavior. One ingest path ensures heartbeat, fall and activity rules behave identically and QoS 1 redelivery does not duplicate events.

## 4. Use Redis and BullMQ

The `fall-alert-delivery` BullMQ queue persists work in Redis. Jobs have deterministic IDs, five attempts, exponential backoff and retained success/failure history.

Why: an urgent device-ingest transaction must not wait on Expo. Redis preserves pending work across API restarts and absorbs temporary provider outages or traffic bursts.

## 5. Dispatch the transactional outbox

Fall creation and an `Outbox` row occur in the same Neon transaction. `OutboxDispatcher` atomically claims pending rows, enqueues deterministic BullMQ jobs, and marks them processed only after Redis accepts the job. Failed enqueue attempts return the row to pending.

Why: this closes the failure gap between “fall saved” and “notification queued.” A crash cannot silently lose a persisted fall merely because the push call had not started.

## 6. Send Expo pushes and check receipts

`FallPushWorker`:

1. Reloads the persisted fall.
2. Resolves currently authorized caregivers and enabled installations.
3. Creates one `PushDispatch` per fall, installation and dispatch revision.
4. Builds the exact frontend-compatible v2 payload.
5. Sends it to Expo and stores the ticket.
6. Schedules a receipt check after 15 minutes by default.
7. Stores the receipt and disables `DeviceNotRegistered` installations.

Transient queue jobs retry with exponential backoff. An Expo ticket means only “provider accepted”; the receipt records whether FCM/APNs accepted it. Neither proves that a human saw the alert—caregiver acknowledgement and resolution remain separate durable states.

Why: pushes are best-effort attention signals, not the source of truth. Ticket/receipt tracking makes provider failures visible while REST history restores missed alerts.

## 7. Check every critical dependency

`GET /v1/health/ready` verifies:

- Neon is reachable and the migrated schema exists
- BullMQ can connect to Redis
- The MQTT consumer is connected

Why: a process that serves HTTP but cannot ingest stick events or queue alerts is not ready to receive production traffic.

Runtime and seed database access use the Neon serverless Prisma adapter over HTTP/WebSockets. This avoids relying on outbound TCP 5432, which is blocked by some campus, mobile and corporate networks.

## Local verification

Add a unique seeded-device secret to `.env`, then reprovision the seed:

```dotenv
SEEDED_DEVICE_SECRET="a-strong-unique-random-value"
MQTT_URL=mqtt://localhost:1883
REDIS_URL=redis://localhost:6379
```

```powershell
npm run seed
npm run start:dev
```

In another terminal:

```powershell
Invoke-RestMethod http://localhost:3000/v1/health/ready
npm run simulator -- mqtt-heartbeat
npm run simulator -- mqtt-activity
npm run simulator -- mqtt-fall
```

Falls are persisted even when setup is incomplete. Without a primary contact, the event snapshots `No emergency contact configured` / `Not set` rather than discarding a safety event. Actual push delivery requires an enabled Expo installation registered through `POST /v1/notification-installations`.

## Production gaps

- Local Mosquitto currently allows anonymous connections; never expose it publicly.
- Configure broker TLS, unique usernames/certificates and topic ACLs before real hardware deployment.
- Use authenticated Redis with private networking in production.
- Run worker and ingest processes independently when scaling beyond the FYP deployment.
- Add monitoring for queue depth, failed jobs, outbox age, MQTT disconnects and receipt errors.
