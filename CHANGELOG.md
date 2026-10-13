# Changelog

## 0.3.1 — Fast jobs, OAuth continuity and initial public distribution

- `job_start` waits up to 500ms by default and can return fast command output in a single tool call.
- Rotating, one-time, client-bound OAuth refresh tokens with hash-only persistence, revocation and settings.
- Added dedicated ChatGPT Web docs, guarded installer flows, regression tests and GitHub CI.

## 0.3.0 — Core Flow

- Reduced the default surface to 16 purpose-built Core tools.
- Added bounded source list/read/search and read-only Git review.
- Added guarded multi-step edits/tests, better permission checks, retries and job recovery.
- Retained native ChatGPT file import and export; DC is optional.
