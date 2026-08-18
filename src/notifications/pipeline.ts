import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../shared/prisma';
import { buildFallPush } from './push';

export const ALERT_QUEUE = 'fall-alert-delivery';

@Injectable()
export class OutboxDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly db: PrismaService,
    @InjectQueue(ALERT_QUEUE) private readonly queue: Queue,
  ) {}

  onModuleInit() {
    const interval = Number(process.env.OUTBOX_POLL_MS || 2_000);
    this.timer = setInterval(() => void this.poll(), interval);
    this.timer.unref();
    void this.poll();
  }

  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async queueReady() { await this.queue.waitUntilReady(); return 'PONG'; }

  private async poll() {
    if (this.running) return;
    this.running = true;
    try {
      const records = await this.db.outbox.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 25 });
      for (const record of records) {
        const claimed = await this.db.outbox.updateMany({ where: { id: record.id, status: 'pending' }, data: { status: 'dispatching' } });
        if (!claimed.count) continue;
        try {
          await this.queue.add('dispatch-fall', { fallId: record.aggregateId, revision: record.revision }, {
            jobId: `fall-${record.aggregateId}-${record.revision}`,
            attempts: 5,
            backoff: { type: 'exponential', delay: 2_000 },
            removeOnComplete: 500,
            removeOnFail: 1_000,
          });
          await this.db.outbox.update({ where: { id: record.id }, data: { status: 'processed', processedAt: new Date() } });
        } catch (error) {
          await this.db.outbox.update({ where: { id: record.id }, data: { status: 'pending', attempts: { increment: 1 } } });
          throw error;
        }
      }
    } catch (error) {
      this.logger.error(`Outbox dispatch failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally { this.running = false; }
  }
}

type ExpoTicket = { status: 'ok' | 'error'; id?: string; message?: string; details?: { error?: string } };
type ExpoReceipt = { status: 'ok' | 'error'; message?: string; details?: { error?: string } };

@Processor(ALERT_QUEUE, { concurrency: 6 })
export class FallPushWorker extends WorkerHost {
  private readonly logger = new Logger(FallPushWorker.name);
  constructor(
    private readonly db: PrismaService,
    @InjectQueue(ALERT_QUEUE) private readonly queue: Queue,
  ) { super(); }

  async process(job: Job) {
    if (job.name === 'dispatch-fall') return this.dispatch(job.data.fallId, job.data.revision);
    if (job.name === 'check-receipt') return this.receipt(job.data.dispatchId);
    throw new Error(`Unknown alert job ${job.name}`);
  }

  private async dispatch(fallId: string, revision: number) {
    const fall = await this.db.fallEvent.findUnique({
      where: { id: fallId },
      include: { device: { include: { access: { include: { user: { include: { installations: true } } } } } } },
    });
    if (!fall) return;
    const installations = fall.device.access.flatMap((access) => access.user.installations).filter((i) => i.enabled && i.permissionState === 'granted' && i.provider === 'expo');
    for (const installation of installations) {
      const dispatch = await this.db.pushDispatch.upsert({
        where: { fallId_installationId_revision: { fallId, installationId: installation.id, revision } },
        create: { fallId, installationId: installation.id, revision },
        update: {},
      });
      if (dispatch.ticketStatus === 'ok' || dispatch.receiptStatus === 'ok') continue;
      const push = buildFallPush(installation.pushToken, fall as any);
      const ticket = await this.send(push);
      if (ticket.status === 'error') {
        await this.db.pushDispatch.update({ where: { id: dispatch.id }, data: { ticketStatus: 'error', errorCode: ticket.details?.error, errorMessage: ticket.message, attempts: { increment: 1 }, ticketAt: new Date() } });
        if (ticket.details?.error === 'DeviceNotRegistered') await this.disableInstallation(installation.id);
        if (this.transient(ticket.details?.error)) throw new Error(ticket.message || 'Transient Expo ticket failure');
        continue;
      }
      if (!ticket.id) throw new Error('Expo returned an ok ticket without an ID');
      await this.db.pushDispatch.update({ where: { id: dispatch.id }, data: { ticketId: ticket.id, ticketStatus: 'ok', errorCode: null, errorMessage: null, attempts: { increment: 1 }, ticketAt: new Date() } });
      await this.queue.add('check-receipt', { dispatchId: dispatch.id }, {
        jobId: `receipt-${dispatch.id}`,
        delay: Number(process.env.EXPO_RECEIPT_DELAY_MS || 900_000),
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1_000,
        removeOnFail: 1_000,
      });
    }
  }

  private async receipt(dispatchId: string) {
    const dispatch = await this.db.pushDispatch.findUnique({ where: { id: dispatchId } });
    if (!dispatch?.ticketId || dispatch.receiptStatus === 'ok') return;
    const response = await this.expoFetch('https://exp.host/--/api/v2/push/getReceipts', { ids: [dispatch.ticketId] });
    const receipt = response.data?.[dispatch.ticketId] as ExpoReceipt | undefined;
    if (!receipt) throw new Error('Expo receipt is not available yet');
    await this.db.pushDispatch.update({ where: { id: dispatch.id }, data: { receiptStatus: receipt.status, errorCode: receipt.details?.error, errorMessage: receipt.message, receiptAt: new Date() } });
    if (receipt.details?.error === 'DeviceNotRegistered') await this.disableInstallation(dispatch.installationId);
    if (receipt.status === 'error' && this.transient(receipt.details?.error)) throw new Error(receipt.message || 'Transient Expo receipt failure');
  }

  private async send(push: object): Promise<ExpoTicket> {
    const response = await this.expoFetch('https://exp.host/--/api/v2/push/send', push);
    const ticket = Array.isArray(response.data) ? response.data[0] : response.data;
    if (!ticket) throw new Error('Expo returned no push ticket');
    return ticket;
  }

  private async expoFetch(url: string, body: object) {
    const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const json = await response.json() as any;
    if (!response.ok) {
      const error = new Error(`Expo HTTP ${response.status}: ${json.errors?.[0]?.message || 'request failed'}`);
      if (response.status === 429 || response.status >= 500) throw error;
      this.logger.warn(error.message);
      return { data: { status: 'error', message: error.message, details: { error: json.errors?.[0]?.code } } };
    }
    return json;
  }

  private transient(code?: string) { return code === 'MessageRateExceeded' || code === 'TOO_MANY_REQUESTS'; }
  private async disableInstallation(id: string) { await this.db.notificationInstallation.update({ where: { id }, data: { enabled: false } }); }
}
