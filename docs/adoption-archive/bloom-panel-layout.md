# Pending Bloom panel-layout adoption — archive only

This branch preserves an experimental consumer patch; it is not a release-ready
migration or a published-package validation. Do not merge it unchanged.

Consumer base: `8fc349e8bbfc8195960e98324371cb9bda9f0797`.
Original patch SHA256: `137b6a7bc83acd0f9923b5d1dbe04c7b00a89db35ced9b1fbcb12e6b9bcbba45`.
The manifest and lockfile deliberately retain their published dependencies.
The current main observed while archiving was
`cc2e239e546fbe359bc3a79ad2878017ef110619`; subsequent session-recovery work is
not included in this historical base. Its chat layout is unchanged from this base.

The patch moves the existing joined panels into AppShell's descriptor-owned
panel layout. It requires Bloom's descriptor-surface backing fix (originally
reviewed in OxyHQ/Bloom#556) before adoption. Published Bloom 15.53.0 was restored
after the experiment and the original consumer's published typecheck passed.
No dependency is pinned to an invented future version here.

Experimental Bloom snapshot: package version 15.78.3, source-tree SHA256
`435fd019ded31a404fa8df1e750d98794d152dd83760c9ff60e6bc76a6560d30`, AppShellPanelLayout fingerprint SHA256
`f059d96c2e9d0df21aa828f285a8f178cf5572c3e83a8db162ff5c80532293ed`. The version alone is not a sufficient pin;
the identical start/end source fingerprints define the tested snapshot.

Historical validation used Allo's actual guest harness: desktop 1440×900 and
mobile 390×900 loaded without page errors and interaction checks passed.
The same-artifact migration comparison changed 368 desktop pixels and 364
mobile pixels (dynamic content regions); it was not pixel-identical.
Upgrading from the old published package to the experimental package was a
separate comparison and changed 12,353 desktop pixels and 691 mobile pixels.
These are separate questions; neither result validates a later release.

Before integration: rebase onto current main, identify the real published
release containing the shared fix, update dependencies normally, and repeat
browser, geometry, interaction and published-package checks. No merge, npm
publication or deployment was performed while archiving. The archive worktree
is returned to its clean base after the branch is pushed.
