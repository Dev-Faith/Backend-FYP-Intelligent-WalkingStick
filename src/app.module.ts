import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaService } from './shared/prisma';
import { AuthController, AuthService } from './auth/auth';
import { UsersController } from './users/users';
import { DevicesController, DevicesService } from './devices/devices';
import { AlertsController, AlertsService } from './falls/falls';
import { InstallationsController } from './notifications/installations';
import { IngestController, IngestService } from './ingest/ingest';
import { HealthController } from './health/health';

@Module({ imports:[ConfigModule.forRoot({isGlobal:true}),JwtModule.register({global:true})], controllers:[AuthController,UsersController,DevicesController,AlertsController,InstallationsController,IngestController,HealthController], providers:[PrismaService,AuthService,DevicesService,AlertsService,IngestService] })
export class AppModule {}
