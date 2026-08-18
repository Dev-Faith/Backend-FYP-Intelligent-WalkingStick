import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import { createHash } from 'crypto';
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const db = new PrismaClient({ adapter: new PrismaNeon({ connectionString }) });
const claimCode = 'WAKA-2026';
async function main() {
  const deviceSecret = process.env.SEEDED_DEVICE_SECRET;
  if (!deviceSecret || deviceSecret.startsWith('replace-with-')) {
    throw new Error('Set a strong SEEDED_DEVICE_SECRET in .env before seeding.');
  }
  const credentialHash = createHash('sha256').update(deviceSecret).digest('hex');
  const device = await db.device.upsert({ where: { hardwareId: 'WK-2026-000042' }, update: { credentialHash }, create: { hardwareId: 'WK-2026-000042', credentialHash } });
  await db.deviceClaim.upsert({ where: { claimHash: createHash('sha256').update(claimCode).digest('hex') }, update: { usedAt: null, expiresAt: new Date(Date.now() + 30 * 86400000) }, create: { deviceId: device.id, claimHash: createHash('sha256').update(claimCode).digest('hex'), expiresAt: new Date(Date.now() + 30 * 86400000) } });
  console.log(`Seeded ${device.hardwareId}; local claim code: ${claimCode}`);
}
main().finally(() => db.$disconnect());
