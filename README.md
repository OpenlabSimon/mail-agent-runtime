# @openbnb/mail-agent-runtime

[![Verify Dist](https://github.com/OpenlabSimon/mail-agent-runtime/actions/workflows/verify-dist.yml/badge.svg)](https://github.com/OpenlabSimon/mail-agent-runtime/actions/workflows/verify-dist.yml)

Reusable mail-agent runtime primitives.

## What is in this package

- `mail-transport`: a file-backed transport and shared `MessageTransport` types
- `imap-transport`: Gmail IMAP/SMTP transport
- `marketplace-service`: approval-gated sqlite marketplace state machine
- `dubai-listings-service`: read-only Dubai listing search over the collector DB

## Build

```bash
npm install
npm run build
```

Build output goes to `dist/`.

## Reuse

This repository is intended to stand on its own:

- run `npm install && npm run build`
- keep `dist/` committed so GitHub installs work without a local build
- consume it from another project through GitHub

## Install From GitHub

The repository includes committed `dist/` output so GitHub dependency installs
do not need a local build step.

```bash
npm install github:OpenlabSimon/mail-agent-runtime
```

Or in `package.json`:

```json
{
  "dependencies": {
    "@openbnb/mail-agent-runtime": "github:OpenlabSimon/mail-agent-runtime"
  }
}
```

## Example

```ts
import {
  FileTransport,
  ImapTransport,
  MarketplaceService,
  DubaiListingsService,
} from "@openbnb/mail-agent-runtime";
```

## Notes

- The package is framework-agnostic. It does not include the Anthropic agent loop.
- `DubaiListingsService` is Dubai-specific by design and expects the existing collector schema.
- `dist/` is checked into git on purpose so GitHub installs can resolve `main` and `types` immediately.
- CI only verifies `src` and committed `dist` stay in sync. npm publishing is intentionally not configured.
- License: MIT. See `LICENSE`.
