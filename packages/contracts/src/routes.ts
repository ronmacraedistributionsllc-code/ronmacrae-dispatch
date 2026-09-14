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
    /** deleted-orders trash (spec 8, Stage 26) — soft-delete only, ever;
     *  see schema.prisma's own note on Job.deletedAt for why. */
    trash: "/api/jobs/trash",
    delete: (id: string) => `/api/jobs/${id}/delete`,
    restore: (id: string) => `/api/jobs/${id}/restore`,
  },

  /** COD reconciliation ledger (Stage 12 / spec item 5A) */
  cod: {
    /** dispatcher/accountant/owner board: all cod jobs, filterable by status.
     *  Excludes archived entries by default — pass `includeArchived=true`. */
    list: "/api/cod",
    /** rider/staff records cash handed in to the office for one job */
    handIn: (jobId: string) => `/api/jobs/${jobId}/cod/hand-in`,
    /** accountant/owner sign-off */
    approve: (jobId: string) => `/api/jobs/${jobId}/cod/approve`,
    /** accountant/owner flags a discrepancy — body now requires `type` (CodDisputeType) alongside `note` */
    dispute: (jobId: string) => `/api/jobs/${jobId}/cod/dispute`,
    /** append-only audit trail for one job's reconciliation */
    events: (jobId: string) => `/api/jobs/${jobId}/cod/events`,
    /** Stage 38: housekeeping-only, hides a settled (approved) entry from
     *  the day-to-day board — never a delete, always reversible via unarchive. */
    archive: (jobId: string) => `/api/jobs/${jobId}/cod/archive`,
    unarchive: (jobId: string) => `/api/jobs/${jobId}/cod/unarchive`,
    /** business-wide shortage/overage rollup, see CodSummaryDto */
    summary: "/api/cod/summary",
  },

  riders: {
    list: "/api/riders",
    create: "/api/riders",
    get: (id: string) => `/api/riders/${id}`,
    update: (id: string) => `/api/riders/${id}`,
    status: (id: string) => `/api/riders/${id}/status`,
    /** public — no login required */
    signup: "/api/rider-signup",
    signupVerify: "/api/rider-signup/verify",
    signupResend: "/api/rider-signup/resend",
    pending: "/api/riders/pending",
    decide: (id: string) => `/api/riders/${id}/decide`,
    locations: "/api/rider-locations",
    locationsFor: (riderId: string) => `/api/rider-locations/${riderId}`,
    report: (riderId: string) => `/api/rider-locations/${riderId}/report`,
    /** staff view of a rider's cash profile — this business's own slice
     *  only (spec 9, Stage 27). */
    cash: (riderId: string) => `/api/riders/${riderId}/cash`,
  },
  merchantSignup: {
    signup: "/api/merchant-signup",
    verify: "/api/merchant-signup/verify",
    resend: "/api/merchant-signup/resend",
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
    /** public (rate limited) - a side-effect-free delivery-fee preview for
     *  the public order form, before the customer commits to submitting. */
    public: "/api/quotes/public",
  },

  /** Store/merchant clients of the courier business (e.g. "VBR Basics") —
   *  distinct from Business (the courier itself). Staff-managed; the public
   *  order form only ever sees the narrower MerchantPublicDto via `public`. */
  merchants: {
    list: "/api/merchants",
    create: "/api/merchants",
    get: (id: string) => `/api/merchants/${id}`,
    update: (id: string) => `/api/merchants/${id}`,
    /** public, no auth — resolves a slug for the /order/:slug page */
    public: (slug: string) => `/api/merchants/public/${slug}`,
    products: (merchantId: string) => `/api/merchants/${merchantId}/products`,
    /** admin-only: grants (or updates the password for) this merchant's
     *  own portal login — see merchantPortal below, the "face" that uses it. */
    grantStaff: (merchantId: string) => `/api/merchants/${merchantId}/staff`,
  },

  /** A merchant's own login — its own auth "face" (a merchant_portal
   *  token, not a staff access token), scoped to exactly one merchant.
   *  See merchant-portal.ts. */
  merchantPortal: {
    login: "/api/merchant-portal/login",
    me: "/api/merchant-portal/me",
    orders: "/api/merchant-portal/orders",
    /** book a delivery on behalf of a customer (POST), scoped to this merchant */
    createOrder: "/api/merchant-portal/orders",
    /** assign one of this merchant's own couriers to one of its own orders */
    assignRider: (jobId: string) => `/api/merchant-portal/orders/${jobId}/assign`,
    products: "/api/merchant-portal/products",
    createProduct: "/api/merchant-portal/products",
    updateProduct: (id: string) => `/api/merchant-portal/products/${id}`,
    deleteProduct: (id: string) => `/api/merchant-portal/products/${id}`,
    /** Jumps to staff/rider access on the same account, if any — no
     *  second password entry (see auth.ts's own switchToMerchant). */
    switchToStaff: "/api/merchant-portal/switch-to-staff",
    rate: (jobId: string) => `/api/merchant-portal/orders/${jobId}/rate`,
    /** "Message the owner" (spec: "admin-to-anyone") — same GET/POST path. */
    ownerMessages: "/api/merchant-portal/messages/owner",
    /** Merchant rider management (spec: merchant rider roster) — the
     *  many-to-many MerchantRider relationship, scoped to this merchant. */
    riders: "/api/merchant-portal/riders",
    riderSearch: "/api/merchant-portal/riders/search",
    addRider: "/api/merchant-portal/riders",
    removeRider: (riderId: string) => `/api/merchant-portal/riders/${riderId}`,
  },

  /** Fleet-supplier clients of the courier business (spec: "Bearer/
   *  Logistics companies") — the other side of the marketplace from
   *  merchants. Staff-managed, same pattern as `merchants` above. */
  logisticsCompanies: {
    list: "/api/logistics-companies",
    create: "/api/logistics-companies",
    get: (id: string) => `/api/logistics-companies/${id}`,
    update: (id: string) => `/api/logistics-companies/${id}`,
    /** admin-only: grants (or updates the password for) this company's own
     *  portal login — see logisticsPortal below. */
    grantStaff: (id: string) => `/api/logistics-companies/${id}/staff`,
  },

  /** A logistics company's own login — its own auth "face" (a
   *  logistics_portal token, not a staff access token), scoped to exactly
   *  one LogisticsCompany. See logistics-portal.ts. */
  logisticsPortal: {
    login: "/api/logistics-portal/login",
    me: "/api/logistics-portal/me",
    riders: "/api/logistics-portal/riders",
    switchToStaff: "/api/logistics-portal/switch-to-staff",
    /** "Message the owner" (spec: "admin-to-anyone") — same GET/POST path. */
    ownerMessages: "/api/logistics-portal/messages/owner",
    /** Fleet messaging (spec: "logistics<->riders") — same GET/POST path,
     *  only for a rider actually attached to this company. */
    riderMessages: (riderId: string) => `/api/logistics-portal/riders/${riderId}/messages`,
  },

  products: {
    create: (merchantId: string) => `/api/merchants/${merchantId}/products`,
    update: (id: string) => `/api/products/${id}`,
    delete: (id: string) => `/api/products/${id}`,
    /** public, no auth — the catalog for one merchant's order page */
    public: (merchantSlug: string) => `/api/merchants/public/${merchantSlug}/products`,
  },

  /** The main public multi-item order form (spec: PUBLIC ORDER, no login,
   *  no app). `create`/`quote` with no slug book against the courier
   *  business's own default storefront (the old single-item `/book` flow's
   *  successor); with a slug they book against that merchant. */
  order: {
    quote: "/api/order/quote",
    create: "/api/order",
    createForMerchant: (merchantSlug: string) => `/api/order/${merchantSlug}`,
  },

  /** Rider cash-to-office settlements, batched per rider+merchant — see
   *  SettlementDto's own doc comment for how this differs from `payouts`. */
  settlements: {
    list: "/api/settlements",
    create: "/api/settlements",
    outstanding: (riderId: string) => `/api/riders/${riderId}/settlements/outstanding`,
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
    /** delivery messaging, customer side — spec 5, tracking-link-gated.
     *  `kind` is a ConversationKind (Stage 24) the customer is a party to
     *  (customer_dispatch or customer_rider) — the literal "legacy" path
     *  reaches the read-only, pre-Stage-24 archive instead. */
    messages: (token: string, kind: string) => `/api/tracking/${token}/messages/${kind}`,
    conversations: (token: string) => `/api/tracking/${token}/conversations`,
    addressChange: (token: string) => `/api/tracking/${token}/address-change`,
    /** public, tracking-token-gated — rate the rider after "delivered" */
    rate: (token: string) => `/api/tracking/${token}/rate`,
    /** public, tracking-token-gated — rate the merchant after "delivered" */
    rateMerchant: (token: string) => `/api/tracking/${token}/rate-merchant`,
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

  /** Optional email+password account, additive on top of the phone-OTP
   *  dashboard session above (spec 7, Stage 25). claim/resendVerification
   *  require a customer-dashboard Bearer token; the rest are public,
   *  gated by the email code or password presented. */
  customerAccount: {
    status: "/api/customer-account/status",
    claim: "/api/customer-account/claim",
    resendVerification: "/api/customer-account/resend-verification",
    verifyEmail: "/api/customer-account/verify-email",
    login: "/api/customer-account/login",
    requestPasswordReset: "/api/customer-account/request-password-reset",
    resetPassword: "/api/customer-account/reset-password",
  },

  /** delivery messaging (spec 5) — staff side. Staff may read all three
   *  ConversationKinds (customer_rider is monitor-only, see
   *  ConversationSummaryDto.canWrite) but only ever writes into
   *  customer_dispatch/rider_dispatch. */
  messages: {
    list: (jobId: string, kind: string) => `/api/jobs/${jobId}/messages/${kind}`,
    send: (jobId: string, kind: string) => `/api/jobs/${jobId}/messages/${kind}`,
    conversations: (jobId: string) => `/api/jobs/${jobId}/conversations`,
    addressChangeRequests: (jobId: string) => `/api/jobs/${jobId}/address-change-requests`,
    approveAddressChange: (jobId: string, reqId: string) => `/api/jobs/${jobId}/address-change-requests/${reqId}/approve`,
    declineAddressChange: (jobId: string, reqId: string) => `/api/jobs/${jobId}/address-change-requests/${reqId}/decline`,
    /** rider side — same shape, own job only, customer_rider/rider_dispatch */
    bearerList: (jobId: string, kind: string) => `/api/bearer/jobs/${jobId}/messages/${kind}`,
    bearerSend: (jobId: string, kind: string) => `/api/bearer/jobs/${jobId}/messages/${kind}`,
    bearerConversations: (jobId: string) => `/api/bearer/jobs/${jobId}/conversations`,
    bearerAddressChange: (jobId: string) => `/api/bearer/jobs/${jobId}/address-change`,
    /** Non-job-scoped "message the owner" (spec: "admin-to-anyone") — any
     *  signed-in staff/rider (own access token), same GET/POST path. */
    owner: "/api/messages/owner",
  },

  /** Platform Admin's own side of `messages.owner` — its inbox across
   *  every user who has messaged in, and each thread. */
  platformMessages: {
    threads: "/api/platform/messages",
    thread: (userId: string) => `/api/platform/messages/${userId}`,
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

  /** Real invite/onboarding — see invites.ts. `check`/`accept` are public
   *  (the token itself is the credential); everything else is admin-only,
   *  scoped to the caller's own business (and its own merchants). */
  invites: {
    list: "/api/invites",
    createStaff: "/api/invites/staff",
    createMerchant: (merchantId: string) => `/api/invites/merchant/${merchantId}`,
    resend: (id: string) => `/api/invites/${id}/resend`,
    revoke: (id: string) => `/api/invites/${id}/revoke`,
    check: (token: string) => `/api/invites/check/${token}`,
    accept: "/api/invites/accept",
  },

  /** Platform-owner-only console (spec: "search, inspect, approve,
   *  block, disable, archive, reactivate, and manage every registered
   *  business and person") — see platform-admin.ts. Gated by
   *  `platformRole: "owner"`, not a business-scoped staff role. */
  platform: {
    businesses: "/api/platform/businesses",
    updateBusiness: (id: string) => `/api/platform/businesses/${id}`,
    merchants: "/api/platform/merchants",
    updateMerchant: (id: string) => `/api/platform/merchants/${id}`,
    logisticsCompanies: "/api/platform/logistics-companies",
    updateLogisticsCompany: (id: string) => `/api/platform/logistics-companies/${id}`,
    riders: "/api/platform/riders",
    rider: (id: string) => `/api/platform/riders/${id}`,
    updateRider: (id: string) => `/api/platform/riders/${id}`,
    /** many-to-many rider<->merchant assignment (owner-only) */
    assignRiderToMerchant: (riderId: string) => `/api/platform/riders/${riderId}/merchants`,
    removeRiderFromMerchant: (riderId: string, merchantId: string) => `/api/platform/riders/${riderId}/merchants/${merchantId}`,
    staff: "/api/platform/staff",
    updateUser: (id: string) => `/api/platform/users/${id}`,
    audit: "/api/platform/audit",
    moderateRating: (id: string) => `/api/platform/ratings/${id}`,
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
    /** Fleet messaging with the rider's own attached logistics company
     *  (spec: "logistics<->riders") — 404 if not currently attached to one. */
    logisticsMessages: "/api/bearer/logistics-messages",
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
