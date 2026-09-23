# 06 — Roles & User Journeys

## 1. Role catalogue (RBAC keys)

Platform (goNXT staff):
- `platform.admin` — tenants, entitlements, billing, DLQ, global flags.
- `platform.support` — impersonate-with-consent (logged), read diagnostics.
- `platform.engineer` — deploys, migrations (via CI identity, not UI).

Tenant staff:
- `tenant.admin` — users/roles, brand, policies, integrations, billing view.
- `tenant.compliance` — audit exports, consent registry, approval policies,
  creative flag lane, AI audit log.
- `axis.agent` · `axis.lead` · `axis.admin`
- `orbit.agent` · `orbit.lead` · `orbit.retention` · `orbit.partners` · `orbit.admin`
- `signal.marketer` · `signal.lead` · `signal.admin`
- `scout.pm` · `scout.lead` · `scout.admin`
- `north.exec` · `north.analyst` · `north.board` (read-only packs) · `north.admin`
- `dev.developer` — dev consoles, keys (test), sandbox; `dev.admin` — live keys.

External:
- `customer` — consumer identity (hosted pages, chat, self-serve portal).
- `partner.developer` / `partner.manager` — ORBIT partner portal.
- `provider.viewer` — insurer read access to SCOUT data products bought.

Every role maps to a permission bundle in packages/core/rbac.ts; module admin
⊂ tenant admin for that module's settings; sensitive data (PII) requires
`core:pii:view` regardless of role.

## 2. Journey maps (trigger → steps → success metric)

### Consumer
- **J-C1 Get covered (web/mobile web):** land (SIGNAL page) → 3-field quick
  quote → ranked offers (declared criteria visible) → docs via camera →
  pay (PSP redirect) → policy in WhatsApp + email. *Success:* < 10 min,
  same-session issuance. AI: extraction, next-best-question.
- **J-C2 Get help (WhatsApp):** message in ar/en → ORBIT agent resolves
  (policy copy, endorsement, FNOL guidance) → CSAT tap. *Success:* containment
  w/o human ≥ 70%, CSAT ≥ 4.5.
- **J-C3 Renew in one tap:** T-30 offer with pre-run requote → one-tap accept
  → updated policy delivered. *Success:* retention +pts; zero forms re-entered.
- **J-C4 Exercise privacy rights:** portal request (access/erasure) →
  automated package/erasure workflow → confirmation. *Success:* < 30 days,
  fully logged.

### Ops (AXIS)
- **J-O1 Exception clearing:** login → Exceptions queue (only failed
  automations) → copilot-drafted resolutions → clear. *Success:* exceptions
  < 10% of cases; median clear < 15 min.
- **J-O2 Group medical bid:** census upload (any format) → normalised + gaps
  chased automatically → provider pack out same day → quotes compared →
  proposal PDF. *Success:* days→hours cycle.
- **J-O3 Month-end recon:** import statements → auto-match → exceptions with
  evidence → sign-off bundle. *Success:* match ≥ 95%, close in 1 day.

### CX & Retention (ORBIT)
- **J-X1 Handover catch:** AI escalates mid-chat → human console opens with
  summary + suggested action → resolve → QA score visible next day.
- **J-X2 Save desk:** churn-risk list → call with objection cards + bounded
  price-match (approval-gated) → outcome logged. *Success:* save rate.
- **J-X3 Partner integration (external dev):** portal signup → sandbox key →
  mock quote in < 30 min → certification checklist → live key. *Success:*
  first live bind < 4 weeks.

### Marketing (SIGNAL)
- **J-M1 Campaign in a day:** brief → 20 ar/en variants → compliance lane →
  publish → cockpit shows CAC by evening. 
- **J-M2 Budget morning:** approve/undo autopilot moves from mobile in 2 min.
- **J-M3 Own the answer box:** pick query cluster → AEO content unit →
  citation share trend over 8 weeks.

### Product (SCOUT)
- **J-P1 Radar quarterly:** review promoted whitespaces → pick 1 → experiment
  live in a week → validated/parked with evidence. 
- **J-P2 Panel negotiation:** bench alert → negotiation pack → meeting →
  commission/coverage delta logged.

### Executive (NORTH)
- **J-E1 The 7am read (mobile):** push → Brief (2 min read) → tap anomaly →
  assign action → done before coffee. *Success:* daily open > 70%.
- **J-E2 Board Thursday:** assemble pack (10 min) → approve → distribute →
  read receipts before meeting.
- **J-E3 What-if:** ask scenario → ranges + assumptions → save → revisit at
  review date with actuals overlay.

### Admin & Dev
- **J-A1 New tenant in a day (platform.admin):** create tenant → brand upload
  (contrast auto-check) → entitlements → domain → invite tenant.admin →
  synthetic smoke suite green.
- **J-A2 New teammate (tenant.admin):** invite → role bundle → module access
  visible instantly; SSO group mapping optional.
- **J-A3 Incident pause (any module admin):** one-click pause module agents →
  banner shows degraded mode → resume with audit note.
- **J-D1 First API call (dev):** dev portal → test key → SDK snippet →
  webhook tester green → promote to live (dev.admin approval).
- **J-CO1 Regulator request (compliance):** scope query → export signed audit
  bundle (cases/conversations/AI log) → delivered. *Success:* same day.

## 3. Journey instrumentation

Every journey has: an ID (above), an analytics funnel (Analytics Engine),
an owner, and a target. The J-IDs appear in code as event `journey` tags —
Claude Code: tag emitted events accordingly so funnels assemble without extra
work. Journey health surfaces in NORTH's platform section automatically.

**As built (2026-09-23).** Journey health is read from the audit log rather
than from new event tags: `packages/core/src/journey-health.ts` maps each
measurable journey's steps to audit actions that live code already writes,
`GET /v1/north/journeys` serves the funnels, and `/north/journeys` shows them
(stalled first, weekly finishes, a link to where the work happens). J-E1 (push
and brief reads are not audited), J-A1 (tenant creation is seed-only) and J-M3
(citation share is not recorded) are not measured yet; each needs the missing
step recorded before it can be.
