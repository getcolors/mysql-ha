# CLAUDE.md

## What this is

`mysql-ha` is a tri-colour Package Skill (green, red, blue) for a three-member
MySQL **Group Replication** cluster on DigitalOcean, with daily snapshots and
continuous binary-log archiving to Cloudflare R2 and a scheduled verified
restore. The consumer is `../mysql-ha-digitalocean`.

Read `plans/0001-mysql-ha-v1.md` for why each component was chosen; the code
and the tests are authoritative for what it does. `BENCHMARK.md` is the log of
the run that built it and is not maintained afterwards.

## Layout and commands

The three implementations live in the tri-colour layout, matching `netbird`
and `clickhouse`: canonical Clojure in `green/` (`green/bb.edn`,
`green/deps.edn`, `green/src/`, `green/tasks/`, tests under `green/test/clj`),
TypeScript/Bun in `red/`, and Python/uv in `blue/`. Green is canonical: a
behavioural change lands in all three colours in the same commit and passes
`scripts/parity.sh`. The fixture and the goldens are shared across colours at
the repository root — `test/fixtures/` and `test/resources/golden/` — with
`green/test/fixtures` and `green/test/resources` symlinks pointing at them.
Each colour dir holds a launcher symlink to its skill payload (`green/green`,
`red/red`, `blue/blue`).

```sh
cd green && bb test
cd green && bb golden
cd green && bb golden:accept   # only after reading the diff
cd red && bun test && bun run typecheck
cd blue && uv run pytest
./scripts/parity.sh            # three colours, two state backends, byte for byte
./scripts/launcher.sh          # from the repository root
cd green && ./green build
cd green && ./green create --dry-run
cd green && ./green health     # read-only assertions against the live cluster
```

The goldens have a second axis beside the fixture: the one
`test/fixtures/colors.yml` is rendered under the **local** state backend and
again under **r2** (`COLORS_PAR_PROVIDER_BACKEND=r2` overlaid on the same
file). The committed trees live at
`test/resources/golden/{local,r2}/mysql-ha-fixture/` and differ only in each
OpenTofu stage's `backend.tf.json`. `scripts/golden.sh` checks green against
both; `scripts/parity.sh` renders both variants through every colour and
diffs the trees — and the colour template trees (`red/resources`, blue's
embedded `resources/`) — byte for byte.

Never run a real `create`/`delete` without explicit authorization. Never edit or
read `.colors/`, and never read `.envrc.private`. Real deletion requires
`COLORS_PAR_COMPUTE_PREVENT_DESTROY=false` for one run; never edit the
committed flag.

## Coupling

The package pins the SDK — Green in `green/deps.edn`, the Red SDK in
`red/package.json`, the Blue SDK in `blue/pyproject.toml` — and ONCE, in the
same three manifests, for one namespace: `compute-cluster`
(`io.github.getcolors.once.compute-cluster`, `package-once-red`'s
`computeCluster`, `package_once_blue.compute_cluster`), the one implementation
of the Compute Cluster Standard (`workspace/standards/compute-cluster.md`).
The package owns its `compute-providers` registry, its `spec` (one
homogeneous role of `cluster-nodes` members, fallback offset 11, the
`10.110.0.0/20` fallback subnet, a discovered network), its own validators
and its `params-errors`; ONCE owns selection, the source lists, the network
and topology checks, the fallback nodes, `read-state`, `adopt-state`,
`resolved-cluster` and the provider-switch guard. The compute state is the
template's `params` output — `provider`, `reserved_ip`, `vpc_id`,
`vpc_ip_range`, and one node per member with its `droplet_id` — adopted
under `:once/cluster`; a pre-adoption state, which recorded only the parallel
`node_public_ips`/`node_private_ips`/`node_droplet_ids` lists, is translated
into the same shape by the reader in `tools`, and refused when the lists
disagree. Use `MYSQL_HA_LIB_ROOT` (the repository root, for every colour; red
also accepts the `red/` dir directly), `GREEN_LIB_ROOT` and `ONCE_LIB_ROOT`
for working-tree development. Final launchers use a pushed SHA managed by
`bb pin` (run in `green/`), which stamps all three payloads from their
unpinned birth forms; deployment launchers are copies, not symlinks.

