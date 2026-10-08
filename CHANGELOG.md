# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-09-30

### Added

- **Plan limits with one middleware.** Add one middleware to a route and it refuses the request once the workspace reaches its plan limit, with the same response the Bridge frontend packages already understand, and records the usage after the request succeeds. Previously you had to check and report usage by hand.
- **A feature that is off says why.** When a flag keeps a route closed, the refusal now says whether the feature is not on the workspace's plan, not allowed for this user, or switched off, so your frontend can open the upgrade dialog, tell the user to ask an admin, or simply hide it.

### Changed

- **Auth core 0.8.** This version is built and tested against `@nebulr-group/bridge-auth-core` 0.8.
- **Shorter guides.** The integration guides now describe only the decisions you make, and a new page explains how plan limits, upgrades and customization work.

### Fixed

- **Documentation links.** Three documentation pages linked to addresses with no page behind them; they now resolve.
