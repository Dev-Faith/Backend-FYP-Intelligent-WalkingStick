import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  Inject,
  forwardRef,
  Injectable,
} from "@nestjs/common";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPhoneNumber,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";
import { createHash } from "crypto";
import { PrismaService } from "../shared/prisma";
import { JwtGuard } from "../shared/http";
import { MqttIngestService } from "../ingest/mqtt.service";
class ClaimDto {
  @IsString() @Length(4, 64) claimCode!: string;
  @IsString() @Length(3, 80) hardwareId!: string;
  @IsOptional() @IsString() clientBleId?: string;
  @IsOptional() @IsString() @Length(1, 80) displayName?: string;
}
class ContactDto {
  @IsString() @Length(2, 80) fullName!: string;
  @IsString() @Length(7, 30) phoneNumber!: string;
  @IsOptional() @IsString() @Length(0, 40) relationship?: string;
}
class SettingsDto {
  @IsIn(["low", "medium", "high"]) fallSensitivity!: string;
  @IsInt() @Min(5) @Max(120) falseAlarmGraceSeconds!: number;
  @IsInt() @Min(1) expectedVersion!: number;
}
const dig = (s: string) =>
  createHash("sha256").update(s.trim().toUpperCase()).digest("hex");
const phone = (s: string) => {
  const p = s.trim().replace(/[\s().-]/g, "");
  if (!/^\+?\d{7,15}$/.test(p))
    throw new ConflictException("Enter a valid phone number.");
  return p;
};
@Controller("devices")
@UseGuards(JwtGuard)
export class DevicesController {
  constructor(
    @Inject(forwardRef(() => DevicesService)) private readonly s: any,
  ) {}
  @Post("claim") claim(@Req() r: any, @Body() b: ClaimDto) {
    return this.s.claim(r.user.sub, b);
  }
  @Get() list(@Req() r: any) {
    return this.s.list(r.user.sub);
  }
  @Get(":id") get(@Req() r: any, @Param("id") id: string) {
    return this.s.get(r.user.sub, id);
  }
  @Get(":id/status") status(@Req() r: any, @Param("id") id: string) {
    return this.s.status(r.user.sub, id);
  }
  @Delete(":id/access/me") @HttpCode(204) remove(
    @Req() r: any,
    @Param("id") id: string,
  ) {
    return this.s.remove(r.user.sub, id);
  }
  @Get(":id/emergency-contact") contact(
    @Req() r: any,
    @Param("id") id: string,
  ) {
    return this.s.contact(r.user.sub, id);
  }
  @Put(":id/emergency-contact") putContact(
    @Req() r: any,
    @Param("id") id: string,
    @Body() b: ContactDto,
  ) {
    return this.s.putContact(r.user.sub, id, b);
  }
  @Delete(":id/emergency-contact") @HttpCode(204) deleteContact(
    @Req() r: any,
    @Param("id") id: string,
  ) {
    return this.s.deleteContact(r.user.sub, id);
  }
  @Get(":id/safety-settings") settings(@Req() r: any, @Param("id") id: string) {
    return this.s.settings(r.user.sub, id);
  }
  @Patch(":id/safety-settings") patch(
    @Req() r: any,
    @Param("id") id: string,
    @Body() b: SettingsDto,
  ) {
    return this.s.patch(r.user.sub, id, b);
  }
  @Get(":id/activity/snapshot") activity(
    @Req() r: any,
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    return this.s.activity(r.user.sub, id, from, to);
  }
}
@Injectable()
export class DevicesService {
  constructor(
    private db: PrismaService,
    @Inject(forwardRef(() => MqttIngestService))
    private readonly mqtt: MqttIngestService,
  ) {}
  async access(uid: string, id: string) {
    const a = await this.db.deviceAccess.findUnique({
      where: { userId_deviceId: { userId: uid, deviceId: id } },
      include: { device: true },
    });
    if (!a) throw new NotFoundException("Device not found.");
    return a;
  }
  async claim(uid: string, b: ClaimDto) {
    const d = await this.db.device.findUnique({
      where: { hardwareId: b.hardwareId },
      include: { claims: true },
    });
    const c = d?.claims.find(
      (x) =>
        x.claimHash === dig(b.claimCode) &&
        !x.usedAt &&
        x.expiresAt > new Date(),
    );
    if (!d || !c || d.claimedAt)
      throw new ConflictException(
        "This claim code is invalid, expired, or already used.",
      );
    const now = new Date();
    await this.db.$transaction([
      this.db.deviceClaim.update({
        where: { id: c.id },
        data: { usedAt: now },
      }),
      this.db.device.update({
        where: { id: d.id },
        data: {
          claimedAt: now,
          displayName: b.displayName?.trim() || d.displayName,
        },
      }),
      this.db.deviceAccess.create({
        data: { userId: uid, deviceId: d.id, role: "owner" },
      }),
      this.db.auditLog.create({
        data: {
          actorId: uid,
          action: "device.claimed",
          resourceType: "device",
          resourceId: d.id,
        },
      }),
    ]);
    return {
      device: {
        id: d.id,
        hardwareId: d.hardwareId,
        displayName: b.displayName?.trim() || d.displayName,
        claimedAt: now.toISOString(),
      },
    };
  }
  async list(uid: string) {
    const rows = await this.db.deviceAccess.findMany({
      where: { userId: uid },
      include: { device: true },
    });
    return {
      items: rows.map((a) => ({
        id: a.device.id,
        hardwareId: a.device.hardwareId,
        displayName: a.device.displayName,
        role: a.role,
        claimedAt: a.device.claimedAt,
      })),
      nextCursor: null,
    };
  }
  async get(uid: string, id: string) {
    const a = await this.access(uid, id);
    return {
      id: a.device.id,
      hardwareId: a.device.hardwareId,
      displayName: a.device.displayName,
      role: a.role,
      claimedAt: a.device.claimedAt,
    };
  }
  async remove(uid: string, id: string) {
    await this.access(uid, id);
    await this.db.deviceAccess.delete({
      where: { userId_deviceId: { userId: uid, deviceId: id } },
    });
  }
  async status(uid: string, id: string) {
    const { device: d } = await this.access(uid, id);
    const age = d.lastSeenAt ? Date.now() - d.lastSeenAt.getTime() : Infinity,
      o = Number(process.env.ONLINE_AFTER_SECONDS || 120) * 1000,
      s = Number(process.env.STALE_AFTER_SECONDS || 600) * 1000;
    return {
      deviceId: id,
      cloudState: !d.lastSeenAt
        ? "never-seen"
        : age <= o
          ? "online"
          : age <= s
            ? "stale"
            : "offline",
      lastSeenAt: d.lastSeenAt,
      batteryLevel: d.batteryLevel,
      wifiRssi: d.wifiRssi,
      firmwareVersion: d.firmwareVersion,
      protocolVersion: d.protocolVersion,
      lastLocation:
        d.latitude == null
          ? null
          : {
              latitude: d.latitude,
              longitude: d.longitude,
              accuracyMeters: d.accuracyMeters,
              fixAt: d.fixAt,
            },
    };
  }
  async contact(uid: string, id: string) {
    await this.access(uid, id);
    const c = await this.db.emergencyContact.findUnique({
      where: { deviceId: id },
    });
    if (!c) throw new NotFoundException("Emergency contact not found.");
    return { ...c, isPrimary: true };
  }
  async putContact(uid: string, id: string, b: ContactDto) {
    await this.access(uid, id);
    const c = await this.db.emergencyContact.upsert({
      where: { deviceId: id },
      create: {
        deviceId: id,
        fullName: b.fullName.trim(),
        phoneNumber: phone(b.phoneNumber),
        relationship: b.relationship?.trim(),
      },
      update: {
        fullName: b.fullName.trim(),
        phoneNumber: phone(b.phoneNumber),
        relationship: b.relationship?.trim(),
      },
    });
    await this.db.auditLog.create({
      data: {
        actorId: uid,
        action: "contact.updated",
        resourceType: "device",
        resourceId: id,
      },
    });
    return { ...c, isPrimary: true };
  }
  async deleteContact(uid: string, id: string) {
    await this.access(uid, id);
    await this.db.emergencyContact.deleteMany({ where: { deviceId: id } });
  }
  async settings(uid: string, id: string) {
    const d = (await this.access(uid, id)).device;
    return {
      fallSensitivity: d.sensitivity,
      falseAlarmGraceSeconds: d.graceSeconds,
      version: d.settingsVersion,
      deviceSyncState: d.syncState,
      updatedAt: d.claimedAt,
    };
  }
  async patch(uid: string, id: string, b: SettingsDto) {
    const d = (await this.access(uid, id)).device;
    if (d.settingsVersion !== b.expectedVersion)
      throw new ConflictException("Settings changed; refresh and try again.");
    const n = await this.db.device.update({
      where: { id },
      data: {
        sensitivity: b.fallSensitivity,
        graceSeconds: b.falseAlarmGraceSeconds,
        settingsVersion: { increment: 1 },
        syncState: "pending",
      },
    });
    try {
      await this.mqtt.publishSettings(n);
    } catch {
      // The durable pending state is republished automatically when MQTT reconnects.
    }
    return {
      fallSensitivity: n.sensitivity,
      falseAlarmGraceSeconds: n.graceSeconds,
      version: n.settingsVersion,
      deviceSyncState: n.syncState,
      updatedAt: new Date().toISOString(),
    };
  }
  async activity(uid: string, id: string, from?: string, to?: string) {
    await this.access(uid, id);
    const daily = await this.db.dailyActivity.findMany({
      where: { deviceId: id, date: { gte: from, lte: to } },
      orderBy: { date: "asc" },
    });
    const sessions = await this.db.walkSession.findMany({
      where: {
        deviceId: id,
        startedAt: {
          gte: from ? new Date(from) : undefined,
          lte: to ? new Date(to + "T23:59:59Z") : undefined,
        },
      },
      orderBy: { startedAt: "desc" },
    });
    return {
      deviceId: id,
      receivedAt: new Date().toISOString(),
      source: "stick-cloud",
      dataLabel: "Walking-stick activity",
      dailyTotals: daily.map((x) => ({
        date: x.date,
        steps: x.steps,
        goal: x.goal,
        recordedThrough: x.recordedThrough,
        coverage: x.coverage,
        source: "stick-cloud",
      })),
      sessions: sessions.map((x) => ({
        id: x.id,
        startedAt: x.startedAt,
        endedAt: x.endedAt,
        steps: x.steps,
        source: "stick-cloud",
      })),
    };
  }
}