## Architecture

```text
create  start ─ infrastructure ─┬─ dns ──┐
                                └─ base ─┴─ cluster ─ backup ─ health
delete  start ─ load-infrastructure ─ cleanup ─ dns ─ infrastructure
health  start ─ load-infrastructure ─ health
```

`dns` and `base` fork and join at `cluster`. Stage names are remote-state keys
(`<profile>/mysql-ha-infrastructure.tfstate`) and must not move.

The package keeps its own multi-node DigitalOcean template rather than
ONCE's single-server one, the way `k8s` decided; what it takes from ONCE is
the cluster contract over that template, never the template itself. Every
machine in the account's regional default VPC is inside the cluster's
east-west trust boundary — the group port and the all-ports VPC rules take
`data.digitalocean_vpc.cluster.ip_range` as their source — which the standard
names as a security exception of a discovered network.

Four things are load-bearing and easy to break:

1. **Bootstrapping is guarded.** `cluster.yml` bootstraps only after *every*
   member has reported it can see no ONLINE member anywhere. A member that
   bootstraps beside a live group forms a second group of one and the two
   diverge silently. Do not relax that condition to "this member sees no
   group".
2. **The reserved IP carries no `droplet_id` in OpenTofu.** Assignment belongs
   to the primary, not to desired state. Adding `droplet_id` to the resource
   makes every `create` after a failover move the endpoint back.
3. **`RESET MASTER` in `cluster.yml` is guarded by data, not by a marker
   file.** It runs only for a member whose `gtid_executed` does not contain
   `<group>:1`. Weakening that guard destroys GTID history on a live member.
4. **`group_replication_start_on_boot`** is `OFF` in `z-colors-ha.cnf` and `ON`
   in `zz-colors-ha-boot.cnf`, which deliberately notifies no handler.

## Safety

Credentials are `COLORS_PAR_*` only and never render: the three files on a
member that hold one (`/etc/mysql-ha/secrets.env`, `rclone.conf`,
`binlog-client.cnf`) are built by Ansible from `lookup('env', ...)` under
`no_log`. `COLORS_PAR_PROFILE` is refused.

The design needs exactly two database credentials —
`COLORS_PAR_MYSQL_ADMIN_PASSWORD` and `COLORS_PAR_MYSQL_REPLICATION_PASSWORD`.
Local agents authenticate as `root@localhost` over the unix socket with
`auth_socket`, so the admin password is never written to a member. Do not add
a third credential; solve it another way or report it.

**The `repl` account's password is derived, not verbatim.** MySQL rejects a
replication-channel password over 32 characters (`ERROR 3056`/`ERROR 3972`), so
the account carries `SHA-256(COLORS_PAR_MYSQL_REPLICATION_PASSWORD)[:32]` in
hex. The derivation is one Ansible expression, read by both the `ALTER USER`
statements in `cluster.yml` and `binlog-client.cnf` in `backup.yml`. Change it
in one place or not at all, and never truncate the operator's secret instead —
that would put a prefix of it on every member. `admin` is unaffected.

Public ingress is SSH from `digitalocean-ssh-sources` and the MySQL port from
`digitalocean-client-sources`. The group port (33061) is VPC-only in both the
firewall and `group_replication_ip_allowlist`.

## Documentation

`index.html` is this repository's landing page and carries two analytics tags:
GA4 measurement ID `G-4VKP1WY4QJ`, whose explicit `page_title` must exactly
equal the decoded HTML `<title>` and stay distinct and stable so one Analytics
property can separate repositories, and the self-hosted Rybbit snippet
`<script src="https://rybbit.getcolors.ai/api/script.js" data-site-id="9fb9c41a6d49" defer></script>`,
which shares one site ID across every page because `getcolors.github.io/<repo>/`
paths already encode the repository. Never add one tag without the other.

## Git

Work on the current branch. The launcher pins are managed only by `bb pin` (in
`green/`) after a clean pushed commit; never invent or hand-edit `mysql-ha-sha`
or its red/blue counterparts. Do not commit or push unless explicitly asked.
