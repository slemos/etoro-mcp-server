# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's private vulnerability reporting ("Security" tab → "Report a vulnerability") on this repository. Include the version, configuration (without keys), and steps to reproduce. We aim to acknowledge reports within a few days.

## Threat model

This server runs **locally with your privileges** and holds credentials for a brokerage account. The main risks, and what the project does about them:

| Risk | Mitigation | Residual risk |
|---|---|---|
| **Prompt injection** makes the model place or alter orders the user did not intend | Write tools are off by default; every order is preview → confirm; elicitation shows the exact action to the human; per-order and per-session caps; writes-per-minute brake; `destructiveHint` annotations so clients prompt | A client that auto-approves tool calls and cannot elicit defeats the human step. Do not auto-approve `etoro_confirm_action`; do not mix untrusted content with a session that can trade real money. |
| Model asks for an unintended API route | Fixed route allowlist; the client only talks to an `https://*.etoro.com` host; read/write kinds are enforced | A bug in the allowlist. Tests cover it; reports welcome. |
| Key leakage via logs, errors or tool results | Keys never appear in tool inputs; they are redacted from errors and audit lines and never echoed | Anything the host or OS logs about its own environment is outside this project. |
| Keys stored insecurely by the person configuring the server | Keys can be read from a keychain or password manager (`*_CMD`, run without a shell) or from a file the server refuses to use unless only the owner can read it (`*_FILE`); ambiguous setups are refused; `etoro_check_connection` warns when a read-only server holds a Write key | Plain environment variables and config files remain possible and are documented as the weakest option. Other programs running as the same user can read what that user can read. |
| Using a real-money key believing it is demo | Before every trading preview the server reads the key's scopes and compares the account that answers with `demoCid`/`realCid`; it refuses on mismatch or when it cannot verify | Relies on eToro's `/api/v1/me` and portfolio responses being accurate. |
| Key that can also trade real money while the server is set to demo | `etoro_check_connection` lists the scopes and warns; `ETORO_STRICT_KEY_SCOPE` (on by default for real, off for demo) refuses trading previews with such keys; environment-pinned routes and the account-owner check keep the server on the configured environment | Without strict mode the key itself can still trade the other environment outside this server. |
| Over-privileged key | Docs recommend Read keys, IP allowlists, expiry, separate Demo/Real keys | Entirely under the user's control on eToro's side. |
| Duplicate execution | Per-action idempotency key reused on retries; single-use confirmations | eToro's own idempotency semantics apply. |
| Malicious or vulnerable dependency | Small dependency set (`@modelcontextprotocol/sdk`, `zod`); lockfile committed; `npm audit` (high and above) and `npm audit signatures` run in CI and weekly; Dependabot proposes updates; GitHub Actions are pinned to commit SHAs | Supply-chain risk can never be zero. |
| Tampered release bundle | Releases are built by a workflow that first checks the tag, runs the tests and the security checks; the bundle carries a build-provenance attestation and `SHA256SUMS`, and an SBOM is attached | The bundle is not signed with a certificate, so an installer cannot see a publisher name; verify the attestation (see the README). |

## Automated checks

| Check | What it covers | When |
|---|---|---|
| CodeQL (`security-extended` queries) | Static analysis of the TypeScript source | Every push to `main`, every pull request, weekly |
| `npm audit`, `npm audit signatures` | Known advisories and registry signatures of production dependencies | Same |
| Gitleaks | Secrets in the repository and its history | Same |
| `npm run security:check` | Dynamic checks against the built server as a real process, with the network cut off and fake keys: which tools exist under each permission switch, that a non-eToro base URL is refused, that malformed or hostile arguments are rejected without any request, that identifiers cannot change the request path, that keys never appear in results, stderr or the audit log | Every CI run and every release |

There is no web interface or open port, so a conventional DAST scanner has nothing to attack; the dynamic checks above exercise the same ground (inputs and outputs) over stdio. The tests (`npm test`) cover the logic against a mocked eToro API.

## Operating recommendations

1. Start on **demo**. Use a **Read** key until you actually need to trade. Keep secrets in a keychain or password manager (see the README's "Securing your setup").
2. When enabling writes on **real**, keep the default caps low, restrict the key by IP, and set an expiry.
3. Keep `ETORO_REQUIRE_ELICITATION` on, and use a client that supports MCP elicitation.
4. Keep the audit log (`ETORO_AUDIT_LOG`) and review it.
5. Rotate or delete the key at eToro if you suspect exposure.

## Supported versions

Only the latest release receives security fixes.
