# Security policy

hevy2garmin here is a **public fork** of [drkostas/hevy2garmin](https://github.com/drkostas/hevy2garmin) held by `xantic21`. The application code, its releases and its security fixes come from the upstream project.

## Reporting a vulnerability

- **In the upstream application** (anything that also exists in [drkostas/hevy2garmin](https://github.com/drkostas/hevy2garmin)): report it to the upstream maintainer through the upstream repository's private channel (a GitHub security advisory there, if enabled), not through a public issue.
- **Specific to this fork**: report it privately to the fork owner through a draft GitHub security advisory in this repository (*Security → Advisories*). Fork-specific are the strict in-place merge (`typescript/src/strict/`, the strict parts of `web/`, `src/hevy2garmin/strict_mode.py`), the credential vault, the deployment quarantine, gate F, the synthetic staging, the presentation files and the fork-only maintenance workflows.
- Never paste Hevy or Garmin credentials, API keys, session tokens or personal workout data into issues, pull requests or chats.

## Supported versions

For deployment, only the current upstream release. This fork's code is a quarantined migration candidate (strict in-place merge on upstream `b44bdc7`): it is not approved for deployment until the owner's gates F and G ([docs/STRICT_OPERATIONS.md](../docs/STRICT_OPERATIONS.md) §3), and security reports about it are welcome and handled on its development branch. The fork does not publish packages; the inherited PyPI workflow runs only in the upstream repository. Design and threat model of the fork's safeguards: [docs/STRICT_OPERATIONS.md](../docs/STRICT_OPERATIONS.md) §1, §9, §13.
