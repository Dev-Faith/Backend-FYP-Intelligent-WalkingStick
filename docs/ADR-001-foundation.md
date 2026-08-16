# ADR-001: Initial backend foundation

Status: accepted for the FYP baseline.

- NestJS HTTP API, PostgreSQL, and Prisma are the initial stack.
- The stick is authoritative for the offline false-alarm grace period.
- Device provisioning uses a pre-created immutable hardware identity and one-time claim code.
- Device ingest is exposed over authenticated HTTPS for the working baseline. MQTT topics remain the production transport target once firmware TLS capabilities are confirmed.
- Care-recipient time zone starts as `Africa/Lagos` and is stored per device; a future profile API must make it explicit.
- Push v2 is retained for current frontend compatibility. A later v3 will carry only an alert ID.

Open: production broker, device certificate provisioning, reverse geocoder, retention durations, and multi-caregiver invitations.
