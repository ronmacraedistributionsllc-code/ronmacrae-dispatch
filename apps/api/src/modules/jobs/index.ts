/**
 * Jobs backend barrel.
 *
 * The dispatcher-facing routes are `jobRoutes`; the domain functions below are
 * the building blocks reused by the tracking and bearer modules (and by tests):
 *   create / update        create.ts
 *   assign / unassign      assign.ts
 *   transition / cancel / return   transition.ts
 *   recordCollection       payment.ts
 *   tracking links + history       history.ts
 *   repository helpers     repository.ts
 *   DTO mappers + visibility       dto.ts
 */
export { jobRoutes } from "./routes.js";
export { proofRoutes } from "./proofs.js";

export { CreateJobBody, UpdateJobBody, createJob, updateJob, viewerFor, type CreateJobInput, type UpdateJobInput } from "./create.js";
export { AssignBody, assignJob, unassignJob, type AssignInput } from "./assign.js";
export {
  TransitionBody,
  transitionJob,
  recordRiderStage,
  cancelJob,
  createReturnJob,
  type TransitionInput,
} from "./transition.js";
export {
  CollectBody,
  recordCollection,
  derivePaymentStatus,
  resolveCollection,
  type CollectInput,
} from "./payment.js";
export {
  createTrackingLink,
  revokeTrackingLinkByToken,
  jobEventHistory,
  customerStatusHistory,
} from "./history.js";

export {
  listJobs,
  countJobs,
  getJobRow,
  getJobByNumber,
  nextJobNumber,
  formatJobNumber,
  listEvents,
  listAssignments,
  activeJobsForRider,
  activeJobCount,
  latestRiderPoint,
  returnJobFor,
  isUniqueViolation,
  type JobListFilter,
} from "./repository.js";

export {
  jobToDto,
  jobSummaryToDto,
  proofToDto,
  eventToDto,
  assignmentToDto,
  linkToDto,
  actorType,
  jobInclude,
  type Actor,
  type Viewer,
  type JobRow,
} from "./dto.js";
