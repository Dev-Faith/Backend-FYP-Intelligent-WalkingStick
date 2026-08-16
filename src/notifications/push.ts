type PersistedFall = { id:string; occurredAt:Date; locationName:string; latitude:number; longitude:number; batteryLevel:number; contactName:string; contactPhone:string; severity:'high'|'critical' };
export function buildFallPush(token:string, fall:PersistedFall) {
  const data = { type:'FALL_ALERT' as const, version:2 as const, id:fall.id, timestamp:fall.occurredAt.toISOString(), locationName:fall.locationName, latitude:fall.latitude, longitude:fall.longitude, batteryLevel:fall.batteryLevel, contactName:fall.contactName, contactPhone:fall.contactPhone, severity:fall.severity };
  const push = { to:token, title:fall.severity==='critical'?'Critical fall alert':'Fall alert', body:`Fall reported at ${fall.locationName}`, priority:'high', sound:'default', channelId:'fall-alerts-v3', data };
  if (Buffer.byteLength(JSON.stringify(push)) >= 4096) throw new Error('Push payload exceeds 4 KiB');
  return push;
}
