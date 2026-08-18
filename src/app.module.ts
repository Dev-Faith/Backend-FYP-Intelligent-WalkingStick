import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from './shared/prisma';
import { AuthController, AuthService } from './auth/auth';
import { UsersController } from './users/users';
import { DevicesController, DevicesService } from './devices/devices';
import { AlertsController, AlertsService } from './falls/falls';
import { InstallationsController } from './notifications/installations';
import { IngestController, IngestService } from './ingest/ingest';
import { MqttIngestService } from './ingest/mqtt.service';
import { HealthController } from './health/health';
import { ALERT_QUEUE, FallPushWorker, OutboxDispatcher } from './notifications/pipeline';

function redisConnection() {
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: Number(url.pathname.slice(1) || 0),
    maxRetriesPerRequest: null,
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({ global: true }),
    BullModule.forRootAsync({ useFactory: () => ({ connection: redisConnection(), prefix: 'wakatech' }) }),
    BullModule.registerQueue({ name: ALERT_QUEUE }),
  ],
  controllers: [AuthController, UsersController, DevicesController, AlertsController, InstallationsController, IngestController, HealthController],
  providers: [PrismaService, AuthService, DevicesService, AlertsService, IngestService, MqttIngestService, OutboxDispatcher, FallPushWorker],
})
export class AppModule {}
