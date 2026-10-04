# Security Policy

## Supported versions

Only the latest release of Orbit AI receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub's "Report a vulnerability" option (Security tab → Advisories),
or by contacting the maintainer through the repository profile. Include:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- The Orbit AI version and Windows version

You can expect an acknowledgement within 7 days. Once a fix is ready, the issue will be disclosed
together with a release that contains the fix.

## Scope notes

- API keys are encrypted at rest with Windows `safeStorage`. Keys are sent only to the provider you configure.
- PC control and the PowerShell tool can change your system. They run in *confirm* mode by default, which requires approval for each action. Full-auto mode removes that check and is the user's own choice.
- Tool output, web pages and files are treated as untrusted data. Prompt-level defenses reduce prompt-injection risk but cannot guarantee it is prevented.
