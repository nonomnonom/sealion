# Security Policy

## Supported versions

Only the latest minor release line on npm receives security fixes. Pre-1.0 versions are best-effort — pin a specific version in production until 1.0.

| Version | Status         |
| ------- | -------------- |
| 0.x     | ✅ active      |
| < 0.1   | ❌ unsupported |

## Reporting a vulnerability

**Please don't open a public GitHub issue for security bugs.**

Instead, use **[GitHub's private security advisory flow](https://github.com/nonomnonom/sealion/security/advisories/new)**. The maintainer is notified, and we coordinate a fix and disclosure timeline privately.

If you can't use the advisory form, email `hi@nonom.xyz` with:

- A description of the issue and its impact.
- Reproduction steps or a minimal proof-of-concept.
- Suggested mitigation, if you have one.

We aim to acknowledge new reports within **3 business days** and ship a patch within **14 days** for critical issues.

## Scope

In scope:

- Bugs in the Sealion source (`src/`) that allow data corruption, denial of service, or unintended access.
- Dependency vulnerabilities surfaced through Sealion's API.
- Flaws in `MatchingEngine`, `Channel`, `Exchange`, or risk gates that enable unsafe trading state in a sim.

Out of scope:

- Vulnerabilities in user-supplied LLM models or external APIs (Mastra/AI SDK providers).
- Issues that require physical access to the host or compromised dependencies installed outside Sealion's `package.json`.
- Sealion is a **simulator**, not a live-trading framework — issues that depend on connecting Sealion to a real broker are out of scope.

## Disclosure

Once a fix lands and a patched release is published, we credit reporters (with permission) in the corresponding CHANGELOG entry and GitHub Security Advisory.
