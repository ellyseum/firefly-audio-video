# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately):
open this repository's Security tab and click **Report a vulnerability**. Do not open a public
issue for a suspected vulnerability.

Include, where known:

- The affected version and the file, export, or CLI surface involved.
- Steps to reproduce, or a minimal script that demonstrates the issue.
- The impact (credential exposure, request forgery, denial of service, and so on).

## Response expectations

This is a solo-maintained open source project with no support contract and no SLA. Reports are
triaged as time allows; there is no guaranteed response window. A confirmed vulnerability is fixed
and released as a patch version, with credit to the reporter unless anonymity is requested.

## Supported versions

| Version            | Supported |
| ------------------ | --------- |
| Latest `0.x` minor | yes       |
| Older `0.x` minors | no        |

The package is pre-1.0: only the latest published minor receives security fixes. A 1.0 release
will replace this table with the supported major line(s).
