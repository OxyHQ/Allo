# Deployment and native releases

Moved verbatim from the root `AGENTS.md`; the rules below are unchanged and binding.

Port `8080`, domain `api.allo.you`, ECR `oxy/allo`. Built from the `linux/arm64`
Dockerfile in `packages/backend/`. `.github/workflows/deploy-aws.yml` is the only
deployment. `server.ts` defaults to `4140` for local dev; ECS injects `PORT=8080`.

**The deploy DOES apply migrations, in both phases.** `deploy-aws.yml` passes
`RUN_MIGRATIONS: "true"` and two explicit commands — `--phase=pre` before the
rollout and `--phase=post` after it — each a one-shot ECS task running
`db:migrate --target-database=allo`. So merging a schema change ships it.
(`deploy-ecs-image.sh:17` still defaults `RUN_MIGRATIONS` to `false`; that is the
script's default for callers that do not set it, not this workflow's behaviour.)

What this buys is the whole point of the `-- oxy:deploy-phase=` marker every
generated `.sql` carries: `pre` is additive and lands while the OLD image is
still serving, `post` drops and narrows and lands only once the new one has
rolled. A migration whose marker is wrong is therefore applied at the wrong side
of the rollout rather than merely mislabelled.

**The boot gate knows the contract.** In production `server.ts` refuses to
start while a `pre` migration is pending and tolerates a pending `post` one
with a warning (`src/runtime/migrationGate.ts`), because during the rollout the
`post` one-shot has not run yet by design. The first platform release measured
the other behaviour: every new task died on the pending `0005` (post), ECS
rolled back, and the `post` one-shot never ran.

**Native apps.** `android-release.yml` (oxy's reusable workflow, on `seldon`)
builds and releases the signed AAB + APK as `android-v<version>` whenever
`packages/frontend` `version` has no release yet; `publish-update.yml` publishes
every other push to main as an OTA update (Oxy Updates, channel `production`,
GitHub trusted publishing, no secret). `version` is the OTA runtime and the
derived store build number (2.0.0 -> 2000000): bump it for a native change only.
Both builds take their environment from eas.json's `production` `env`.

