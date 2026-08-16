import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
const db = new PrismaClient();
const claimCode = 'WAKA-2026';
async function main() {
  const device = await db.device.upsert({ where: { hardwareId: 'WK-2026-000042' }, update: {}, create: { hardwareId: 'WK-2026-000042' } });
  await db.deviceClaim.upsert({ where: { claimHash: createHash('sha256').update(claimCode).digest('hex') }, update: { usedAt: null, expiresAt: new Date(Date.now() + 30 * 86400000) }, create: { deviceId: device.id, claimHash: createHash('sha256').update(claimCode).digest('hex'), expiresAt: new Date(Date.now() + 30 * 86400000) } });
  console.log(`Seeded ${device.hardwareId}; local claim code: ${claimCode}`);
}
main().finally(() => db.$disconnect());
