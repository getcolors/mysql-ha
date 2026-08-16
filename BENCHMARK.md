# BENCHMARK.md

Running log for the `mysql-ha` benchmark run. Written as the work happened, not
retrospectively. Timestamps are ISO-8601 local (Europe/Rome, UTC+02:00).

## Phase log

### 2026-08-16T09:30:04+02:00 — design

Read `~/code/getcolors/CLAUDE.md`, then `clickhouse/` (the only multi-node
package), `k8s/` (the only multi-node **DigitalOcean** package),
`vaultwarden/` (backup-to-R2 with Litestream), `once/green` (the provider
registry and the DigitalOcean droplet template) and the `green` SDK itself
(`workflow`, `tofu`, `ansible`, `scaffold`, `lifecycle`, `providers`, `cli`).

`postgres-ha/` and `postgres-ha-digitalocean/` were not read, referenced, or
touched at any point in this run.

### 2026-08-16T09:36:26+02:00 — package scaffold

Repository skeleton, `deps.edn` (Green only, pinned at the SHA every other
package in the workspace currently pins), `bb.edn`, `.gitignore`, and
`plans/0001-mysql-ha-v1.md`.

### 2026-08-16T09:40:00+02:00 — compute stage

`src/clj/.../{utils,validate,tools,workflow}.clj`, the DigitalOcean
infrastructure template and the Cloudflare DNS template. First `./green build`
of the fixture succeeded on the first attempt.

### 2026-08-16T09:44:00+02:00 — replication

`files/mysqld.cnf` (the Group Replication configuration) and `cluster.yml` (the
guarded bootstrap, the two accounts, the recovery channel, the join, the
schema, and the start-on-boot drop-in).

### 2026-08-16T09:47:00+02:00 — failover

`files/mysql-ha-endpoint` and its 10-second timer: the reserved-IP claim.

### 2026-08-16T09:48:00+02:00 — backup

`files/mysql-ha-snapshot` and the R2 layout.

### 2026-08-16T09:49:00+02:00 — PITR

`files/mysql-ha-binlog-archive` and `files/mysql-ha-binlog-upload`.

### 2026-08-16T09:50:00+02:00 — restore verification

`files/mysql-ha-restore-check`, `files/verify.cnf`, and the AppArmor override.

### 2026-08-16T10:02:00+02:00 — real deploy

`./green create` against DigitalOcean for the first time. Everything from here
down is the live cluster; the failed checks below are all from this phase.

### 2026-08-16T09:55:37+02:00 — package checks green

`bb test` (38 tests, 139 assertions), `./scripts/golden.sh`, and
`./scripts/launcher.sh` (9 checks) all pass. The goldens were recorded for the
first time in this run — there was nothing to diff against, and the recorded
tree was read before being committed.

No failures in any of the three. That is the whole first-attempt record for the
offline half of the work.

## Design decisions

Each of these had to be made for this package. Where the workspace already had
a precedent it is named; where it did not, that is called out. The full
argument is in `plans/0001-mysql-ha-v1.md`.

| Decision | Choice | Precedent in workspace |
|---|---|---|
| Replication topology | MySQL Group Replication, single-primary | **none** |
| Failover orchestrator | Group Replication's own Paxos group — no external orchestrator, no fourth tier | **none** |
| Quorum store | The group itself (colocated, 3 members) | **none** |
| Client endpoint | DigitalOcean Reserved IP claimed by whichever member is PRIMARY; DNS is a static A record to it | **none** |
| Backup tool | `mysqldump` logical snapshot, zstd-compressed, GTID-stamped | vaultwarden streams SQLite with Litestream — not transferable |
| PITR mechanism | `mysqlbinlog --read-from-remote-server --stop-never --raw` on every member, uploaded to R2 each minute | **none** |
| Verified restore | Second `mysqld` on the elected member, restored from snapshot + binlog replay, asserted against the heartbeat table | vaultwarden has a weekly `restore-check`; the mechanism is entirely different |
| Package dependencies | Green only, own DigitalOcean template | `k8s/` |
| Stage layout | one `*-infrastructure` tofu stage with `count`, one `*-dns` stage, one Ansible directory with several playbooks | `k8s/` + `clickhouse/` |

## Decisions with no precedent in this workspace

1. **Group Replication rather than async replication plus an external
   orchestrator.** The node budget is three droplets and a quorum store may
   only be colocated. Orchestrator/Patroni-style designs want an odd-sized
   consensus store that is not the database; Group Replication *is* a Paxos
   group, so the quorum store is the three mysqld processes themselves. This is
   the only topology that fits the budget without colocating a second consensus
   system.
