# Project Instructions

## Release & Version Policy (Mandatory)
- Baseline version starts at `6.2.5`.
- Whenever you make any code, configuration, or asset update to this plugin, you MUST:
  1. Bump the version number in both `package.json` and `package-lock.json` (increment patch version by 1, e.g. `6.2.5` -> `6.2.6`, unless the user specifies a different version).
  2. Run `npm run build` to verify TypeScript compilation and build `build/translate-for-zotero.xpi` + `build/update.json`.
  3. Sync `build/update.json` to `update.json`.
  4. Commit all changes to `main`, create the corresponding Git tag `v<version>`, and push both `main` and `v<version>` to GitHub (`origin`: `https://github.com/wxs0625/translate-for-zotero.git`).
  5. Verify the GitHub Release `v<version>` (with `translate-for-zotero.xpi`) and the `release` manifest release (with `update.json`) are published on GitHub.
