import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PublicExceptionFilter } from './shared/http';

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet()); app.enableCors({ origin: true, credentials: true });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(new ValidationPipe({ transform:true, whitelist:true, forbidNonWhitelisted:true }));
  app.useGlobalFilters(new PublicExceptionFilter());
  const config = new DocumentBuilder().setTitle('Wakatech API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('v1/docs', app, SwaggerModule.createDocument(app, config));
  return app;
}
if (require.main === module) createApp().then(app => app.listen(Number(process.env.PORT || 3000)));
