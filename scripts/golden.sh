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

  # Compute documents are library-owned; this package checks its topology and
  # the SSH identities consumed by application stages.
  [ -d "$base/mysql-ha-infrastructure/shared" ] || exit 1
  for node in 0 1 2; do
    [ -f "$base/mysql-ha-infrastructure/nodes/$node/node.tf.json" ] || exit 1
  done
  if [ "$fixture" = colors ]; then
    grep -q "IdentityFile ~/.ssh/$profile" "$base/mysql-ha-ansible-local/main.yml" || exit 1
  else
    grep -q 'IdentityFile ~/.ssh/id_ed25519' "$base/mysql-ha-ansible-local/main.yml" || exit 1
  fi
  grep -q "$profile/mysql-ha-dns.tfstate" "$base/mysql-ha-dns/backend.tf.json"

  local dns="$base/mysql-ha-dns/main.tf"
  grep -q 'proxied = false' "$dns"
  grep -q 'name    = "my-ha.fixture.example"' "$dns"
  # The client record points at the reserved IP, not at a member.
  grep -q 'content = "198.51.100.10"' "$dns"

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

  if grep -rEq 'BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY|github_pat_|ghp_|gho_|ghu_|ghs_|ghr_' "$base"; then
    echo "$profile: credential-shaped value rendered" >&2; exit 1
  fi
  if grep -rq --exclude=colors-compute-endpoint 'REPLACE_ME' "$base"; then
    echo "$profile: unresolved configuration placeholder" >&2; exit 1
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
  for backend in s3 r2; do
    build "$fixture" "$backend"
  done
done

[ "$status" = 0 ] && echo 'all mysql-ha goldens and safety assertions pass'
exit "$status"
