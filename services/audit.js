const net = require('node:net');

// Stores an append-only audit event without accepting credentials or clinical payloads.
async function recordAccessEvent(client, req, {
  eventType,
  resourceType,
  resourceId = null,
  patientId = null,
  userId = req.session?.user?.id || null,
  details = {},
}) {
  const ipAddress = net.isIP(req.ip || '') ? req.ip : null;
  await client.query(
    `INSERT INTO access_audit_logs
       (user_id, patient_id, event_type, resource_type, resource_id, ip_address, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      userId,
      patientId,
      eventType,
      resourceType,
      resourceId === null ? null : String(resourceId),
      ipAddress,
      String(req.get('user-agent') || '').slice(0, 500),
      JSON.stringify(details),
    ]
  );
}

module.exports = { recordAccessEvent };
