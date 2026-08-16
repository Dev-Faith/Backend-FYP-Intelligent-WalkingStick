import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../shared/prisma';
import { Public } from '../shared/http';

@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService) {}

  @Public()
  @Get('live')
  live() { return { status: 'ok', time: new Date().toISOString() }; }

  @Public()
  @Get('ready')
  async ready() {
    await this.db.user.count();
    return {
      status: 'ready',
      database: 'up',
      schema: 'migrated',
      time: new Date().toISOString(),
    };
  }
}