2. **A DigitalOcean Reserved IP as the client endpoint, not a DNS swing.** The
   workspace has no floating-IP precedent — every existing package points DNS
   straight at a droplet. A DNS swing would need the Cloudflare record's content
   to be mutable outside OpenTofu, which puts desired state permanently in
   drift. A Reserved IP keeps the A record constant (it is the reserved
   address, forever) and moves the L3 endpoint instead. `digitalocean_reserved_ip`
   is therefore created **without** `droplet_id`, so the assignment is not
   desired state and the agent and OpenTofu never fight.
3. **Archiving binlogs from every member rather than from the primary.** In
   Group Replication every ONLINE member writes every transaction to its own
   binary log under the same GTID. Archiving all three to separate R2 prefixes
   means PITR material survives the loss of any node and needs no leader
   election in the archiver at all.
4. **A self-electing backup role with no external state.** The snapshot and the
   restore check run on the ONLINE SECONDARY with the lowest `MEMBER_ID`,
   falling back to the PRIMARY when the group has no secondary. Every node runs
   the same timer and all but one exit immediately. No lease, no lock, no
   fourth machine.
5. **Deriving the replication account's password from the supplied one.**
   Forced by a hard MySQL limit discovered during the real deploy — see failed
   check 5. No workspace package had ever hit a credential that the target
   system refuses to accept at full length.
6. **An AppArmor local override for the verification instance.** Ubuntu confines
   `mysqld` to `/var/lib/mysql`. The verified restore starts a second `mysqld` on
   a scratch datadir, which the shipped profile denies. `/etc/apparmor.d/local/usr.sbin.mysqld`
   is extended rather than the profile being disabled.

## External components provisioned or installed

Versions read off the live cluster on 2026-08-16, not from documentation.

| Component | Version | Where it came from | What it does here |
|---|---|---|---|
| Ubuntu | 24.04.4 LTS (`ubuntu-24-04-x64`) | DigitalOcean image | the members |
| MySQL Server | 8.0.46-0ubuntu0.24.04.3 | Ubuntu `noble-updates` | the database |
| MySQL `group_replication` plugin | ships with the above, `ACTIVE` | same package | replication, quorum, election |
| `mysqlbinlog` | 8.0.46-0ubuntu0.24.04.3 | `mysql-client` | continuous binary-log archiving, and replay during recovery |
| `mysqldump` | 8.0.46-0ubuntu0.24.04.3 | `mysql-client` | the daily snapshot |
| rclone | v1.60.1-DEV | Ubuntu `noble-updates` | all R2 traffic, `provider = Cloudflare` |
| zstd | Ubuntu `noble` | | snapshot compression |
| jq, curl | Ubuntu `noble` | | the DigitalOcean API calls in the endpoint agent |
| apparmor-utils | Ubuntu `noble` | | reloading the extended `mysqld` profile |
| OpenTofu | 1.12.4 | devenv | both infrastructure stages |
| ansible-core | 2.21.1 | devenv | every playbook |
| DigitalOcean OpenTofu provider | 2.51.0 (pinned) | registry | droplets, reserved IP, firewall, VPC lookup |
| Cloudflare OpenTofu provider | ~> 5.0 | registry | the DNS records |
| MySQL client (operator side) | `mysql84` from nixpkgs | devenv | connecting through the endpoint |

Nothing was installed from a third-party apt repository. Everything on a member
comes from Ubuntu's own archive, which is the whole reason `mysqldump` was
chosen over Percona XtraBackup.

Six systemd units are installed per member: `mysql-ha-endpoint.timer`,
`mysql-ha-heartbeat.timer`, `mysql-ha-binlog-archive.service`,
`mysql-ha-binlog-upload.timer`, `mysql-ha-snapshot.timer`,
`mysql-ha-restore-check.timer`. All six were `active` after convergence.

## Anything needed and not obtainable

Nothing. The design was built for the two database credentials it was given and
finished needing exactly those two. The one place reality did not fit — MySQL's
32-character replication-channel limit — was solved by deriving inside the
existing credential rather than by asking for another; see failed check 5.

## Failed checks

Every failing command, its error, and what it took to fix, in the order they
happened.

### 1 — `devenv shell` would not evaluate (1 attempt to fix)

```
$ devenv shell -- bash -c 'which tofu ansible-playbook mysql rclone'
error: mysql-client has been replaced by mariadb.client
```

`devenv.nix` listed `mysql-client`, copied from the habit of wanting a client
where you are running commands from. This nixpkgs has removed it.

Not fixed by substituting `mariadb.client`: MariaDB's client cannot speak
`caching_sha2_password`, which is MySQL 8's default authentication plugin, so it
could not have connected to this cluster anyway. Removed instead — the package
runs every query on a member against that member's own unix socket, over SSH,
so there was never anything for a local client to do. Fixed in one attempt, in
both repositories' `devenv.nix`.

