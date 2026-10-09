/**
 * What's silently inert on a real deployment. The "memory" providers log and
 * report success without sending anything — fine for dev/tests, a trap in
 * production. Pure so it can be unit-tested; main.ts logs the result at boot.
 */
export function deploymentWarnings(input: { devDb: boolean; emailProvider: string; notificationProvider: string }): string[] {
  if (input.devDb) return [];
  const out: string[] = [];
  if (input.emailProvider === "memory") {
    out.push("EMAIL_PROVIDER is 'memory' on a real deployment: no email (signup codes, password resets, order mail) is actually being sent. Set EMAIL_PROVIDER=resend + RESEND_API_KEY + EMAIL_FROM.");
  }
  if (input.notificationProvider === "memory") {
    out.push("NOTIFICATION_PROVIDER is 'memory' on a real deployment: no SMS/WhatsApp (customer 'My packages' login codes, order updates) is actually being sent. Configure Twilio.");
  }
  return out;
}
