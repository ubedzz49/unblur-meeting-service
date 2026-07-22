---
name: coding-standards
description: Use this skill for ANY coding task on Unblur — writing new code, editing existing code, reviewing code, or making commits/PRs. It defines how to comment code, how to secure payment/recording/PII-related code, which design principles to follow, and how to structure git commits and PRs. Always apply this skill automatically for every code change, not just when the user explicitly asks for "clean code" or "secure code" — treat it as the default way of working, especially anything touching payments, auth, recordings, or money.
---

# Coding Standards — Unblur

These are non-negotiable defaults for every piece of code touched on this project, not just when asked for specifically.

## 1. Comments — human, not AI-flavored

- Write comments the way a tired senior dev would, not the way an LLM would. No "This function handles the calculation of the total price" fluff.
- Use `--` (or the language's closest equivalent, e.g. `//` in Go/JS, `#` in Python/Ruby) for inline notes, the way a human dev jots a quick note — not decorative banner comments (`// ============`), not emoji, not restating the function signature.
- Every comment says **what this specific snippet does**, right above or beside it — not what the whole file/service does, not the "why we split services this way" backstory, not a tutorial.
- Skip comments on lines that are self-explanatory (`i++ -- increment counter` is noise). Comment the non-obvious: a tricky regex, a workaround, an off-by-one, a business rule that isn't visible from the code itself (e.g. the 1/10th speaking-time cap, the 15-minute recording TTL, the 10% platform fee split).
- No comment should ever restate the code in English. Bad: `// set fee to 10 percent`. Good: `// 10% platform cut -- matches payment service's fee split (03_tech_stack.txt)`.
- Keep casing/punctuation loose and human (lowercase starts, no trailing period), e.g.:
  ```go
  // 15 min from session end -- matches recording retention policy, not arbitrary
  expiresAt := sessionEndedAt.Add(15 * time.Minute)
  ```
- Don't leave comments explaining what you, the AI, did ("added this to fix bug"). Comments describe the code's current behavior, not the edit history — that's what commit messages are for.

## 2. Payment / security-sensitive code

Treat anything touching payments (Payment Service), auth (User Service), recordings/PII (Recording & Moderation Service, AI Notes Service), or money splits as high-risk by default. Current research (2025–26) shows AI-generated code has meaningfully higher vulnerability rates than human code, concentrated in exactly these areas — so slow down here specifically.

**Hard rules:**
- **Never hardcode secrets, API keys, tokens, or credentials** (Razorpay/Stripe keys, video-provider API keys, JWT signing secrets, S3 credentials) in code, config committed to git, or logs. Use environment variables / a secrets manager. Add a `.env.example` with placeholder names, never real values.
- **Never let the agent (or logs) see raw credentials.** Route auth through a proxy/vault pattern rather than passing tokens through prompts, debug output, or error messages.
- **Validate and sanitize every external input** at the boundary (parameterized queries only, no string-built SQL; strict schema validation on API payloads and webhooks — doubt attachments, GD vote payloads, resolution request slots, etc.).
- **Verify webhook signatures** before trusting any payload — payment webhooks (Razorpay/Stripe) and video-provider webhooks (recording-ready, session-ended events from Daily/Twilio/Jitsi/Zoom). Never process an unverified webhook.
- **Idempotency keys on all money-moving operations** — 1-on-1 charge, seminar entry, GD organizer pay-first, GD entry fee, resolver/host/organizer payouts — so retries can't double-charge or double-pay.
- **Least privilege everywhere** — DB users and service-to-service API keys get only the scopes they need (e.g. Feed Service should only read doubts/user_expertise, never write payments).
- **Encrypt in transit (TLS) and at rest.** Never store raw card numbers/CVVs — use the payment processor's tokenized vault. Recordings and transcripts are PII: encrypt at rest in S3, and enforce the 15-minute TTL deletion job as a hard guarantee, not best-effort — a failed delete job is a compliance bug, not a warning log.
- **Audit-log** money-moving actions and recording-retention decisions (who/what/when/amount, or who/what/when/retained-or-discarded), but never log full card numbers, CVVs, auth tokens, or raw transcript content in application logs.
- **Don't trust AI-suggested dependencies blindly** — verify a package actually exists and is the real, actively-maintained one before adding it (slopsquatting risk).
- **Rate-limit and require re-auth/step-up confirmation** for high-impact actions (large seminar/GD payouts, changing payout destination, deleting a recording before its complaint window closes).
- Prefer the payment/video provider's official SDK over hand-rolled crypto, hand-rolled auth, or hand-rolled webhook verification.
- After generating anything in this category, do a self-review pass explicitly checking: secrets exposure, injection points, access-control boundaries, and missing input validation.
- Flag payment/auth/recording/AI-notes code as needing **human review before merge**, even if it looks correct — don't self-certify these as done.

## 3. Design principles

Apply these by default, not just when asked:

- **SOLID** — single responsibility per service/module (this maps directly onto the 9-service split in `02_architecture.txt` — don't let one service reach into another's tables), small focused interfaces, depend on abstractions (e.g. a `VideoProvider` interface so Daily/Twilio/Jitsi/Zoom are swappable) not concretions.
- **DRY** — no copy-pasted logic across services; shared validation (e.g. expertise/level checks) lives in one place per service, not re-implemented per endpoint.
- **ACID-aware** — any code touching a DB transaction, especially Payment Service splits (platform fee + resolver/host/organizer share) or Resolution Service booking-creation, wraps the multi-step operation in a single DB transaction; roll back fully on partial failure, never leave a booking "accepted" with no payment recorded or vice versa.
- **DDD where it fits** — model `Booking`, `Payment`, `Recording`, `GD`/`SpeakingState` as real entities with behavior, not anemic rows manipulated by scattered utility functions. Keep the GD speaking-time/mute rules inside the GD domain layer, not smeared across the WebSocket handler.
- **Design patterns** — Strategy for swappable video/payment providers, Repository for data access per service, Observer/event-driven for session-end fanout (Recording → AI Notes Service). Don't force a pattern where a plain function is clearer.
- **Scalability/reliability defaults** — stateless services (GD real-time state lives in Redis, not in-process memory, so any instance can handle a reconnect), retries with backoff + idempotency for calls to Meeting/Payment/AI providers, graceful degradation (e.g. if AI Notes pipeline fails, session still completes — notes retry as a background job, don't block the user).
- Favor readability and small functions over cleverness. Reusable > one-off. Explicit > implicit.

## 4. Git workflow

- **GitHub account:** always commit and push as `ubedzz49`. Confirm the local git config (`user.name` / `github username`) and remote match this account before pushing; don't push under a different identity.
- **Branch per feature/service-track** — one branch per PR from `ROADMAP_UNBLUR.md` / `ROADMAP_GATEWAY.md` (e.g. `feat/user-otp-flow`, `feat/gd-speaking-timer`), never commit large feature work directly to `main`.
- **One PR per feature**, not one giant PR bundling unrelated changes — matches the PR-sized breakdown in the roadmap docs. PR description: what changed, why, and how it was tested — short and plain, not a template wall of text.
- **Commit messages written like a human wrote them**, not an AI:
  - Short, lowercase-ish, imperative mood: `add idempotency key to gd organizer payment`, not `Implemented Idempotency Key Feature For GD Organizer Payment To Prevent Duplicate Charges`.
  - No emoji, no "Generated by AI", no filler ("This commit adds...").
  - Split unrelated changes into separate commits rather than one mega-commit.
  - Example pattern: `fix: recording ttl job skipped rows with pending complaints` / `refactor: extract fee-split calc into shared helper`.
- Open the PR against the feature branch → base branch (`main`, confirm per repo), and don't merge payment/auth/recording-touching PRs without a human approval, per the security rules above.
- **Never push directly to `main`.** Every change, including docs-only and config fixes, goes through a branch and a PR, even when it would be faster to push straight to `main`. This applies regardless of who or what is pushing — a small fix is still a PR.
- **Never delete a branch after its PR merges.** Keep the branch around even though GitHub offers to delete it on merge — don't use `--delete-branch` on merge, and don't delete it manually afterward. History and the ability to look back at exactly what a branch contained is worth more than a tidy branch list.
- **PR titles and descriptions are for outside readers, not internal shorthand.** Never put our internal track codes (A3, K2, B4, etc.) or roadmap doc filenames in a PR title or description — nobody outside this project knows what those mean, and they don't age well either. Say what the PR actually does in plain words instead, e.g. "Add OTP send and verify with email delivery" not "A3: OTP flow (see ROADMAP_UNBLUR.md)". It's fine to keep tracking those codes in STATUS.md or in your own head, just not in anything GitHub-facing.
- **Keep PR descriptions brief and in plain human writing.** A few short sentences or a short bullet list is enough: what changed, and how it was tested. Don't write like a spec document. Avoid the double-dash (`--`) as a sentence-joiner or aside marker — write normal sentences instead ("note: X" or a period and a new sentence, not "X -- Y").

## 5. CI/CD — every repo, every commit

- **Every service repo gets a CI workflow from its first commit** (scaffold PR), not added later. No repo merges to `main` without one.
- **CI runs on every push and every PR**, minimum steps: lint/vet → test → build. A repo with no tests yet still gets the workflow wired up; the first real PR adds the first test, it doesn't wait for "enough code to test."
- **`main` is branch-protected**: the CI status check is a required check before merge (`gh api .../branches/main/protection` with `required_status_checks`). This is enforced at the GitHub level, not just a convention in this doc — a PR cannot merge with a red or pending check.
- **Test coverage is a merge gate, not a nice-to-have**: a PR that adds an endpoint/handler adds a test for it in the same PR. Reviewers (human or self-review pass) reject PRs that add behavior with zero test coverage, same tier as the payment/auth review gate in section 2.
- **CI (test/build) and CD (deploy) are separate workflows.** CI runs on every push/PR unconditionally. Deploy only triggers after CI succeeds on `main` (`workflow_run` with `types: [completed]` and a `conclusion == 'success'` check) — a failing test can never reach a build-and-push step.
- Reference implementation: `unblur-gateway-core` and `unblur-user-service` both have `.github/workflows/ci.yml` (test gate) and `.github/workflows/deploy.yml` (build+push, gated on CI). Copy this split for every new service repo.

## 6. Secrets in public repos — no static keys, anywhere

All Unblur service repos are **public**. Treat that as the default, not an exception — never assume "we'll add secrets later, it's fine for now."

- **Never store long-lived cloud credentials as GitHub Actions secrets**, even in a public repo's Settings → Secrets (secrets are hidden from logs but the value still exists somewhere and can leak via a misconfigured workflow, a compromised action, or a typo'd `echo`). Static AWS access keys are treated the same as hardcoded credentials — not allowed, full stop.
- **Use GitHub OIDC → cloud IAM role instead.** GitHub issues a short-lived OIDC token per workflow run; the cloud role trusts only that token, scoped to specific repos (and optionally branches/environments) via a `sub` claim condition. No secret ever exists at rest — nothing to leak, nothing to rotate.
  - AWS: an IAM OIDC identity provider for `token.actions.githubusercontent.com` + an IAM role whose trust policy's `StringLike` condition on `token.actions.githubusercontent.com:sub` lists exactly the repos allowed to assume it (e.g. `repo:ubedzz49/unblur-gateway-core:*`). Workflow uses `aws-actions/configure-aws-credentials` with `role-to-assume`, `permissions: id-token: write`.
  - The role itself gets least-privilege policies for what that pipeline actually does (e.g. ECR push + App Runner deploy) — never attach `AdministratorAccess` to a CI role.
- **Runtime app secrets** (DB passwords, Razorpay/Stripe keys, JWT signing secret, video-provider API keys) never go in the repo, in a Dockerfile, or in a committed `.env` — only in the deploy environment's secret store (e.g. AWS Secrets Manager / SSM Parameter Store), injected at runtime. `.env.example` in the repo has placeholder names only.
- Before adding any new CI/CD capability that needs cloud access, default to extending the existing OIDC role's permissions rather than minting a new static key — ask if unsure whether a permission add is broad enough to warrant a fresh look.

## 7. Logging — every backend service, structured, leveled

Every backend service (gateway, User Service, and every service added later) logs with a real
structured logger and standard levels — not scattered `console.log`/`fmt.Println`/`log.Printf`
calls with no level attached. This applies to backend/API services; the frontend is covered
separately below.

- **Levels, used for what they actually mean**, not just `info` for everything:
  - `debug` — detail only useful while actively debugging (a resolved route, a cache hit/miss).
    Off by default in production.
  - `info` — a normal thing happened worth a record (server started, OTP sent, user created,
    request routed). The default level in production.
  - `warn` — something recoverable but worth a human's attention (a retried request, a
    deprecated field still in use, a slow response).
  - `error` — something failed and needs looking at (a DB query failed, an upstream call errored,
    a panic was recovered). Always includes enough context to act on — which request, which user
    (id, never PII like full email/phone in the log line itself), what failed and why.
