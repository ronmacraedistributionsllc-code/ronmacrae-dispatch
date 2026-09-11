/**
 * API route contract. The web app and the future React Native bearer app
 * build against these paths/shapes; the API implements them.
 */
export const API = {
  health: "/api/health",

  auth: {
    login: "/api/auth/login",
    refresh: "/api/auth/refresh",
    logout: "/api/auth/logout",
    me: "/api/auth/me",
    totpEnroll: "/api/auth/totp/enroll",
    totpVerify: "/api/auth/totp/verify",
    password: "/api/auth/password",
  },

  jobs: {
    list: "/api/jobs",
    create: "/api/jobs",
    get: (id: string) => `/api/jobs/${id}`,
    update: (id: string) => `/api/jobs/${id}`,
    transition: (id: string) => `/api/jobs/${id}/transition`,
    events: (id: string) => `/api/jobs/${id}/events`,
    assign: (id: string) => `/api/jobs/${id}/assignments`,
    cancel: (id: string) => `/api/jobs/${id}/cancel`,
    return: (id: string) => `/api/jobs/${id}/return`,
    /** rider/staff records cash collected from the customer */
    collect: (id: string) => `/api/jobs/${id}/collect`,
  },

  /** COD reconciliation ledger (Stage 12 / spec item 5A) */
  cod: {
    /** dispatcher/accountant/owner board: all cod jobs, filterable by status */
    list: "/api/cod",
    /** rider/staff records cash handed in to the office for one job */
    handIn: (jobId: string) => `/api/jobs/${jobId}/cod/hand-in`,
    /** accountant/owner sign-off */
    approve: (jobId: string) => `/api/jobs/${jobId}/cod/approve`,
    /** accountant/owner flags a discrepancy */
    dispute: (jobId: string) => `/api/jobs/${jobId}/cod/dispute`,
    /** append-only audit trail for one job's reconciliation */
    events: (jobId: string) => `/api/jobs/${jobId}/cod/events`,
  },

  riders: {
    list: "/api/riders",
    create: "/api/riders",
    get: (id: string) => `/api/riders/${id}`,
    update: (id: string) => `/api/riders/${id}`,
    status: (id: string) => `/api/riders/${id}/status`,
    locations: "/api/rider-locations",
    locationsFor: (riderId: string) => `/api/rider-locations/${riderId}`,
    report: (riderId: string) => `/api/rider-locations/${riderId}/report`,
  },

  /** dispatcher operations board — spec 5C */
  opsBoard: "/api/ops-board",

  customers: {
    list: "/api/customers",
    create: "/api/customers",
    get: (id: string) => `/api/customers/${id}`,
    update: (id: string) => `/api/customers/${id}`,
    search: "/api/customers/search",
  },

  zones: {
    list: "/api/zones",
    create: "/api/zones",
    get: (id: string) => `/api/zones/${id}`,
    update: (id: string) => `/api/zones/${id}`,
    delete: (id: string) => `/api/zones/${id}`,
    detect: "/api/zones/detect",
    fareRules: "/api/zones/fare-rules",
  },

  routes: {
    optimize: "/api/routes/optimize",
    list: "/api/routes",
    get: (id: string) => `/api/routes/${id}`,
    dispatch: (id: string) => `/api/routes/${id}/dispatch`,
  },

  quotes: {
    create: "/api/quotes",
    /** public (rate limited) - used by the customer delivery-request page */
    public: "/api/quotes/public",
  },

  /** public geocoding (rate limited); simulated fallback when no map provider */
  geo: {
    geocode: "/api/geo/geocode",
    reverse: "/api/geo/reverse",
  },

  /** public delivery request (the store customer) */
  deliveryRequests: {
    create: "/api/delivery-requests",
  },

  tracking: {
    /** public, no auth */
    get: (token: string) => `/api/tracking/${token}`,
    create: (jobId: string) => `/api/tracking/${jobId}`,
    revoke: (token: string) => `/api/tracking/${token}/revoke`,
    /** delivery messaging, customer side — spec 5G, tracking-link-gated */
    messages: (token: string) => `/api/tracking/${token}/messages`,
    addressChange: (token: string) => `/api/tracking/${token}/address-change`,
  },

  /** Cross-business customer package dashboard (spec 4) — public, no login;
   *  request-code/verify are phone-ownership-gated, the dashboard itself is
   *  gated by the short-lived token they return (sent as a Bearer header,
   *  not a login session — see lib/jwt.ts's CustomerDashboardTokenPayload). */
  customerDashboard: {
    requestCode: "/api/customer-dashboard/request-code",
    verify: "/api/customer-dashboard/verify",
    get: "/api/customer-dashboard",
  },

  /** delivery messaging (spec 5G) — staff side */
  messages: {
    list: (jobId: string) => `/api/jobs/${jobId}/messages`,
    send: (jobId: string) => `/api/jobs/${jobId}/messages`,
    addressChangeRequests: (jobId: string) => `/api/jobs/${jobId}/address-change-requests`,
    approveAddressChange: (jobId: string, reqId: string) => `/api/jobs/${jobId}/address-change-requests/${reqId}/approve`,
    declineAddressChange: (jobId: string, reqId: string) => `/api/jobs/${jobId}/address-change-requests/${reqId}/decline`,
    /** rider side — same shape, own job only */
    bearerList: (jobId: string) => `/api/bearer/jobs/${jobId}/messages`,
    bearerSend: (jobId: string) => `/api/bearer/jobs/${jobId}/messages`,
    bearerAddressChange: (jobId: string) => `/api/bearer/jobs/${jobId}/address-change`,
  },

  proofs: {
    upload: (jobId: string) => `/api/jobs/${jobId}/proofs`,
    signedUrl: (key: string) => `/api/proofs/${key}`,
  },

  notifications: {
    list: "/api/notifications",
    get: (id: string) => `/api/notifications/${id}`,
    retry: (id: string) => `/api/notifications/${id}/retry`,
    status: "/api/notifications/provider",
    /** configurable message templates — spec 5D */
    templates: "/api/notifications/templates",
  },

  recon: {
    daily: "/api/recon/daily",
    resolve: (id: string) => `/api/recon/daily/${id}`,
  },

  payouts: {
    list: "/api/payouts",
    draft: "/api/payouts/draft",
    get: (id: string) => `/api/payouts/${id}`,
    approve: (id: string) => `/api/payouts/${id}/approve`,
    pay: (id: string) => `/api/payouts/${id}/pay`,
  },

  sos: {
    create: "/api/sos",
    list: "/api/sos",
    acknowledge: (id: string) => `/api/sos/${id}/acknowledge`,
    resolve: (id: string) => `/api/sos/${id}/resolve`,
  },

  /** owner/accountant operating reports — spec 5E. (This scaffold pre-dates
   *  that stage; reused rather than duplicated once the routes were
   *  actually implemented.) */
  reports: {
    summary: "/api/reports/summary",
    csv: "/api/reports/jobs.csv",
  },

  settings: {
    get: "/api/settings",
    business: "/api/settings/business",
    updateBusiness: "/api/settings/business",
  },

  audit: {
    list: "/api/audit",
  },

  /** Platform-owner-only (Stage 23) — see modules/owner.ts. No console UI
   *  consumes these yet (a documented, deliberate gap, same as the rest of
   *  the owner console — see WORK_IN_PROGRESS.md); the routes exist and
   *  are fully tested. */
  owner: {
    audit: "/api/owner/audit",
    customerIdentityDuplicates: "/api/owner/customer-identities/duplicates",
    mergeCustomerIdentity: (id: string) => `/api/owner/customer-identities/${id}/merge`,
  },

  woo: {
    status: "/api/woo/status",
    orders: "/api/woo/orders",
  },

  users: {
    list: "/api/users",
    create: "/api/users",
    update: (id: string) => `/api/users/${id}`,
  },

  /** bearer-scoped */
  bearer: {
    me: "/api/bearer/me",
    jobs: "/api/bearer/jobs",
    cash: "/api/bearer/cash",
    status: "/api/bearer/status",
    accept: (id: string) => `/api/bearer/jobs/${id}/accept`,
    decline: (id: string) => `/api/bearer/jobs/${id}/decline`,
    transition: (id: string) => `/api/bearer/jobs/${id}/transition`,
    stage: (id: string) => `/api/bearer/jobs/${id}/stage`,
    offers: "/api/bearer/offers",
    acceptOffer: (id: string) => `/api/bearer/offers/${id}/accept`,
    declineOffer: (id: string) => `/api/bearer/offers/${id}/decline`,
    /** rider sets their own intended work order for their active jobs (spec 5B) */
    reorder: "/api/bearer/jobs/reorder",
    /** "Contact dispatch" button — spec 5F */
    dispatchContact: (jobId: string) => `/api/bearer/dispatch-contact?jobId=${encodeURIComponent(jobId)}`,
  },

  offers: {
    list: (jobId: string) => `/api/jobs/${jobId}/offers`,
    broadcast: (jobId: string) => `/api/jobs/${jobId}/offers/broadcast`,
    withdraw: (id: string) => `/api/offers/${id}/withdraw`,
    rebroadcast: (jobId: string) => `/api/jobs/${jobId}/offers/rebroadcast`,
  },

  /** Opt-in browser push (Web Push / VAPID). */
  push: {
    publicKey: "/api/push/public-key",
    subscribe: "/api/push/subscribe",
    unsubscribe: "/api/push/unsubscribe",
  },
} as const;

/** WebSocket endpoint (token passed as query param for simplicity + refresh handled client-side). */
export const WS_PATH = "/ws";
