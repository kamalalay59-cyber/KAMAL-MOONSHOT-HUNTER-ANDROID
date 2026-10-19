# Security notes

- This is a local-only PAPER simulator. It has no wallet connection, private-key handling, signing, or live order path.
- The HTTP server binds only to `127.0.0.1` and rejects untrusted Host and cross-site browser requests. Remote binding is intentionally unsupported.
- Do not expose it publicly or port-forward it. An `ADMIN_TOKEN` is not a substitute for HTTPS, a firewall, or a properly secured deployment.
- Keep `.env` and `data/state.json` private. Never commit bot tokens, chat IDs, admin tokens, or real wallet secrets.
- Report security issues privately to the repository maintainer rather than posting credentials or exploit details in public issues.
