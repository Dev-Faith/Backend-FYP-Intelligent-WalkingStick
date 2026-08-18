import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../shared/prisma';
import { Public } from '../shared/http';
import { MqttIngestService } from '../ingest/mqtt.service';
import { OutboxDispatcher } from '../notifications/pipeline';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: PrismaService,
    private readonly mqtt: MqttIngestService,
    private readonly outbox: OutboxDispatcher,
  ) {}

  @Public()
  @Get('live')
  live() { return { status: 'ok', time: new Date().toISOString() }; }

  @Public()
  @Get('ready')
  async ready() {
    await this.db.user.count();
    const redis = await this.outbox.queueReady();
    if (!this.mqtt.isReady()) throw new Error('MQTT is not connected');
    return {
      status: 'ready',
      database: 'up',
      schema: 'migrated',
      redis: redis === 'PONG' ? 'up' : 'down',
      mqtt: 'up',
      time: new Date().toISOString(),
    };
  }
}
