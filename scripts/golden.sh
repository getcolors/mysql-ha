#!/usr/bin/env bash
# Render every fixture under both state backends and diff each against what
# is recorded, then assert the handful of properties a byte diff cannot express
# on its own — that no credential-shaped value was written, that the private
# service ports are not publicly reachable, that the endpoint really is the
# reserved IP, and that both keypair modes of the SSH Keypair Standard hold.
#
# Two fixtures: `colors.yml` is keygen mode (no digitalocean-ssh-keys) — the
# compute template must declare the profile-named digitalocean_ssh_key
# resource and reference it by attribute, and the local stage must name the
# generated key. `optout.yml` supplies an explicit key id and must create
# nothing — its rendering is byte-for-byte what the package rendered before
# the standard, under its own profile. Two backends: each fixture is rendered
# under local and again under r2 by overlaying COLORS_PAR_PROVIDER_BACKEND.
#
#   ./scripts/golden.sh            check
#   ./scripts/golden.sh --accept   regenerate after an intended change
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
goldens="$root/test/resources/golden"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
accept=0
[ "${1:-}" = --accept ] && accept=1
status=0

build() {
  local fixture=$1 backend=$2
  local state="$root/test/fixtures/$fixture.yml"
  local profile
  profile=$(sed -n 's/^profile: //p' "$state")
  (cd "$root/green" && env MYSQL_HA_LIB_ROOT="$root" COLORS_PAR_WORKDIR="$tmp/$backend-$fixture" \
     COLORS_PAR_PROVIDER_BACKEND="$backend" ./green build -f "$state" >/dev/null)
  local actual="$tmp/$backend-$fixture/$profile"
  local golden="$goldens/$backend/$profile"

  checks "$actual" "$profile" "$fixture" "$backend"

  if [ "$accept" = 1 ]; then
    rm -rf "${golden:?}"; mkdir -p "$golden"
    cp -r "$actual/." "$golden/"
    echo "  accepted — $backend/$profile"
  else
    [ -d "$golden" ] || { echo "golden missing for $backend/$profile; inspect build then run bb golden:accept" >&2; exit 1; }
    if diff -qr "$golden" "$actual"; then
      echo "  ok — $backend/$profile"
    else
      status=1
    fi
  fi
}