- **Structured, not string-concatenated** — a real logging library that emits fields (JSON in
  production, human-readable in local dev), not `fmt.Sprintf` into a single message string. For
  Go services: the standard library's `log/slog`. For Node services: Fastify's built-in `pino`
  logger (just needs enabling — don't reach for a second logging library when the framework
  already has one wired in).
- **Never log secrets or full credentials** — no passwords, tokens, API keys, OTP codes, or full
  card numbers in a log line, ever, matching the payment/security rules in section 2. Log an
  identifier (user id, request id), not the sensitive value itself.
- **Every request-handling path logs at least at `info` on success and `error` on failure** — a
  handler that silently swallows an error (catches it just to return a generic 500) without
  logging it is treated as a bug, same tier as missing test coverage.
- **Frontend**: this structured-logging rule is a backend expectation. The frontend's own runtime
  errors are handled via its normal error-boundary/toast patterns (see `FRONTEND_ARCHITECTURE.md`);
  don't bolt a backend-style structured logger onto client-side code.

## 8. Architecture decisions get logged, by default, the same day

Whenever a change is made to *how* the system is built rather than just *what* was added — a new
shared-infra default (reusing a DB/cache/cluster vs. provisioning a new one), a new trust boundary
(services trusting a gateway-verified header instead of re-verifying auth themselves), choosing
one technical approach over another where a real alternative existed (embeddings vs. rule-based
matching, ECS vs. App Runner, OIDC vs. static keys) — log it in `ARCHITECTURE_DECISIONS.md`
(`~/Downloads/Unblur-Implementation/ARCHITECTURE_DECISIONS.md`) as its own entry: the decision,
the reasoning, and what it changes for work that comes after it. Do this automatically, without
being asked — it's a default part of finishing the change, the same way a test is.

