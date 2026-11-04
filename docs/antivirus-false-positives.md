# Antivirus false positives

Some endpoint-protection products may quarantine TokenTracker files even when
the install came from an official release. Behavioral detections are vendor
judgments; a matching file hash alone does not prove why the alert fired or
that the vendor has cleared it.

## Kaspersky PDM:Trojan.Win32.Generic (#720)

Reports have flagged `~\.tokentracker\tracker\app\bin\tracker.js` as
`PDM:Trojan.Win32.Generic`. When the quarantined bytes match a published
release asset (including Windows CRLF line endings), treat the report as a
**suspected** false positive and keep the vendor ticket open until Kaspersky
(or equivalent) accepts a false-positive submission or signing coverage
removes the behavioral hit.

What TokenTracker maintainers can do:

- Keep Windows code signing and release hashes published with each release.
- File or refresh a Kaspersky false-positive report with the exact product
  version, detection name, and SHA-256 of the quarantined file.
- Do not close #720 solely because a hash matches an official build.

What users can try while the vendor review is pending (if local policy allows):

1. Confirm the quarantined path is under `~\.tokentracker\` (or the portable
   install directory) and compare its hash to the GitHub release asset for
   that version.
2. Restore the file from quarantine or reinstall from the official GitHub
   release — not from third-party mirrors.
3. Add a temporary exclusion for that path only if your security policy
   permits it; this is a workaround, not vendor clearance.
4. Prefer the signed installer when available.

A matching hash supports the suspected-false-positive hypothesis; it does not
substitute for vendor adjudication.
