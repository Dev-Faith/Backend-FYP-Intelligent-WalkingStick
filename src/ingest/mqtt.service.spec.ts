import { createHash, createHmac } from "crypto";
import { signMqttCommand, signMqttEnvelope } from "./mqtt.service";

describe("MQTT device signing", () => {
  it("signs the timestamp and exact envelope with the provisioned device key", () => {
    const secret = "test-device-secret";
    const envelope = { schemaVersion: 1, messageId: "msg-1", deviceId: "WK-1" };
    const timestamp = "2026-08-17T20:00:00.000Z";
    const signed = signMqttEnvelope(secret, envelope, timestamp);
    const key = createHash("sha256").update(secret).digest("hex");
    const expected = createHmac("sha256", key)
      .update(`${timestamp}.${JSON.stringify(envelope)}`)
      .digest("hex");
    expect(signed).toEqual({
      envelope,
      auth: { timestamp, signature: expected },
    });
  });

  it("signs a retained backend command with the provisioned credential hash", () => {
    const credentialHash = createHash("sha256")
      .update("test-device-secret")
      .digest("hex");
    const command = {
      schemaVersion: 1,
      commandId: "command-1",
      deviceId: "WK-1",
      commandType: "settings.update",
      version: 2,
      data: { fallSensitivity: "high", falseAlarmGraceSeconds: 20 },
    };
    const expected = createHmac("sha256", credentialHash)
      .update(JSON.stringify(command))
      .digest("hex");
    expect(signMqttCommand(credentialHash, command)).toEqual({
      command,
      auth: { signature: expected },
    });
  });
});