- **Don't wait to be asked.** If you're the one making the call (not just implementing something
  the user explicitly specified down to the mechanism), write the entry before considering the
  task done.
- **Update `VERSION_PLAN.md` too, if the decision changes how a future version's own plan should
  read** — e.g. deciding that services trust a gateway-injected `X-User-Id` header means every
  future service's plan entry should say so, not silently rely on someone remembering the decision
  lives in a separate file. See `VERSION_PLAN.md`'s Version 3 entry for the pattern to follow.
- **A decision log entry is not a status update.** `STATUS.md` tracks what's done vs. remaining
  and changes constantly; `ARCHITECTURE_DECISIONS.md` tracks *why things are built the way they
  are* and should stay stable — write for someone reading it months later trying to understand why
  a later choice was made a certain way, not for someone tracking this week's progress.
- **Skip it for pure implementation detail with no real alternative considered** — not every
  function name or file layout choice is an architecture decision. The bar: would a different,
  equally reasonable engineer have plausibly made a different call here, and would future work
  need to know which way it went? If yes, log it.

## 9. Test coverage — edge cases and security, not just the happy path

Every feature's tests must cover more than "it works when everything is valid." Treat the
following as a standard checklist for any new endpoint, form, or user-facing flow — not every
item applies every time, but each one should be a deliberate decision to skip, not an oversight:

