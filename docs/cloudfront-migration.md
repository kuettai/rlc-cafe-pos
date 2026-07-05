# CloudFront Migration Plan

Adds CloudFront in front of the frontend + API for geo-restriction and a
shared-secret front door. This document is the checklist for the migration;
the CDK changes and DNS cutover need manual/staged execution rather than
being rolled out atomically.

## Current architecture

```
Customer browser
    │
    ├─ https://153.oasisofcare.org/         (frontend)   →  GitHub Pages
    └─ https://<api>.execute-api.<region>.amazonaws.com/prod/   →  API Gateway → ApiHandler Lambda
```

- **Frontend**: `frontend/` published via GitHub Pages, custom domain `153.oasisofcare.org` (CNAME to `kuettai.github.io`).
- **API**: Regional API Gateway `hcydppml1a.execute-api.ap-southeast-5.amazonaws.com`, invoked via CORS from the frontend. `API_BASE` hard-coded in `frontend/js/config.js`.
- **No edge security**: API is publicly reachable from anywhere; frontend is served worldwide by GitHub Pages CDN.

## Target architecture

```
Customer browser  (MY / SG only, enforced by CloudFront)
    │
    ▼
CloudFront distribution  d123abc.cloudfront.net  ←→  153.oasisofcare.org
    │
    ├─ default   →  S3 bucket (static frontend, migrated off GitHub Pages)
    └─ /api/*    →  API Gateway origin
                       │
                       │  X-Origin-Verify: <secret>   (added by CloudFront)
                       ▼
                    ApiHandler Lambda  (rejects requests missing the header)
```

Guarantees added:
- **Geo restriction**: `restrictions.geoRestriction.allowlist('MY', 'SG')` blocks non-MY/SG requests at the edge with a 403 before reaching the origin.
- **Direct-API lockdown**: Lambda enforces `X-Origin-Verify` matches `ORIGIN_VERIFY_SECRET`. Requests hitting API Gateway directly (bypassing CloudFront) are 403'd.

## Backend groundwork (already committed, feature-flagged off)

The Lambda check exists but is disabled until CloudFront is live:

- `backend/src/index.ts`: reads `ENFORCE_ORIGIN_HEADER` (default `false`). When `true`, requires `X-Origin-Verify` header to match `ORIGIN_VERIFY_SECRET`.
- `infra/lib/infra-stack.ts`: two new Lambda env vars — `ORIGIN_VERIFY_SECRET` (placeholder) and `ENFORCE_ORIGIN_HEADER` (`false`).

## Migration steps (do in this order)

### 1. Frontend hosting: move off GitHub Pages to S3

The current GitHub Pages hosting can't be an origin for CloudFront in a way we control (no shared-secret injection, no origin access identity). Migrate the static site to S3.

- New CDK: `Bucket` (private, static site enabled), `BucketDeployment` from `frontend/`, `OriginAccessIdentity`.
- Verify manually that all relative URLs still resolve.
- Keep GitHub Pages running in parallel until CloudFront cutover, then remove `frontend/CNAME` and let GitHub Pages 404.

### 2. ACM certificate in us-east-1

CloudFront requires the ACM certificate to live in `us-east-1` regardless of where the stack is deployed.

- Create an ACM cert for `153.oasisofcare.org` (and optionally `*.oasisofcare.org`) in `us-east-1`.
- Validate via DNS (add CNAMEs to the DNS provider that hosts `oasisofcare.org`).
- Reference in CDK via `Certificate.fromCertificateArn(...)`.

### 3. CloudFront distribution (CDK)

Add to `infra/lib/infra-stack.ts`:

- `Distribution`:
  - default behavior → S3 origin (frontend bucket, OAI-restricted, cached).
  - additional behavior `/api/*` → REST API origin (`RestApiOrigin(api)`), forwards all methods, no caching, forwards required headers (Authorization, Content-Type). Origin custom header `X-Origin-Verify: <secret>` added via `originRequestPolicy` + `originCustomHeaders`.
  - `restrictions: { geoRestriction: GeoRestriction.allowlist('MY','SG') }`.
  - `domainNames: ['153.oasisofcare.org']`, `certificate: acmCert`.
  - `priceClass: PriceClass.PRICE_CLASS_100` (US/EU/Asia only; cheapest that includes SG).
- Store the shared secret in AWS Secrets Manager (or SSM SecureString) and read it into both:
  - Lambda `ORIGIN_VERIFY_SECRET` env var, and
  - CloudFront origin custom header value.

### 4. DNS cutover

- Update the DNS record for `153.oasisofcare.org` from `CNAME → kuettai.github.io` to `CNAME → d123abc.cloudfront.net`.
- Watch propagation. Existing GitHub Pages URL keeps working for old caches.
- After 24–48 hours with no reports of issues, remove `frontend/CNAME`.

### 5. Enforce the origin header

Once CloudFront is verifiably injecting the header and traffic is flowing through it:

- Rotate `ORIGIN_VERIFY_SECRET` to a strong random value (e.g. 32 bytes base64) in both places.
- Set Lambda env `ENFORCE_ORIGIN_HEADER=true`.
- Redeploy.
- Verify: `curl https://<api>.execute-api.../prod/api/menu` → 403; `curl https://153.oasisofcare.org/api/menu` → 200.

## Rollback

- CloudFront misbehaving: revert DNS back to `kuettai.github.io`. Frontend keeps working; API keeps working (no header enforcement yet if step 5 hasn't run).
- Header enforcement broken: set `ENFORCE_ORIGIN_HEADER=false` and redeploy Lambda. Traffic flows again immediately.

## Cost note

CloudFront + WAF + geo restriction adds a small monthly cost (~USD 1–5 at
this traffic level) but is required for the security posture. ACM certs are
free. Data transfer through CloudFront is billed but at Asia edge pricing.

## Related feature-flag env vars (already in place)

| Var                    | Default                                | Purpose                                             |
|------------------------|----------------------------------------|-----------------------------------------------------|
| `ORIGIN_VERIFY_SECRET` | `CHANGE_ME_WHEN_CLOUDFRONT_ENABLED`    | Value CloudFront injects and Lambda compares to.    |
| `ENFORCE_ORIGIN_HEADER`| `false`                                | Turn header check on. Only flip after step 4 works. |
