#!/usr/bin/env bash
# Render the fixture and diff it against what is recorded, then assert the
# handful of properties a byte diff cannot express on its own — that no
# credential-shaped value was written, that the private service ports are not
# publicly reachable, and that the endpoint really is the reserved IP.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
state="$root/test/fixtures/colors.yml"
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1

build() {
  local variant=$1; shift
  (cd "$root" && env MYSQL_HA_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$variant" \
     "$@" ./green build -f "$state" >/dev/null)
  if [ "$accept" = 1 ]; then
    rm -rf "${goldens:?}/$variant"; mkdir -p "$goldens/$variant"
    cp -r "$tmp/$variant/." "$goldens/$variant/"
  else
    diff -qr "$goldens/$variant" "$tmp/$variant"
  fi
  echo "  ok — $variant"
}

build local
build r2 COLORS_PAR_PROVIDER_BACKEND=r2

profile=mysql-ha-fixture
base="$tmp/local/$profile"

for tool in mysql-ha-infrastructure mysql-ha-dns mysql-ha-ansible; do
  [ -d "$base/$tool" ] || { echo "missing stage $tool" >&2; exit 1; }
done

for playbook in base.yml cluster.yml backup.yml health.yml cleanup.yml; do
  [ -f "$base/mysql-ha-ansible/$playbook" ] || {
    echo "missing playbook $playbook" >&2; exit 1; }
done

infra="$base/mysql-ha-infrastructure/main.tf"
# The VPC is discovered, never owned.
grep -q 'data "digitalocean_vpc" "cluster"' "$infra"
if grep -q 'resource "digitalocean_vpc"' "$infra"; then
  echo 'the package must not own a VPC' >&2; exit 1
fi
# Three members and no more.
grep -qE 'count *= *3' "$infra"
# The reserved IP must never carry an assignment in desired state.
grep -q 'resource "digitalocean_reserved_ip" "endpoint"' "$infra"
if grep -qE '^\s*droplet_id\s*=' "$infra"; then
  echo 'the reserved IP assignment must not be desired state' >&2; exit 1
fi
# Every destroyable resource is guarded.
[ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 3 ] || {
  echo 'a destroyable resource is unguarded' >&2; exit 1; }
# The group port is never open to the world.
if grep -qE 'port_range *= *"33061"' "$infra"; then
  echo 'the group replication port is in a public firewall rule' >&2; exit 1
fi

dns="$base/mysql-ha-dns/main.tf"
grep -q 'proxied = false' "$dns"
grep -q 'name    = "my-ha.fixture.example"' "$dns"
# The client record points at the reserved IP, not at a member.
grep -q 'content = "192.0.2.10"' "$dns"

cnf="$base/mysql-ha-ansible/files/mysqld.cnf"
for setting in 'gtid_mode                = ON' \
               'enforce_gtid_consistency = ON' \
               'log_replica_updates      = ON' \
               'group_replication_start_on_boot = OFF' \
               'group_replication_bootstrap_group = OFF' \
               'group_replication_single_primary_mode              = ON'; do
  grep -qF "$setting" "$cnf" || { echo "missing setting: $setting" >&2; exit 1; }
done

# Secrets reach the play at run time and never through a rendered file.
for secret in COLORS_PAR_MYSQL_ADMIN_PASSWORD COLORS_PAR_MYSQL_REPLICATION_PASSWORD \
              COLORS_PAR_DO_TOKEN COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID \
              COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY; do
  grep -Rq "lookup('env', '$secret')" "$base/mysql-ha-ansible" || {
    echo "missing runtime lookup for $secret" >&2; exit 1; }
done

if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$tmp"; then
  echo 'credential-shaped value rendered' >&2; exit 1
fi

echo 'all mysql-ha goldens and safety assertions pass'
