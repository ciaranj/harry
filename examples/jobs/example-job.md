# Job: Add a `--version` flag

## Goal
`harry --version` prints the version from `package.json` and exits 0, without
starting the interactive TUI.

## Verification
- `node build/index.js --version` prints the same version string as the
  `"version"` field in `package.json` and exits with code 0.
- `npm test` still passes.

## Vision
Harry currently has no way to report its own version. A standard `--version`
flag makes the CLI feel finished and helps when reporting bugs against a build.

## Plan
1. Read the version from `package.json` at startup.
2. Parse `--version` / `-v` in the CLI argument handling alongside the existing
   job-flag parsing, before rendering the TUI.
3. Print the version to stdout and exit 0 when the flag is present.

## Tasks
- [ ] Add argument parsing for `--version` / `-v`.
- [ ] Resolve the version from `package.json` (avoid hardcoding).
- [ ] Print it and exit 0 before any TUI render.
- [ ] Add a test covering the flag if a CLI test seam exists; otherwise verify manually.
- [ ] Confirm `npm test` and the build still pass.
