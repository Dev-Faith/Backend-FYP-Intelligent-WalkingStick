import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "crypto";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import mqtt, { MqttClient } from "mqtt";
import { PrismaService } from "../shared/prisma";
import { Envelope, IngestService } from "./ingest";

type SignedMessage = {
  envelope: Envelope;
  auth: { timestamp: string; signature: string };
};

@Injectable()
export class MqttIngestService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttIngestService.name);
  private client?: MqttClient;
  private connected = false;
  private readonly topics = [
    "wakatech/v1/devices/+/events/#",
    "wakatech/v1/devices/+/telemetry/heartbeat",
  ];

  constructor(
    private readonly db: PrismaService,
    private readonly ingest: IngestService,
  ) {}

  onModuleInit() {
    const url = process.env.MQTT_URL || "mqtt://localhost:1883";
    this.client = mqtt.connect(url, {
      clientId: `wakatech-api-${process.pid}`,
      clean: true,
      reconnectPeriod: 2_000,
      connectTimeout: 10_000,
      username: process.env.MQTT_USERNAME || undefined,
      password: process.env.MQTT_PASSWORD || undefined,
    });
    this.client.on("connect", () => {
      this.connected = true;
      this.client!.subscribe(this.topics, { qos: 1 }, (error) => {
        if (error)
          this.logger.error(`MQTT subscription failed: ${error.message}`);
        else {
          this.logger.log(`Subscribed to ${this.topics.join(", ")}`);
          void this.publishPendingSettings();
        }
      });
    });
    this.client.on("reconnect", () => {
      this.connected = false;
    });
    this.client.on("close", () => {
      this.connected = false;
    });
    this.client.on("error", (error) =>
      this.logger.error(`MQTT error: ${error.message}`),
    );
    this.client.on(
      "message",
      (topic, payload) => void this.handle(topic, payload),
    );
  }

  async onModuleDestroy() {
    if (this.client)
      await new Promise<void>((resolve, reject) =>
        this.client!.end(false, {}, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
  }

  isReady() {
    return this.connected;
  }

  async publishSettings(device: {
    hardwareId: string;
    credentialHash: string | null;
    sensitivity: string;
    graceSeconds: number;
    settingsVersion: number;
  }) {
    if (!device.credentialHash)
      throw new Error("Device has no active credential");
    if (!this.client || !this.connected)
      throw new Error("MQTT is not connected");
    const command = {
      schemaVersion: 1,
      commandId: randomUUID(),
      deviceId: device.hardwareId,
      commandType: "settings.update",
      issuedAt: new Date().toISOString(),
      version: device.settingsVersion,
      data: {
        fallSensitivity: device.sensitivity,
        falseAlarmGraceSeconds: device.graceSeconds,
      },
    };
    const payload = JSON.stringify(
      signMqttCommand(device.credentialHash, command),
    );
    const topic = `wakatech/v1/devices/${encodeURIComponent(device.hardwareId)}/commands/settings`;
    await new Promise<void>((resolve, reject) =>
      this.client!.publish(topic, payload, { qos: 1, retain: true }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    this.logger.log(
      `Published settings v${device.settingsVersion} for ${device.hardwareId}`,
    );
  }

  private async publishPendingSettings() {
    const devices = await this.db.device.findMany({
      where: { syncState: "pending", credentialHash: { not: null } },
      select: {
        hardwareId: true,
        credentialHash: true,
        sensitivity: true,
        graceSeconds: true,
        settingsVersion: true,
      },
    });
    for (const device of devices) {
      try {
        await this.publishSettings(device);
      } catch (error) {
        this.logger.warn(
          `Could not republish settings for ${device.hardwareId}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
    }
  }

  private async handle(topic: string, payload: Buffer) {
    try {
      if (payload.byteLength > 16_384)
        throw new Error("MQTT payload exceeds 16 KiB");
      const hardwareId = this.hardwareIdFromTopic(topic);
      const message = JSON.parse(payload.toString("utf8")) as SignedMessage;
      const envelope = plainToInstance(Envelope, message.envelope);
      const errors = await validate(envelope, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      if (errors.length) throw new Error("Invalid device envelope");
      if (envelope.deviceId !== hardwareId)
        throw new Error("Topic/device identity mismatch");
      await this.authenticate(hardwareId, message);
      const result = await this.ingest.ingestTrusted(hardwareId, envelope);
      this.logger.log(
        `MQTT ${envelope.eventType} accepted for ${hardwareId}; duplicate=${result.duplicate}`,
      );
    } catch (error) {
      this.logger.warn(
        `Rejected MQTT message on ${topic}: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  private hardwareIdFromTopic(topic: string) {
    const match =
      /^wakatech\/v1\/devices\/([^/]+)\/(?:events\/(fall|activity|walk-session|settings-applied)|telemetry\/(heartbeat))$/.exec(
        topic,
      );
    if (!match)
      throw new Error("Topic is outside the allowed device namespace");
    return decodeURIComponent(match[1]);
  }

  private async authenticate(hardwareId: string, message: SignedMessage) {
    const device = await this.db.device.findUnique({
      where: { hardwareId },
      select: { credentialHash: true },
    });
    if (!device?.credentialHash)
      throw new Error("Device has no active credential");
    if (!message.auth?.timestamp || !message.auth.signature)
      throw new Error("Missing message authentication");
    const publishedAt = Date.parse(message.auth.timestamp);
    if (
      !Number.isFinite(publishedAt) ||
      Math.abs(Date.now() - publishedAt) > 5 * 60_000
    ) {
      throw new Error(
        "Authentication timestamp is outside the five-minute window",
      );
    }
    const signed = `${message.auth.timestamp}.${JSON.stringify(message.envelope)}`;
    const expected = createHmac("sha256", device.credentialHash)
      .update(signed)
      .digest();
    const supplied = Buffer.from(message.auth.signature, "hex");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("Invalid device signature");
    }
  }
}

export function signMqttEnvelope(
  secret: string,
  envelope: object,
  timestamp = new Date().toISOString(),
) {
  const key = createHash("sha256").update(secret).digest("hex");
  const signature = createHmac("sha256", key)
    .update(`${timestamp}.${JSON.stringify(envelope)}`)
    .digest("hex");
  return { envelope, auth: { timestamp, signature } };
}

export function signMqttCommand(credentialHash: string, command: object) {
  const signature = createHmac("sha256", credentialHash)
    .update(JSON.stringify(command))
    .digest("hex");
  return { command, auth: { signature } };
}
