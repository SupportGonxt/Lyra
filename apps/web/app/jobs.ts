// The role -> jobs table lives in @lyra/core so the phone reads the same one
// (packages/core/src/jobs.ts). Re-exported so the web keeps one import path.
export { JOB, JOBS_BY_ROLE, NO_JOBS, SHELLED_MODULES, jobsFor, opens, type Job } from "@lyra/core/jobs";
