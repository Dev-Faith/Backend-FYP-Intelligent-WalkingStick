import 'dotenv/config';

const base = process.env.API_URL || 'http://localhost:3000/v1';
const kind = process.argv[2] || 'heartbeat';
const now = new Date().toISOString();
const common = { schemaVersion: 1, messageId: `sim-${Date.now()}`, deviceId: 'WK-2026-000042', occurredAt: now, sequence: Date.now(), bootId: 'sim-boot-1', firmwareVersion: '1.0.0' };
const bodies: Record<string, unknown> = {
  heartbeat: { ...common, eventType: 'device.heartbeat', data: { batteryPercent: 78, wifiRssi: -61, protocolVersion: 1, location: { latitude: 9.6139, longitude: 6.5569, accuracyMeters: 12.4, fixAt: now } } },
  fall: { ...common, eventType: 'fall.opened', data: { fallEventId: `fall-${Date.now()}`, severity: 'critical', batteryPercent: 78, location: { latitude: 9.6139, longitude: 6.5569, accuracyMeters: 12.4, fixAt: now } } },
  activity: { ...common, eventType: 'activity.checkpoint', data: { sampleId: `steps-${Date.now()}`, counterEpoch: 'sim-epoch-1', cumulativeSteps: 1684 } },
};
if (!bodies[kind]) throw new Error('Use heartbeat, fall, or activity');
fetch(`${base}/device-ingest/events`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-key': process.env.DEVICE_INGEST_KEY || 'local-device-key' }, body: JSON.stringify(bodies[kind]) }).then(async r => { console.log(r.status, await r.text()); if (!r.ok) process.exitCode = 1; });
