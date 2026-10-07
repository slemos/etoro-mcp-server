#!/usr/bin/env bash
# Writes the body of a GitHub release to stdout: what changed (the CHANGELOG section for the version),
# how to install, and how to verify the files. Usage: scripts/release-notes.sh <version> <owner/repo>
# <version> may carry a pre-release suffix (0.2.0-rc.1); the CHANGELOG section of 0.2.0 is used.
set -euo pipefail
version="${1:?version}"
repo="${2:?owner/repo}"
base="${version%%-*}"
changelog="$(dirname "$0")/../CHANGELOG.md"

section="$(awk -v h="## $base " 'index($0, h) == 1 { found = 1; next } found && /^## / { exit } found' "$changelog")"
[ -n "$section" ] || { echo "No CHANGELOG section for $base" >&2; exit 1; }

if [ "$version" != "$base" ]; then
  echo "> **Pre-release $version** of $base, published to check the release pipeline and to try the bundle. Use the final $base when it is out."
  echo
fi
cat <<TEXT
Unofficial [MCP](https://modelcontextprotocol.io) server for the eToro Public API: ask Claude about your portfolio and, if you opt in, have orders prepared that you review and execute yourself on a local page. Read-only and demo by default. Not affiliated with eToro; not financial advice.

## What changed in $base

$section

## Install (Claude Desktop)

1. Download \`etoro-mcp-server-$version.mcpb\` below.
2. Double-click it, or drag it into **Settings → Extensions**. Claude Desktop shows a red warning that Anthropic has not verified the developer (see below).
3. Paste your eToro API key and user key (a **Read** key on **Demo** is enough to start) and leave *Use the REAL environment* and *Enable write tools* off.
4. Ask Claude: *"Check my eToro connection."*
5. To try a write (only after turning on *Enable write tools*): ask Claude to prepare an order on demo. Your browser opens an approval page; you press Execute there, Claude cannot.

Claude Code, other clients and key handling: see the [README](https://github.com/$repo#readme).

## Verify before installing

Claude Desktop warns about any extension whose developer Anthropic has not verified, and this bundle is not code-signed with a certificate either. Its origin is attested instead:

\`\`\`bash
shasum -a 256 -c SHA256SUMS --ignore-missing
gh attestation verify etoro-mcp-server-$version.mcpb --repo $repo
\`\`\`

The second command proves the file was built from this repository by its release workflow. \`etoro-mcp-server-$version.sbom.cdx.json\` lists the bundled dependencies (CycloneDX).
TEXT
