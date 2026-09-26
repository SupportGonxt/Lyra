// ADR-0091. The churn score on `orbit.renewal.due` is 0-100 (apps/api
// renewals.ts); below this a renewal is routine and not a marketing prospect.
// Core because both the SIGNAL consumer and the seed backfill read it.
export const PROSPECT_CHURN_FLOOR = 60;
