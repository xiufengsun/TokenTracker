# Antivirus false positives

Some endpoint-protection products may quarantine TokenTracker files even when the
bytes match a published release. This is a vendor detection issue, not proof that
the install was modified.

## Kaspersky PDM:Trojan.Win32.Generic (#720)

Reports have flagged `~\.tokentracker\tracker\app\bin\tracker.js` as
`PDM:Trojan.Win32.Generic`. When the file hash matches the official release
artifact (including Windows CRLF line endings), treat it as a false positive.

What TokenTracker maintainers can do:

- Keep Windows code signing and release hashes published with each release.
- File or refresh a Kaspersky false-positive report with the exact product
  version, detection name, and SHA-256 of the quarantined file.

What users can do until the vendor clears the signature:

1. Confirm the quarantined path is under `~\.tokentracker\` (or the portable
   install directory) and that its hash matches the release notes / GitHub
   release asset.
2. Restore the file from quarantine or reinstall from the official GitHub
   release.
3. Add an exclusion for that path in Kaspersky if your policy allows it.
4. Prefer the signed installer when available; do not download TokenTracker from
   third-party mirrors.

This issue remains open until Kaspersky (or equivalent AV vendors) accept the
false-positive submission or signing coverage removes the behavioral hit. A
matching hash alone does not close the vendor ticket.
