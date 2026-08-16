import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  UnauthorizedException,
  Inject,
  forwardRef,
  Injectable,
} from "@nestjs/common";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
import { PrismaService } from "../shared/prisma";
import { Public } from "../shared/http";
class Envelope {
  @IsInt() @IsIn([1]) schemaVersion!: number;
  @IsString() @Length(3, 100) messageId!: string;
  @IsString() @Length(3, 80) deviceId!: string;
  @IsIn([
    "fall.opened",
    "device.heartbeat",
    "activity.checkpoint",
    "walk-session.completed",
  ])
  eventType!: string;
  @IsDateString() occurredAt!: string;
  @IsInt() @Min(0) sequence!: number;
  @IsString() @Length(1, 100) bootId!: string;
  @IsString() @Length(1, 40) firmwareVersion!: string;
  @IsObject() data!: Record<string, any>;
}
@Controller("device-ingest")
export class IngestController {
  constructor(
    @Inject(forwardRef(() => IngestService)) private readonly s: any,
  ) {}
  @Public() @Post("events") @HttpCode(202) ingest(
    @Headers("x-device-key") key: string,
    @Body() b: Envelope,
  ) {
    return this.s.ingest(key, b);
  }
}
@Injectable()
export class IngestService {
  constructor(private db: PrismaService) {}
  async ingest(key: string, e: Envelope) {
    const d = await this.db.device.findUnique({
      where: { hardwareId: e.deviceId },
    });
    if (
      !d ||
      !process.env.DEVICE_INGEST_KEY ||
      key !== process.env.DEVICE_INGEST_KEY
    )
      throw new UnauthorizedException("Invalid device credentials.");
    const prior = await this.db.deviceMessage.findUnique({
      where: { deviceId_messageId: { deviceId: d.id, messageId: e.messageId } },
    });
    if (prior) return { accepted: true, duplicate: true };
    return this.db.$transaction(async (tx) => {
      await tx.deviceMessage.create({
        data: {
          deviceId: d.id,
          messageId: e.messageId,
          eventType: e.eventType,
          occurredAt: new Date(e.occurredAt),
          sequence: BigInt(e.sequence),
          bootId: e.bootId,
        },
      });
      if (e.eventType === "device.heartbeat") {
        const x = e.data,
          l = x.location;
        await tx.device.update({
          where: { id: d.id },
          data: {
            lastSeenAt: new Date(),
            batteryLevel: x.batteryPercent,
            wifiRssi: x.wifiRssi,
            firmwareVersion: e.firmwareVersion,
            protocolVersion: x.protocolVersion,
            latitude: l?.latitude,
            longitude: l?.longitude,
            accuracyMeters: l?.accuracyMeters,
            fixAt: l?.fixAt ? new Date(l.fixAt) : undefined,
          },
        });
      }
      if (e.eventType === "fall.opened") await this.fall(tx, d.id, e);
      if (e.eventType === "activity.checkpoint")
        await this.activity(tx, d.id, e);
      if (e.eventType === "walk-session.completed") {
        const x = e.data;
        await tx.walkSession.upsert({
          where: {
            deviceId_externalId: { deviceId: d.id, externalId: x.sessionId },
          },
          create: {
            deviceId: d.id,
            externalId: x.sessionId,
            startedAt: new Date(x.startedAt),
            endedAt: x.endedAt ? new Date(x.endedAt) : null,
            steps: x.steps,
          },
          update: {
            endedAt: x.endedAt ? new Date(x.endedAt) : null,
            steps: x.steps,
          },
        });
      }
      return { accepted: true, duplicate: false };
    });
  }
  async fall(tx: any, did: string, e: Envelope) {
    const x = e.data,
      l = x.location;
    if (
      !x.fallEventId ||
      !["high", "critical"].includes(x.severity) ||
      !l ||
      l.latitude < -90 ||
      l.latitude > 90 ||
      l.longitude < -180 ||
      l.longitude > 180 ||
      x.batteryPercent < 0 ||
      x.batteryPercent > 100
    )
      throw new Error("Invalid fall payload");
    const c = await tx.emergencyContact.findUnique({
      where: { deviceId: did },
    });
    if (!c)
      throw new Error(
        "A primary emergency contact is required before fall dispatch.",
      );
    const old = await tx.fallEvent.findUnique({
      where: {
        deviceId_deviceEventId: { deviceId: did, deviceEventId: x.fallEventId },
      },
    });
    if (old) {
      if (old.severity === "high" && x.severity === "critical") {
        await tx.fallEvent.update({
          where: { id: old.id },
          data: { severity: "critical", dispatchRevision: { increment: 1 } },
        });
        await tx.outbox.create({
          data: {
            topic: "fall.push",
            aggregateId: old.id,
            revision: old.dispatchRevision + 1,
            payload: { fallId: old.id },
          },
        });
      }
      return;
    }
    const f = await tx.fallEvent.create({
      data: {
        deviceId: did,
        deviceEventId: x.fallEventId,
        severity: x.severity,
        occurredAt: new Date(e.occurredAt),
        locationName: "Reported location",
        latitude: l.latitude,
        longitude: l.longitude,
        accuracyMeters: l.accuracyMeters,
        batteryLevel: x.batteryPercent,
        contactName: c.fullName,
        contactPhone: c.phoneNumber,
      },
    });
    await tx.fallTransition.create({
      data: { fallId: f.id, action: "opened" },
    });
    await tx.outbox.create({
      data: {
        topic: "fall.push",
        aggregateId: f.id,
        revision: 1,
        payload: { fallId: f.id },
      },
    });
  }
  async activity(tx: any, did: string, e: Envelope) {
    const x = e.data;
    if (
      !x.sampleId ||
      !x.counterEpoch ||
      !Number.isInteger(x.cumulativeSteps) ||
      x.cumulativeSteps < 0
    )
      throw new Error("Invalid activity payload");
    await tx.activityCheckpoint.create({
      data: {
        deviceId: did,
        sampleId: x.sampleId,
        counterEpoch: x.counterEpoch,
        cumulativeSteps: x.cumulativeSteps,
        occurredAt: new Date(e.occurredAt),
      },
    });
    const date = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Africa/Lagos",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(e.occurredAt));
    await tx.dailyActivity.upsert({
      where: { deviceId_date: { deviceId: did, date } },
      create: {
        deviceId: did,
        date,
        steps: x.cumulativeSteps,
        recordedThrough: new Date(e.occurredAt),
        coverage: "partial",
      },
      update: {
        steps: x.cumulativeSteps,
        recordedThrough: new Date(e.occurredAt),
      },
    });
  }
}
