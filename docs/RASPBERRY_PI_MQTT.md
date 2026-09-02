# Wakatech Raspberry Pi Hardware Team Handover

**Document version:** 1.0  
**Device protocol:** 1  
**Target:** Raspberry Pi intelligent walking stick  
**Backend:** NestJS, MQTT, Neon PostgreSQL, Redis/BullMQ

## 1. Purpose and ownership

This is the single handover contract for building and connecting the Raspberry Pi
walking stick. The Pi normally communicates through MQTT; it must not call
caregiver endpoints such as login, device claim, contacts, alerts or push-token
registration.

```text
Sensors/GPS/buttons -> Raspberry Pi -> MQTT broker -> Wakatech backend
                                                 -> Neon/Redis -> caregiver app
Raspberry Pi <- retained settings command <- MQTT broker <- backend
```

Hardware owns sensor sampling, calibration, fall detection, false-alarm handling,
local feedback, GPS, battery measurement, local persistence and MQTT transport.
The backend owns device authentication, cloud persistence, caregiver access,
settings versions, alert lifecycle and push delivery.

## 2. Current status and production blockers

Already implemented:

- Signed MQTT heartbeat, fall, activity and walk-session ingestion.
- Per-device HMAC, topic/device identity checks and 16 KiB payload limit.
- QoS 1 consumption and idempotency using `messageId`/`fallEventId`.
- Retained, signed safety-settings commands.
- Signed, version-checked settings acknowledgements.
- `pending`, `synced` and `failed` settings states.
- Automatic republishing of pending settings after backend MQTT reconnect.

Must be completed before production:

- Replace anonymous local MQTT/port 1883 with TLS on 8883.
- Add unique broker credentials or certificates and per-device topic ACLs.
- Add a signed backend acknowledgement proving a fall was durably stored. MQTT
  PUBACK proves only broker receipt.
- Implement fleet credential provisioning, rotation and revocation.
- Implement signed OTA updates, staged rollout and rollback.

## 3. Per-device provisioning

Every physical stick requires unique values:

| Value | Purpose | Secret? |
| --- | --- | --- |
| `hardwareId` | Permanent identity, e.g. `WK-2026-000042` | No |
| `deviceSecret` | Application HMAC authentication | Yes |
| `claimCode` | One-time caregiver/device association | Yes until used |
| MQTT username/password or client certificate | Broker authentication | Yes |
| Broker hostname/CA | TLS connection and verification | CA is public |

Never clone one device secret into the fleet. Never put Neon, JWT, Redis, Expo,
Firebase Admin or another device's credentials on the Pi. The claim code is not
an MQTT credential and must never be used as the HMAC secret.

Development seed only:

```text
hardwareId: WK-2026-000042
claimCode:  WAKA-2026
deviceSecret: backend .env value SEEDED_DEVICE_SECRET
```

Suggested production configuration:

```dotenv
WAKATECH_HARDWARE_ID=WK-2026-000042
WAKATECH_DEVICE_SECRET=UNIQUE_RANDOM_SECRET
WAKATECH_MQTT_HOST=mqtt.example.com
WAKATECH_MQTT_PORT=8883
WAKATECH_MQTT_USERNAME=WK-2026-000042
WAKATECH_MQTT_PASSWORD=UNIQUE_BROKER_PASSWORD
WAKATECH_MQTT_CA=/etc/wakatech/ca.pem
WAKATECH_FIRMWARE_VERSION=1.0.0
WAKATECH_PROTOCOL_VERSION=1
```

```bash
sudo install -o root -g wakatech -m 0640 device.env /etc/wakatech/device.env
```

## 4. MQTT connection and ACL

Production connection: `mqtts://mqtt.example.com:8883`.

Requirements:

- Verify CA and broker hostname; never disable TLS verification.
- Use a unique broker identity and client ID `wakatech-stick-{hardwareId}`.
- Keepalive approximately 60 seconds.
- Reconnect using exponential backoff plus jitter.
- QoS 1 for all topics.
- Subscribe to settings immediately after connecting.
- Do not retain telemetry or events.
- Maximum complete MQTT payload: 16,384 bytes.

From a Pi during local development, use the developer computer's LAN IP on 1883.
`localhost` on the Pi means the Pi itself.

Allow only the exact device namespace:

| Direction | Topic | Retained |
| --- | --- | --- |
| Publish | `wakatech/v1/devices/{hardwareId}/telemetry/heartbeat` | No |
| Publish | `wakatech/v1/devices/{hardwareId}/events/fall` | No |
| Publish | `wakatech/v1/devices/{hardwareId}/events/activity` | No |
| Publish | `wakatech/v1/devices/{hardwareId}/events/walk-session` | No |
| Publish | `wakatech/v1/devices/{hardwareId}/events/settings-applied` | No |
| Subscribe | `wakatech/v1/devices/{hardwareId}/commands/settings` | Yes |

