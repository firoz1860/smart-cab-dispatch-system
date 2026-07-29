/** Thin wrapper around the browser Notification API so key real-time events
 * (matched with a driver, driver arrived, etc.) reach the guest even if the
 * tab isn't focused, on top of the in-app banner. Fails silently anywhere
 * Notifications aren't available/granted - it's a supplement to the in-app
 * UI, never a requirement for correctness. */

export function requestNotificationPermission(): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

export function notify(title: string, body?: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    // Some contexts (e.g. non-HTTPS) throw on construction - ignore.
  }
}
