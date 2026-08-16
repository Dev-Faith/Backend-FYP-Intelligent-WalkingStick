import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  Inject,
  forwardRef,
  Injectable,
} from "@nestjs/common";
import { IsDateString, IsIn, IsOptional } from "class-validator";
import { PrismaService } from "../shared/prisma";
import { JwtGuard } from "../shared/http";
class Occurred {
  @IsOptional() @IsDateString() occurredAt?: string;
}
class Resolve extends Occurred {
  @IsIn([
    "confirmed_safe",
    "false_alarm",
    "assistance_arranged",
    "duplicate",
    "other",
  ])
  resolution!: string;
}
@Controller()
@UseGuards(JwtGuard)
export class AlertsController {
  constructor(
    @Inject(forwardRef(() => AlertsService)) private readonly s: any,
  ) {}
  @Get("devices/:id/fall-alerts") list(
    @Req() r: any,
    @Param("id") id: string,
    @Query("limit") limit = "20",
    @Query("cursor") cursor?: string,
    @Query("status") status?: string,
  ) {
    return this.s.list(
      r.user.sub,
      id,
      Math.min(Number(limit) || 20, 100),
      cursor,
      status,
    );
  }
  @Get("fall-alerts/:id") get(@Req() r: any, @Param("id") id: string) {
    return this.s.get(r.user.sub, id);
  }
  @Post("fall-alerts/:id/acknowledge") ack(
    @Req() r: any,
    @Param("id") id: string,
    @Body() b: Occurred,
  ) {
    return this.s.transition(r.user.sub, id, "acknowledged", b.occurredAt);
  }
  @Post("fall-alerts/:id/resolve") resolve(
    @Req() r: any,
    @Param("id") id: string,
    @Body() b: Resolve,
  ) {
    return this.s.transition(
      r.user.sub,
      id,
      "resolved",
      b.occurredAt,
      b.resolution,
    );
  }
}
@Injectable()
export class AlertsService {
  constructor(private db: PrismaService) {}
  shape(x: any) {
    return {
      id: x.id,
      deviceId: x.deviceId,
      timestamp: x.occurredAt,
      receivedAt: x.receivedAt,
      locationName: x.locationName,
      latitude: x.latitude,
      longitude: x.longitude,
      locationAccuracyMeters: x.accuracyMeters,
      batteryLevel: x.batteryLevel,
      contactName: x.contactName,
      contactPhone: x.contactPhone,
      severity: x.severity,
      status: x.status,
      source: "notification",
      acknowledgedAt: x.acknowledgedAt,
      resolvedAt: x.resolvedAt,
      resolution: x.resolution,
    };
  }
  async owned(uid: string, fallId: string) {
    const f = await this.db.fallEvent.findFirst({
      where: { id: fallId, device: { access: { some: { userId: uid } } } },
      include: { transitions: { orderBy: { serverAt: "asc" } } },
    });
    if (!f) throw new NotFoundException("Fall alert not found.");
    return f;
  }
  async list(
    uid: string,
    did: string,
    limit: number,
    cursor?: string,
    status?: string,
  ) {
    const access = await this.db.deviceAccess.findUnique({
      where: { userId_deviceId: { userId: uid, deviceId: did } },
    });
    if (!access) throw new NotFoundException("Device not found.");
    const rows = await this.db.fallEvent.findMany({
      where: { deviceId: did, status: status as any },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const more = rows.length > limit,
      items = rows.slice(0, limit);
    return {
      items: items.map((x) => this.shape(x)),
      nextCursor: more ? items.at(-1)!.id : null,
    };
  }
  async get(uid: string, id: string) {
    const f = await this.owned(uid, id);
    return { ...this.shape(f), lifecycle: f.transitions };
  }
  async transition(
    uid: string,
    id: string,
    state: "acknowledged" | "resolved",
    occurred?: string,
    resolution?: string,
  ) {
    const f = await this.owned(uid, id);
    if (
      f.status === "resolved" ||
      (state === "acknowledged" && f.status === "acknowledged")
    )
      return this.shape(f);
    const now = new Date();
    const updated = await this.db.$transaction(async (tx) => {
      const x = await tx.fallEvent.update({
        where: { id },
        data:
          state === "resolved"
            ? { status: "resolved", resolvedAt: now, resolution }
            : { status: "acknowledged", acknowledgedAt: now },
      });
      await tx.fallTransition.create({
        data: {
          fallId: id,
          userId: uid,
          action: state,
          occurredAt: occurred ? new Date(occurred) : null,
          resolution,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId: uid,
          action: `fall.${state}`,
          resourceType: "fall",
          resourceId: id,
        },
      });
      return x;
    });
    return this.shape(updated);
  }
}
