/**
 * Prominent-disclosure copy for background location (Google Play policy).
 * Kept in ONE constants file so the human can edit the wording without
 * touching the sharing logic. Plain words, no jargon.
 */
export const LOCATION_DISCLOSURE = {
  title: "Share your location in the background?",
  what: "Ronmacrae Dispatch will record your phone's location.",
  when: "Only while you are sharing during an active delivery — including when the screen is off or the app is in the background. Sharing stops when the delivery ends, or when you tap “Stop sharing location”.",
  why: "So dispatch can see where you are and customers get accurate arrival times.",
  who: "Only the dispatch staff of your business can see your location.",
  howToStop: "You can stop at any time: tap “Stop sharing location” here, or turn it off from the notification.",
  confirm: "I understand — start sharing",
  cancel: "Not now",
} as const;

export const LOCATION_ONGOING_TITLE = "Sharing location for your active delivery";
export const LOCATION_ONGOING_MESSAGE =
  "Dispatch can see where you are while you deliver. Turn off sharing to stop.";

export const BATTERY_HINT = {
  title: "Keep location sharing alive",
  body: "Phones often pause apps running in the background to save battery. If dispatch stops seeing your location mid-delivery, open App info → Battery and choose Unrestricted for Ronmacrae Dispatch.",
  openSettings: "Open app settings",
  dismiss: "Don't show again",
} as const;

export const SHARING_INTERRUPTED =
  "Sharing stopped while the app was closed — tap “Share my location” to resume. Nothing was recorded while it was off.";

export const NO_ACTIVE_DELIVERY =
  "Location sharing is available while you have an active delivery. Accept or receive a job first, then come back here.";