### 2 — first real `create`: `base.yml` could not reach two of three droplets (1 attempt to fix)

```
$ ./green create
<<< :mysql-ha/infrastructure (48904ms)
<<< :mysql-ha/base (6979ms)
ansible-playbook base.yml failed:
fatal: [mysql-ha-node-1]: UNREACHABLE! => ssh: connect to host 134.209.203.49 port 22: Connection refused
fatal: [mysql-ha-node-3]: UNREACHABLE! => ssh: connect to host 159.223.208.209 port 22: Connection refused
mysql-ha-node-2            : ok=1   unreachable=0
```

The play had `gather_facts: true` and a `wait_for_connection` in `pre_tasks`.
**Fact gathering runs before `pre_tasks`**, so the wait never executed: the play
failed in seven seconds against droplets that were forty seconds old and still
booting sshd. Node two happened to be up, which is why exactly one host
succeeded and made the cause obvious.

Fixed by setting `gather_facts: false` — nothing in the play reads a fact — so
`wait_for_connection` is genuinely the first thing that runs. Took the
opportunity to add two related robustness fixes for problems that had not
happened yet but would have: `cloud-init status --wait` before the first `apt`
(the apt module does not retry on a dpkg lock, and unattended-upgrades holds
one on a fresh droplet), and `until: … is success` retries on the install
itself.

A red herring in the same output, recorded because it cost a minute of reading:
every SSH invocation prints `/etc/ssh/ssh_config line 53: Unsupported option
"gssapiauthentication"`, because the Nix `openssh` reads the host's system
config. It is a warning, not the failure — node two connected through the same
warning.

Golden diff after the fix was inspected line by line before `bb golden:accept`;
it contained exactly the four intended edits and nothing else.

### 3 — `apt` could not fetch `rclone` (1 attempt to fix, 5 wasted retries)

```
$ ./green create
<<< :mysql-ha/base (146394ms)
FAILED - RETRYING: Install the server and everything the agents shell out to (4 retries left).
… ×5, all three members …
E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/universe/r/rclone/
   rclone_1.60.1+dfsg-3ubuntu0.24.04.5_amd64.deb  404  Not Found
```

`update_cache: true` with `cache_valid_time: 3600` — the reflex pairing — does
nothing on a DigitalOcean Ubuntu image, because the image ships an apt index
young enough to look fresh and old enough to name package versions that have
already been superseded in the pool. The failure is a 404 on the `.deb`, not a
resolution error, so it looks transient and survives every retry identically.

Fixed by dropping `cache_valid_time` so the index is always refreshed. The
retries I had added in the previous fix turned a 30-second failure into a
150-second one and taught nothing — recorded here because it is the honest
cost.

Also visible in this output and worth noting for the record: the droplets are
`amd64` while the machine driving the deployment is `arm64`. Nothing in the
package assumes otherwise, and nothing had to change.

### 4 — `cluster.yml`: the recovery channel rejected `GET_SOURCE_PUBLIC_KEY` (1 attempt to fix, plus one to fix the fix)

`base.yml` now passed on all three members. `cluster.yml` reached the group
setup and failed on every member:

```
TASK [Point the distributed-recovery channel at the replication account]
fatal: [mysql-ha-node-1]: FAILED! => {"censored": "the output has been hidden
  due to the fact that 'no_log: true' was specified for this result"}
```

The task carries a password in its environment, so it is `no_log: true` — which
hid the reason. Reproduced by hand over SSH with a throwaway password:

```
ERROR 3139 (HY000): CHANGE REPLICATION SOURCE with the given parameters cannot
be performed on channel 'group_replication_recovery'.
```

`group_replication_recovery` accepts only a restricted subset of `CHANGE
REPLICATION SOURCE TO` parameters, and `GET_SOURCE_PUBLIC_KEY` is not one of
them. It is genuinely needed: the replication account uses
`caching_sha2_password`, MySQL 8's default, and distributed recovery has to
fetch the donor's RSA public key over a connection with no pre-shared
certificate. The equivalent for this channel is the *server variable*
`group_replication_recovery_get_public_key`.

Fixed in two places: dropped the parameter from the statement, and added
`group_replication_recovery_get_public_key = ON` to `z-colors-ha.cnf`. Verified
the corrected statement by hand before re-running.

Took the opportunity to fix the thing that made this cost a manual
reproduction: all three password-bearing SQL tasks now `register` their result
with `failed_when: false`, and a following task fails with the server's own
`stderr`. MySQL error text never echoes the password back, so the diagnosis is
visible without weakening `no_log`.

