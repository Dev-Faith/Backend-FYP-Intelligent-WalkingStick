import "dotenv/config";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import mqtt from "mqtt";
import { signMqttEnvelope } from "../src/ingest/mqtt.service";

const hardwareId = process.env.SEEDED_HARDWARE_ID || "WK-2026-000042";
const secret = process.env.SEEDED_DEVICE_SECRET;
if (!secret) throw new Error("SEEDED_DEVICE_SECRET is required");
const credentialHash = createHash("sha256").update(secret).digest("hex");
const commandTopic = `wakatech/v1/devices/${hardwareId}/commands/settings`;
const acknowledgementTopic = `wakatech/v1/devices/${hardwareId}/events/settings-applied`;
const client = mqtt.connect(process.env.MQTT_URL || "mqtt://localhost:1883");
const timer = setTimeout(() => {
  console.error("No retained settings command arrived within 15 seconds");
  process.exitCode = 1;
  client.end();
}, 15_000);

client.on("connect", () => client.subscribe(commandTopic, { qos: 1 }));
client.on("message", (_topic, payload) => {
  try {
    const message = JSON.parse(payload.toString("utf8"));
    const expected = createHmac("sha256", credentialHash)
      .update(JSON.stringify(message.command))
      .digest();
    const supplied = Buffer.from(message.auth?.signature || "", "hex");
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      throw new Error("Invalid backend command signature");
    }
    if (
      message.command?.deviceId !== hardwareId ||
      message.command?.commandType !== "settings.update"
    ) {
      throw new Error("Invalid settings command identity or type");
    }
    const now = new Date().toISOString();
    const envelope = {
      schemaVersion: 1,
      messageId: `settings-ack-${Date.now()}`,
      deviceId: hardwareId,
      eventType: "settings.applied",
      occurredAt: now,
      sequence: Date.now(),
      bootId: "settings-simulator-boot",
      firmwareVersion: "1.0.0",
      data: { version: message.command.version, status: "applied" },
    };
    client.publish(
      acknowledgementTopic,
      JSON.stringify(signMqttEnvelope(secret, envelope)),
      { qos: 1 },
      (error) => {
        clearTimeout(timer);
        if (error) {
          console.error(error);
          process.exitCode = 1;
        } else {
          console.log(
            `Applied and acknowledged settings v${message.command.version}: ${JSON.stringify(message.command.data)}`,
          );
        }
        client.end();
      },
    );
  } catch (error) {
    clearTimeout(timer);
    console.error(error);
    process.exitCode = 1;
    client.end();
  }
});
client.on("error", (error) => {
  clearTimeout(timer);
  console.error(error);
  process.exitCode = 1;
});