All use QoS 1. Deny access to every other device namespace.

## 5. Standard event envelope

All Pi-to-backend events use:

```json
{
  "schemaVersion": 1,
  "messageId": "unique-message-uuid",
  "deviceId": "WK-2026-000042",
  "eventType": "device.heartbeat",
  "occurredAt": "2026-08-27T10:00:00.000Z",
  "sequence": 101,
  "bootId": "unique-boot-uuid",
  "firmwareVersion": "1.0.0",
  "data": {}
}
```

Rules:

- `schemaVersion` is integer `1`.
- `messageId` identifies one logical message and never changes during retries.
- `deviceId` exactly matches the hardware ID in the topic.
- `occurredAt` is the real occurrence time in UTC ISO-8601.
- `sequence` is a non-negative integer increasing within a boot.
- `bootId` changes whenever the device service restarts.
- `firmwareVersion` is 1–40 characters.
- `data` is the event-specific object below.

## 6. Device HMAC signing

The backend stores `credentialHash = SHA256(deviceSecret).hexdigest()`.

For every device event:

```text
timestamp  = current UTC ISO-8601 time
json       = compactJson(envelope)
signedText = timestamp + "." + json
signature  = HMAC-SHA256(
               key=UTF8(credentialHash),
               message=UTF8(signedText)
             ).hexdigest()
```

Publish:

```json
{
  "envelope": {},
  "auth": {
    "timestamp": "2026-08-27T10:00:01.000Z",
    "signature": "64-character-hex-signature"
  }
}
```

Use UTF-8 and compact JSON, preserve field order, and never modify the envelope
after signing. The timestamp must be within five minutes of backend time. Enable
NTP with `sudo timedatectl set-ntp true`.

Python reference:

The complete executable reference is
[`raspberry_pi_hivemq_example.py`](raspberry_pi_hivemq_example.py). It includes
TLS, authentication, QoS 1 delivery, durable offline queuing, reconnect backoff,
event validation, signed settings commands, atomic settings persistence,
diagnostics and graceful shutdown. The smaller excerpt below only demonstrates
the signing algorithm.

```python
import hashlib, hmac, json
from datetime import datetime, timezone

def utc_now():
    return datetime.now(timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")

def sign_event(secret, envelope):
    timestamp = utc_now()
    body = json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)
    key = hashlib.sha256(secret.encode()).hexdigest()
    signature = hmac.new(
        key.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256
    ).hexdigest()
    return {"envelope": envelope,
            "auth": {"timestamp": timestamp, "signature": signature}}
```

## 7. Heartbeat

Heartbeat is device health, not biological heart rate. Publish every 30–60 seconds.
Do not replay a backlog of obsolete heartbeats; send one current heartbeat after
reconnection.

Topic: `wakatech/v1/devices/{hardwareId}/telemetry/heartbeat`  
Type: `device.heartbeat`

```json
{
  "batteryPercent": 78,
  "wifiRssi": -61,
  "protocolVersion": 1,
  "location": {
    "latitude": 9.6139,
    "longitude": 6.5569,
    "accuracyMeters": 12.4,
    "fixAt": "2026-08-27T09:59:58.000Z"
  }
}
```

Place this under envelope `data`. Location may be omitted. Report the actual GPS
fix time; do not label cached coordinates as new. Current cloud states are online
within 120 seconds, stale from 120–600 seconds, offline after 600 seconds, and
never-seen before the first heartbeat.

## 8. Fall event

Topic: `wakatech/v1/devices/{hardwareId}/events/fall`  
Type: `fall.opened`

```json
{
  "fallEventId": "unique-fall-uuid",
  "severity": "critical",
  "batteryPercent": 77,
  "location": {
    "latitude": 9.6139,
    "longitude": 6.5569,
    "accuracyMeters": 12.4,
    "fixAt": "2026-08-27T10:14:59.000Z"
  }
}
```

Rules:

- Severity is `high` or `critical`.
- Battery is 0–100; latitude -90–90; longitude -180–180.
- Retries preserve `messageId`, `fallEventId`, data and occurrence time.
- To escalate high to critical, use the same `fallEventId` and a new `messageId`.
- Fall events always outrank activity and heartbeat queue work.
- Publish after the agreed local false-alarm grace period/confirmation state.

The backend persists a fall even if no caregiver contact is configured.

## 9. Activity checkpoint

Topic: `wakatech/v1/devices/{hardwareId}/events/activity`  
Type: `activity.checkpoint`

```json
{
  "sampleId": "unique-sample-uuid",
  "counterEpoch": "counter-epoch-uuid",
  "cumulativeSteps": 1684
}
```