- **Invalid/malformed input**: wrong types, missing required fields, extra unexpected fields,
  malformed JSON, wrong content-type.
- **Boundary values**: empty string vs. minimum-length string, exactly-at-limit vs.
  one-over-the-limit (e.g. a field with a 200-char max gets tested at 200 and 201), zero vs.
  negative numbers where only positive makes sense, empty arrays vs. arrays at/over a max size.
- **Auth and authorization**: missing token, expired/malformed token, a valid token for the
  *wrong* user attempting an action scoped to someone else (e.g. user A trying to read/modify
  user B's resource by guessing/enumerating an id) — every ownership check needs a test proving
  it's actually enforced, not just that the happy path works for the resource's real owner.
- **Injection and untrusted-string handling**: any user-supplied string that reaches a SQL query,
  a shell command, or gets echoed into a response should have a test asserting it's handled
  safely (parameterized queries, no string concatenation) — a literal `'; DROP TABLE` or `<script>`
  style payload in a test input is a legitimate and expected test case, not paranoia.
- **Empty / null / oversized payloads**: an empty body where one is required, explicit `null` for
  optional fields, a request body far larger than anything realistic. For any no-body endpoint
  (DELETE, or a POST/PATCH action route with nothing to send), test it with `Content-Type:
  application/json` explicitly set alongside the empty body — real browser/`fetch` clients send
  that header unconditionally regardless of body, and Fastify's default JSON parser rejects an
  empty body whenever it's present. A `curl` without the header, or an `inject()` test that omits
  it, will not catch this — it was a real, live bug across multiple services before this rule
  existed (see `ARCHITECTURE_DECISIONS.md`).
- **Duplicate / concurrent requests** where relevant: double-submitting the same create/mutate
  request (idempotency), two requests racing to change the same row.
- **Negative case for every validation rule** — if a rule says "X is required," there must be a
  test proving X-missing is rejected, not just that X-present is accepted. A validation rule with
  no test proving it actually rejects bad input is unverified, not implemented.

This is a default expectation for every PR from here forward, at the same tier as the test-gating
rule in section 5 — a PR that only tests the happy path is treated as under-tested, not done.
