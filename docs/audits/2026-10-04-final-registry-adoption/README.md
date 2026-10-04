# Allo: published SDK adoption

Source `56d3e81ee38efb348e7a1136d45ed03fc8738c6b` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"backendFiles": 2, "backendPassed": 16, "sdkImporterMembers": 6975, "bloomImporterMembers": 43882, "typesBuildExport": "passed"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Owned PostgreSQL was stopped and its PID absence verified.
- The earlier candidate frontend full suite reached 283 assertions without a clean exit. This proof does not convert it into a full-suite pass or repeat it without cause.