Steps are a non-negative integer. Preserve `counterEpoch` while the same counter
is active; create a new epoch when it is reset.

## 10. Completed walking session

Topic: `wakatech/v1/devices/{hardwareId}/events/walk-session`  
Type: `walk-session.completed`

```json
{
  "sessionId": "unique-session-uuid",
  "startedAt": "2026-08-27T10:30:00.000Z",
  "endedAt": "2026-08-27T11:00:00.000Z",
  "steps": 1250
}
```

## 11. Settings command and verification

Subscribe to `wakatech/v1/devices/{hardwareId}/commands/settings`.

```json
{
  "command": {
    "schemaVersion": 1,
    "commandId": "command-uuid",
    "deviceId": "WK-2026-000042",
    "commandType": "settings.update",
    "issuedAt": "2026-08-27T12:00:00.000Z",
    "version": 2,
    "data": {
      "fallSensitivity": "high",
      "falseAlarmGraceSeconds": 20
    }
  },
  "auth": { "signature": "64-character-hex-HMAC" }
}
```

Verify `HMAC-SHA256(UTF8(credentialHash), UTF8(compactJson(command)))`.

Allowed values:

- `fallSensitivity`: `low`, `medium`, `high`.
- `falseAlarmGraceSeconds`: integer 5–120.
- `version`: positive monotonically increasing integer.

The Pi must verify HMAC with a timing-safe comparison, identity, schema, type and
values; ignore older versions; treat the same version idempotently; atomically
persist settings and version; apply them; then acknowledge. Never execute arbitrary
shell commands from MQTT.

## 12. Settings acknowledgement

Topic: `wakatech/v1/devices/{hardwareId}/events/settings-applied`  
Type: `settings.applied`

Success data:

```json
{ "version": 2, "status": "applied" }
```

Failure data:

```json
{
  "version": 2,
  "status": "rejected",
  "errorCode": "UNSUPPORTED_SENSITIVITY"
}
```

Wrap this in the standard envelope and sign normally. A matching success changes
cloud state from `pending` to `synced`; rejection changes it to `failed`. Stale
acknowledgements cannot acknowledge newer settings.

## 13. Durable local queue

Use transactional SQLite, not memory only:

1. Generate and save the complete event before publishing.
2. Publish at QoS 1 and wait for PUBACK.
3. Retain on disconnection/failure and retry with backoff plus jitter.
4. Re-sign with a fresh authentication timestamp.
5. Preserve the original envelope and IDs.

Priority:

1. Fall events.
2. Settings acknowledgements.
3. Current heartbeat.
4. Walking sessions.
5. Activity checkpoints.

Bound disk usage and coalesce obsolete non-safety data. Never discard an
unconfirmed fall. Until backend durable-fall acknowledgements are added, retain
recent falls locally and retry conservatively without flooding.

## 14. Raspberry Pi service requirements

Deliver an installable service, not a manually started script:

