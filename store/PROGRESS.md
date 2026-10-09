# Progress log — store-readiness branch

| Phase | Outcome |
|-------|---------|
| Facts & baseline | Read the real code; corrected two earlier mistaken diagnoses (deploy "stuck"; email "unconfigured") |
| Account deletion | Done for all four login types, 14 API tests + 3 e2e |
| Legal pages | Done, DRAFT-bannered, grounded in what the code does |
| Reviewer access | Script written and verified locally (dispatcher sees only demo business); courier signs in by email because the demo phone number failed validation |
| Boot warnings | Done, 4 tests |
| Security audit | 15/15 rules proven; found and fixed cross-company user takeover, proof-photo access, logout push leak |
| e2e determinism | 8 order-dependent failures → 0; two clean runs of 50 |
| Courier search | API + Team-page search box, 3 tests incl. tenant isolation |
| Listing kit | Text, Data Safety/App Privacy drafts, screenshots, feature graphic |
| Android bundle | Verified: unsigned and no JDK here — blocker logged |
| Apple | Plan only (needs owner) |
