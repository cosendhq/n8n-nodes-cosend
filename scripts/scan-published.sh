#!/usr/bin/env bash
# Scan one published version of n8n-nodes-cosend with n8n's own scanner, the check n8n's
# verification review runs. Usage: scripts/scan-published.sh <version>
#
# The scanner exits 0 when the package FAILS its checks (@n8n/scan-community-package's cli.js
# prints "❌ Package <name>@<version> has failed security checks" and returns normally; only a
# thrown error exits 1). So this passes only on the scanner's exact success line, and anything
# else, including output in a shape it has never printed, fails.
set -euo pipefail

version="${1:?usage: scripts/scan-published.sh <version>}"
spec="n8n-nodes-cosend@$version"

# A version n8n-publish has just published can take a moment to show on the registry.
for attempt in $(seq 1 20); do
	if npm view "$spec" version >/dev/null 2>&1; then
		break
	fi
	if [ "$attempt" = 20 ]; then
		echo "::error::$spec is not on npm after 10 minutes."
		exit 1
	fi
	sleep 30
done

status=0
output="$(npx --yes @n8n/scan-community-package "$spec" 2>&1)" || status=$?
echo "$output"

if [ "$status" != 0 ]; then
	echo "::error::n8n's scanner could not scan $spec (exit $status)."
	exit 1
fi
if ! grep -qF "✅ Package $spec has passed all security checks" <<<"$output"; then
	echo "::error::n8n's scanner did not pass $spec. Its output above says why."
	exit 1
fi
echo "n8n's scanner passed $spec."
