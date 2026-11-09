# Security

## Threat model

dsh-mesh can delegate tasks and (optionally) operate desktops across devices. It is designed for **your own devices** connected by a relay you control. Do not expose control tokens to untrusted parties.

## Defaults (v0.1.0)

- Remote desktop control (`pc_*` tools) is **disabled by default**; it must be enabled per node in config.
- Every node has its own token with an explicit allow-list. There is no shared admin key.
- Tokens are scoped per node; revoking one token does not affect others.
- All tool calls are recorded in an append-only audit log.
- Peers are pinned by TLS certificate fingerprint.
- Enrollment requires an invite code (one-time, expiring) in the planned control plane.

## Reporting a vulnerability

Please open a private security advisory on GitHub, or contact the maintainer via the GitHub profile. Do not create a public issue for unpatched vulnerabilities.