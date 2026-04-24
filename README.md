# @openbnb/mail-agent-runtime

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

## Publish or copy

This repository is intended to stand on its own:

- run `npm install && npm run build`
- publish with `npm publish`
- or consume it from another project as a normal npm package

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
- License: MIT. See `LICENSE`.