```text
wakatech-device/
|-- src/
|-- tests/
|-- requirements.lock
|-- config.example
|-- install.sh
|-- uninstall.sh
|-- systemd/wakatech-device.service
|-- VERSION
|-- CHANGELOG.md
`-- README.md
```

It must run as an unprivileged dedicated user, start at boot, restart after crashes,
load `/etc/wakatech/device.env`, shut down cleanly, use bounded journald logs,
persist queued state and expose a diagnostic command without revealing secrets.

```bash
sudo systemctl status wakatech-device
sudo systemctl restart wakatech-device
journalctl -u wakatech-device -f
wakatech-device diagnostics
```

## 15. Physical safety specification

The hardware team must document and test:

- Sensors, sampling frequency and calibration.
- Fall algorithm and meaning of each sensitivity level.
- False-alarm countdown and physical cancel button.
- Buzzer/vibration/LED/display feedback.
- Manual SOS behaviour if supported.
- GPS timeout and cached-location policy.
- Low-battery thresholds and safe shutdown.
- Behaviour without internet or GPS.
- Behaviour after reboot during an incident.
- Sensor-failure detection and user indication.

Cloud connectivity must not be the user's only indication of a detected fall.

## 16. Storage, power and OTA

- Use transactional SQLite and bounded queues/logs.
- Avoid writing raw high-frequency samples continuously.
- Use high-endurance/industrial storage.
- Test sudden power loss during database writes.
- Consider read-only root or separate writable data partition.
- Sign OTA artifacts and download through verified HTTPS.
- Install atomically, health-check afterward and roll back automatically.
- Support staged rollout and pausing a faulty release.
- Keep firmware/update audit records.

## 17. Security requirements

- MQTT TLS with hostname validation.
- Unique broker and HMAC credentials per device.
- Exact per-device topic ACLs.
- Timing-safe HMAC comparisons and NTP monitoring.
- Remove default Pi passwords.
- Disable SSH or use key-only, restricted access.
- Enable a host firewall and minimize packages/services.
- Exclude secrets from Git, images, logs and crash reports.
- Provide credential rotation, revocation and ownership-reset procedures.
- Maintain OS/dependency security updates.

## 18. Manufacturing procedure

1. Allocate immutable hardware ID.
2. Generate random device secret and single-use expiring claim code.
3. Register device/credential hash in backend.
4. Provision unique broker credential/certificate and trusted CA.
5. Install secrets with restricted permissions.
6. Print hardware-ID/claim QR; never encode the HMAC secret in it.
7. Calibrate sensors and run factory diagnostics.
8. Verify heartbeat and settings round-trip.
9. Remove test credentials/logs.
10. Record hardware and firmware revisions.

## 19. Local integration test

Backend machine:

```powershell
docker compose up -d redis mqtt
npm run seed
npm run start:dev
Invoke-RestMethod http://localhost:3000/v1/health/ready
```

Expected readiness: database `up`, schema `migrated`, Redis `up`, MQTT `up`.

Existing event simulators:

```powershell
npm run simulator -- mqtt-heartbeat
npm run simulator -- mqtt-activity
npm run simulator -- mqtt-fall
```

Settings test:

1. Run `npm run simulator:settings` and leave it listening.
2. Change safety settings from the authenticated app/API.
3. Confirm `Applied and acknowledged settings vN` in the simulator.
4. Confirm `MQTT settings.applied accepted` in backend logs.
5. Confirm the frontend/API changes from `pending` to `synced`.

## 20. Required test matrix

Functional:

- Boot/startup, heartbeat, activity, walk session and fall end to end.
- Duplicate fall/message delivery produces no duplicate alert.
- High-to-critical escalation.
- Settings persist/apply/acknowledge; retained replay is idempotent.

Connectivity:

- No Wi-Fi at boot, DNS failure, broker unavailable, invalid TLS certificate.
- Drop during publish, reconnect/backlog replay, 24-hour offline period.
- Latency, packet loss and incorrect device clock.

Safety:

- Representative falls and ordinary walking.
- Sitting abruptly and stick dropped without user fall.
- False-alarm cancellation.
- Fall without GPS/internet and at low battery.
- Repeated falls and power loss while queuing a fall.

Security:

- Wrong secret, tampered payload, expired timestamp, replay.
- Topic/device mismatch and access to another device namespace.
- Invalid settings signature and stale/duplicate settings versions.

Reliability:

- Sudden power loss during SQLite write, disk full and corrupted record.
- Service/sensor/GPS failure.
- Minimum 72-hour soak test.
- Large activity backlog with a new fall inserted at highest priority.
- OTA failure and rollback.

## 21. Hardware-team deliverables

- Source repository and locked dependencies.
- Installer, uninstaller and systemd service.
- Secret-free configuration template.
- SQLite schema/migrations and retry implementation.
- HMAC code plus agreed valid/invalid test vectors.
- MQTT publisher/subscriber and diagnostics.
- Sensor drivers, calibration and fall-algorithm specification.
- Measured fall/false-positive test report.
- Local alert/cancellation UX specification.
- Security review and credential lifecycle.
- OTA rollout/rollback procedure.
- Manufacturing/provisioning procedure.
- Bill of materials and hardware revision.
- Completed test matrix, limitations and recovery guide.

## 22. Production acceptance

Do not approve until:

- A newly provisioned Pi connects through verified MQTT TLS.
- It cannot access another device's topics.
- HMAC test vectors match the backend.
- All event flows work through to the caregiver app.
- Falls survive network loss, restart and sudden power loss.
- A fall cannot wait behind activity data.
- Signed durable backend fall acknowledgement is implemented and tested.
- Settings are verified, persisted, applied and acknowledged.
- Duplicate/stale messages and commands are harmless.
- No secret appears in Git, images or normal logs.
- Service auto-start/recovery and OTA rollback are demonstrated.
- The full functional, safety, security and reliability matrix passes.

## 23. Change control and sign-off

Hardware/backend teams must not independently change topics, fields, signing or
semantics. Every change needs a protocol revision, compatibility decision, updated
test vectors, joint tests and staged deployment plan.

| Responsibility | Name/contact | Approval/date |
| --- | --- | --- |
| Backend/API owner |  |  |
| Hardware lead |  |  |
| Mobile/frontend owner |  |  |
| Security reviewer |  |  |
| Product/safety owner |  |  |

Open blockers:

| Blocker | Owner | Target date | Status |
| --- | --- | --- | --- |
| MQTT TLS, unique credentials and ACLs |  |  | Open |
| Durable backend fall acknowledgement |  |  | Open |
| Credential provisioning/revocation |  |  | Open |
| Signed OTA and rollback |  |  | Open |
