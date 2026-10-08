# Security Policy

Tent writes inside a project's `.tent/`, reads the files its Nodes point to, serves a local web page, and ships Hooks that a host runs. A bug that lets any of these reach further than the command asked for is a security issue. Examples: a `/` path that escapes `.tent/`, a web request that gets past the launch token or the Host and Origin checks, or a Hook that does more than report.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |

## Reporting a Vulnerability

Please use GitHub private vulnerability reporting: open the repository's Security Advisories page and choose "Report a vulnerability." Do not open a public issue for security reports.

Include a minimal reproduction, the affected version or commit, and the expected and actual behavior. Do not include real `.tent/` contents, credentials or private workspace paths in a report.
