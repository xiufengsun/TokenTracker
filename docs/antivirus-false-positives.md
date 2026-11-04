# Antivirus false positives

Some endpoint-protection products may quarantine TokenTracker files even when
the install came from an official release. Behavioral detections are vendor
judgments; a matching file hash alone does not prove why the alert fired or
that the vendor has cleared it.

## Kaspersky PDM:Trojan.Win32.Generic (#720)

Reports have flagged `~\.tokentracker\tracker\app\bin\tracker.js` as
`PDM:Trojan.Win32.Generic`. When the quarantined bytes match a published
release asset (including Windows CRLF line endings), treat the report as a
**suspected** false positive. Matching bytes establish release identity, not
why a behavioral PDM alert fired. Keep the vendor ticket open pending
Kaspersky’s adjudication of the detection.

What TokenTracker maintainers can do:

- Keep Windows code signing and release hashes published with each release.
- File or refresh a Kaspersky false-positive report with the exact product
  version, detection name, and SHA-256 of the quarantined file.
- Do not close #720 solely because a hash matches an official build.

While vendor review is pending:

1. Confirm the quarantined path is under `~\.tokentracker\` (or the portable
   install directory) and compare its hash to the GitHub release asset for
   that version.
2. Share the detection details and matching hash with Kaspersky or your
   security administrator. A matching hash alone is not a recommendation to
   restore the file or bypass the detection.
3. Follow their guidance on whether to restore, reinstall, or use a narrowly
   scoped temporary exclusion. These workarounds may not prevent another PDM
   alert and do not establish vendor clearance. If reinstalling, use the
   official GitHub release rather than a third-party mirror.
4. Check signing information when available, but do not treat a signature as
   a guarantee against behavioral detections or a reason to close #720.

A matching hash supports the suspected-false-positive hypothesis; it does not
substitute for vendor adjudication.
