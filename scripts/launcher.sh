#!/usr/bin/env bash
# The launcher is the one file in this repository the unit suite cannot reach:
# it is a payload copied into somebody else's project, where nothing resolves
# the way it does here. This covers what is left.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
launcher="$root/skills/package-mysql-ha-green/green"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
checks=0
fail(){ echo "launcher: FAIL — $*" >&2; exit 1; }
ok(){ checks=$((checks+1)); echo "  ok — $*"; }

grep -q 'io.github.getcolors.mysql-ha.workflow/workflow' "$launcher" || fail 'no workflow dispatch'
ok 'dispatches to library workflow'

for bad in 'defn.*-step' 'tofu/' 'ansible/'; do
  ! grep -qE "$bad" "$launcher" || fail "launcher contains $bad logic"
done
ok 'contains no tool logic'

grep -qE '\(def \^:private mysql-ha-sha (nil|"[0-9a-f]{40}")\)' "$launcher" || fail 'invalid pin site'
[ "$(grep -cE '\(def \^:private mysql-ha-sha ' "$launcher")" = 1 ] || fail 'more than one pin site'
ok 'has one managed pin site'

[[ -L "$root/green/green" && $(readlink "$root/green/green") == ../skills/package-mysql-ha-green/green ]] \
  || fail 'green/green is not the payload symlink'
[[ -L "$root/red/red" && $(readlink "$root/red/red") == ../skills/package-mysql-ha-red/red ]] \
  || fail 'red/red is not the payload symlink'
[[ -L "$root/blue/blue" && $(readlink "$root/blue/blue") == ../skills/package-mysql-ha-blue/blue ]] \
  || fail 'blue/blue is not the payload symlink'
ok 'each colour dir symlinks its skill payload'

mkdir "$tmp/project"; cp "$launcher" "$tmp/project/green"; chmod +x "$tmp/project/green"
cp "$root/test/fixtures/colors.yml" "$tmp/project/colors.yml"
(cd "$tmp/project" && MYSQL_HA_LIB_ROOT="$root" ./green build >/dev/null) || fail 'working-tree override failed'
[ -f "$tmp/project/.colors/mysql-ha-fixture/mysql-ha-infrastructure/main.tf" ] || fail 'render missing'
ok 'working-tree override renders from a copied payload'

mkdir -p "$tmp/project/deep/path"
(cd "$tmp/project/deep/path" && MYSQL_HA_LIB_ROOT="$root" ../../green build >/dev/null) \
  || fail 'upward colors.yml search failed'
ok 'finds desired state by walking upward'

out=$(cd "$tmp/project" && MYSQL_HA_LIB_ROOT="$root" ./green nonsense 2>&1 || true)
grep -q Usage <<<"$out" || fail 'unknown verb has no usage'
ok 'unknown verb prints usage'

out=$(cd "$tmp/project" && MYSQL_HA_LIB_ROOT="$root" COLORS_PAR_PROFILE=elsewhere ./green build 2>&1 || true)
grep -q 'COLORS_PAR_PROFILE' <<<"$out" || fail 'COLORS_PAR_PROFILE was not refused'
ok 'refuses COLORS_PAR_PROFILE'

for verb in build create delete health; do
  grep -q "\"$verb\"" "$launcher" || fail "missing verb $verb"
done
ok 'all lifecycle verbs are dispatchable'

# A launcher with no pin and no override has to say so rather than resolve
# whatever happens to be on the classpath.
if grep -q '(def ^:private mysql-ha-sha nil)' "$launcher"; then
  out=$(cd "$tmp/project" && ./green build 2>&1 || true)
  grep -q 'carries no mysql-ha pin' <<<"$out" || fail 'unpinned launcher did not explain itself'
  ok 'unpinned launcher explains itself'
fi

echo "launcher: $checks checks passed"