checks() {
  local base=$1 profile=$2 fixture=$3 backend=$4

  for tool in mysql-ha-infrastructure mysql-ha-ansible-local mysql-ha-dns mysql-ha-ansible; do
    [ -d "$base/$tool" ] || { echo "$profile: missing stage $tool" >&2; exit 1; }
  done

  for playbook in base.yml cluster.yml backup.yml health.yml cleanup.yml; do
    [ -f "$base/mysql-ha-ansible/$playbook" ] || {
      echo "$profile: missing playbook $playbook" >&2; exit 1; }
  done

  local infra="$base/mysql-ha-infrastructure/main.tf"
  # The VPC is discovered, never owned.
  grep -q 'data "digitalocean_vpc" "cluster"' "$infra"
  if grep -q 'resource "digitalocean_vpc"' "$infra"; then
    echo "$profile: the package must not own a VPC" >&2; exit 1
  fi
  # Three members and no more.
  grep -qE 'count *= *3' "$infra"
  # The reserved IP must never carry an assignment in desired state. The check
  # is scoped to the resource block: the `params` output reports each droplet's
  # id, which is a fact about the members, not an assignment of the endpoint.
  grep -q 'resource "digitalocean_reserved_ip" "endpoint"' "$infra"
  if sed -n '/^resource "digitalocean_reserved_ip" "endpoint" {/,/^}/p' "$infra" \
       | grep -qE '^\s*droplet_id\s*='; then
    echo "$profile: the reserved IP assignment must not be desired state" >&2; exit 1
  fi
  # Every destroyable resource is guarded.
  [ "$(grep -c 'prevent_destroy = true' "$infra")" -ge 3 ] || {
    echo "$profile: a destroyable resource is unguarded" >&2; exit 1; }
  # The group port is never open to the world.
  if grep -qE 'port_range *= *"33061"' "$infra"; then
    echo "$profile: the group replication port is in a public firewall rule" >&2; exit 1
  fi
  # The SSH Keypair Standard, both modes: keygen declares the profile-named key
  # resource and references it by attribute; opt-out keeps the literal id and
  # creates nothing.
  if [ "$fixture" = colors ]; then
    grep -q 'resource "digitalocean_ssh_key" "machine"' "$infra" || { echo "$profile: keygen mode declares no key resource" >&2; exit 1; }
    grep -q 'ssh_keys = \[digitalocean_ssh_key.machine.id\]' "$infra" || { echo "$profile: keygen mode does not reference the key by attribute" >&2; exit 1; }
    grep -q 'ssh_key_id   = digitalocean_ssh_key.machine.id' "$infra" || { echo "$profile: params carries no ssh_key_id" >&2; exit 1; }
    grep -q 'IdentityFile ~/.ssh/mysql-ha-fixture' "$base/mysql-ha-ansible-local/main.yml" || { echo "$profile: the local stage names no identity file" >&2; exit 1; }
    grep -q '"ansible_ssh_private_key_file" : "/home/build-placeholder/.ssh/mysql-ha-fixture"' "$base/mysql-ha-ansible/inventory.json" || { echo "$profile: the inventory does not name the generated key" >&2; exit 1; }
  else
    ! grep -q 'digitalocean_ssh_key' "$infra" || { echo "$profile: opt-out mode must create no key" >&2; exit 1; }
    grep -q 'ssh_keys = \["12345678"\]' "$infra" || { echo "$profile: opt-out mode lost the literal key id" >&2; exit 1; }
    ! grep -qE '^\s+IdentityFile ' "$base/mysql-ha-ansible-local/main.yml" || { echo "$profile: opt-out mode must not guess an identity file" >&2; exit 1; }
  fi

  if [ "$backend" = r2 ]; then
    grep -q "$profile/mysql-ha-infrastructure.tfstate" "$base/mysql-ha-infrastructure/backend.tf.json"
  fi

  local dns="$base/mysql-ha-dns/main.tf"
  grep -q 'proxied = false' "$dns"
  grep -q 'name    = "my-ha.fixture.example"' "$dns"
  # The client record points at the reserved IP, not at a member.
  grep -q 'content = "192.0.2.10"' "$dns"

  local cnf="$base/mysql-ha-ansible/files/mysqld.cnf"
  for setting in 'gtid_mode                = ON' \
                 'enforce_gtid_consistency = ON' \
                 'log_replica_updates      = ON' \
                 'group_replication_start_on_boot = OFF' \
                 'group_replication_bootstrap_group = OFF' \
                 'group_replication_single_primary_mode              = ON'; do
    grep -qF "$setting" "$cnf" || { echo "$profile: missing setting: $setting" >&2; exit 1; }
  done

  # Secrets reach the play at run time and never through a rendered file.
  for secret in COLORS_PAR_MYSQL_ADMIN_PASSWORD COLORS_PAR_MYSQL_REPLICATION_PASSWORD \
                COLORS_PAR_DO_TOKEN COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID \
                COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY; do
    grep -Rq "lookup('env', '$secret')" "$base/mysql-ha-ansible" || {
      echo "$profile: missing runtime lookup for $secret" >&2; exit 1; }
  done

  if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|REPLACE_ME|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$base"; then
    echo "$profile: credential-shaped value rendered" >&2; exit 1
  fi
  # A Selmer tag that survived rendering is a typo or an unsupplied key.
  if grep -rn '<{' "$base"; then
    echo "$profile: left an unrendered Selmer tag" >&2; exit 1
  fi
  # A build that reached the real ~/.ssh would leak the operator's home into
  # committed bytes and make the goldens workstation-specific.
  if grep -rq "$HOME/.ssh" "$base"; then
    echo "$profile: rendered a real home directory; build must use the placeholder" >&2; exit 1
  fi
  # SSH Config Standard §6: the local stage takes addresses and the aliases as
  # Ansible extra-vars, never through Selmer, so its rendered playbook carries
  # no address at all.
  if grep -rEq '([0-9]{1,3}\.){3}[0-9]{1,3}' "$base/mysql-ha-ansible-local"; then
    echo "$profile: rendered an address into the local ssh_config stage" >&2; exit 1
  fi
}

for fixture in colors optout; do
  for backend in local r2; do
    build "$fixture" "$backend"
  done
done

[ "$status" = 0 ] && echo 'all mysql-ha goldens and safety assertions pass'
exit "$status"