That fix needed a fix of its own: the reporter task's condition
`(var.rc | default(1)) != 0` fires on a *skipped* task, because a skipped task
registers a result with no `rc`. Corrected to
`var is not skipped and (var.rc | default(1)) != 0`. Caught by reading it, not
by running it.

And a self-inflicted one worth recording: my first attempt at that edit used
`sed` with `|` as the delimiter on a line containing a Jinja `|` filter, which
silently produced `default(1)) != 0| default(1)) != 0` in three places. Repaired
with a Python pass and caught by parsing every rendered playbook with PyYAML —
a check I then kept running after every playbook edit.

### 5 — MySQL will not accept a replication password longer than 32 characters (1 attempt to fix)

The error reporting added in the previous fix paid for itself immediately. The
next run printed the real reason instead of `censored`:

```
TASK [Report why it failed]
fatal: [mysql-ha-node-1]: FAILED! => {"msg": "ERROR 3056 (HY000) at line 1: The
  password provided for the replication user exceeds the maximum length of 32
  characters"}
```

`COLORS_PAR_MYSQL_REPLICATION_PASSWORD` is longer than 32 characters. Probed
both statements by hand on a live member with a 40-character throwaway value to
find out whether anything avoids the limit:

```
CHANGE REPLICATION SOURCE … SOURCE_PASSWORD='<40 chars>'
  ERROR 3056: … exceeds the maximum length of 32 characters
START GROUP_REPLICATION USER='repl', PASSWORD='<40 chars>'
  ERROR 3972: … the password provided for the recovery channel exceeds the
              maximum length of 32 characters
CHANGE REPLICATION SOURCE … SOURCE_PASSWORD='<32 chars>'
  (accepted)
```

Nothing avoids it. It is a hard MySQL limit on any replication channel, and
distributed recovery is a replication channel — every MySQL HA design that uses
Group Replication, async replication or semi-sync hits it.

**This is the one place the design had to make a judgement call, so it is worth
being explicit about what was and was not done.**

- Not asked for a second credential. The brief allows exactly two and the
  design still uses exactly two.
- Not truncated the operator's password to 32 characters. That would put a
  prefix of the operator's secret into `mysql.user` and into an option file on
  every member.
- Not weakened authentication (no `mysql_native_password`, no
  passwordless recovery, no SSL-less shortcut).

Instead the replication **account** carries the first 128 bits of the SHA-256 of
the supplied credential, as 32 hex characters. The operator supplies one
replication secret, as specified; the package adapts it to a protocol field
whose width it does not control. It reveals nothing about the input, it is 128
bits of entropy on an account only reachable inside the VPC, and being hex it is
immune to every quoting hazard in the surrounding SQL and option files.

The derivation lives in exactly one place — an Ansible expression — and both
users of it (the `CREATE`/`ALTER USER` statements and the archiver's
`binlog-client.cnf`) read that one expression, so the two cannot drift.

This is recorded again under "design decisions with no precedent" because it is
one, and because a reader of `colors.yml` would otherwise not know that the
`repl` account's password is not the string they exported.

### 2026-08-16T14:12:00+02:00 — first fully converged run (written at 14:12, describing the 10:17 run)

`./green create` completed end to end. Verified against the live cluster rather
than against the log:

```
MEMBER_HOST   MEMBER_STATE  MEMBER_ROLE
10.133.0.2    ONLINE        SECONDARY
10.133.0.3    ONLINE        PRIMARY
10.133.0.4    ONLINE        SECONDARY

snapshot/20260816T082002Z/dump.sql.zst
snapshot/20260816T082002Z/meta.json
snapshot/latest.json
binlog/mysql-ha-node-1/binlog.000001
binlog/mysql-ha-node-2/binlog.000001
binlog/mysql-ha-node-3/binlog.000001
restore-check/20260816T082149Z.json
restore-check/latest.json

{"status":"ok","node":"mysql-ha-node-3","snapshot":"20260816T082002Z",
 "heartbeat_lag_seconds":37,"replayed_beats":7,
 "detail":"restored 20260816T082002Z and replayed 1 archived logs"}
```

`replayed_beats: 7` is the number that matters: seven heartbeat rows existed in
the archived binary log that were *not* in the snapshot, so the restore check
proved point-in-time material and not merely a dump.

Stage timings for the successful run: infrastructure 3.9s, dns 3.9s, base 32s,
cluster 26s, backup 199s (of which ~135s is the deliberate wait for the
heartbeat and one upload cycle, so the proof has something to prove), health 7s.

The session was interrupted by an API limit between this run and the next
phase. On resuming, the cluster was still healthy and the heartbeat had been
advancing unattended for about two hours (1273 beats, newest 12:08:51 UTC),
which is its own small piece of evidence that nothing here needs babysitting.
