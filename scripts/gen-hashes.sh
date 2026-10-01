#!/usr/bin/env sh
#
# gen-hashes.sh <module-dir>
#
# Writes a <file>.sha256 sidecar next to every file under <module-dir>, so the
# on-device verify.sh can check integrity at install time (ReZygisk-style
# per-file hashing). Run at build time - see .github/workflows/build.yml.
# The sidecars are build artifacts and must NOT be committed (see .gitignore).
set -eu

DIR=${1:?usage: gen-hashes.sh <module-dir>}
[ -d "$DIR" ] || {
    echo "gen-hashes: '$DIR' not found" >&2
    exit 1
}

if command -v sha256sum > /dev/null 2>&1; then
    SHA='sha256sum'
elif command -v shasum > /dev/null 2>&1; then
    SHA='shasum -a 256'
else
    echo "gen-hashes: no sha256 tool found" >&2
    exit 1
fi

cd "$DIR"

# Drop any stale sidecars first so a since-removed file leaves no orphan hash.
find . -type f -name '*.sha256' -delete

# Hash every remaining file; store just the hex digest, matching verify.sh.
find . -type f ! -name '*.sha256' | while IFS= read -r f; do
    $SHA "$f" | awk '{print $1}' > "$f.sha256"
done

echo "gen-hashes: wrote $(find . -type f -name '*.sha256' | wc -l | tr -d ' ') sidecars under $DIR"
