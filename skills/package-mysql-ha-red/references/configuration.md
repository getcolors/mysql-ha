# Configuration reference

`colors.yml` is the only file you edit. It is a flat YAML map read under the
YAML 1.2 core schema, found by walking up from the working directory, and it
holds **non-secret values only**. Validation reports every problem at once and
exits 2.

## Providers

| Key | Values | Notes |
|---|---|---|
| `provider-compute` | Library-supported provider | Must support application-assigned reserved IPs |
| `provider-dns` | `cloudflare` | the only implementation |
| `provider-backend` | `s3`, `r2` | where OpenTofu state lives |

## Identity

| Key | Meaning |
|---|---|
| `profile` | names the work directory and every remote-state key |
| `workdir` | usually `.colors`, resolved next to `colors.yml` |
| `compute-prevent-destroy` | keep `true` in committed desired state |

## Cluster

| Key | Meaning |
|---|---|
| `cluster-host` | the client endpoint, e.g. `my-ha.example.com`. Must sit inside `cloudflare-zone`. |
| `cluster-nodes` | must be `3`. A Group Replication majority needs an odd group, and the node budget is three. |

## Compute

Provider options and credentials follow the revision of
[colors-compute](https://github.com/getcolors/colors-compute) pinned by the
skill. Machines default to `<profile>-<node-id>`; the provider name option
overrides the prefix. A compatible provider addition requires a dependency bump.

`mysql-ssh-sources` and `mysql-client-sources` restrict administrative and client
access separately. The corresponding provider-prefixed keys remain accepted by
the library. Cluster traffic uses the observed private network range. The
library rejects unsupported private filtering and endpoint capabilities.

## DNS

| Key | Meaning |
|---|---|
| `cloudflare-zone` | the zone holding `cluster-host` |
| `cloudflare-proxied` | must be `false`. Cloudflare's proxy does not carry the MySQL protocol. |

The record for `cluster-host` has a 60-second TTL and its content is the
reserved IP, which never changes. Per-member administrative records
`node-N.<cluster-host>` point at the members' public addresses.

## MySQL

| Key | Meaning |
|---|---|
| `mysql-port` | client port, normally `3306` |
| `mysql-group-port` | Group Replication port, normally `33061`. VPC-only. Must differ from `mysql-port`. |
| `mysql-group-name` | a **UUID**. MySQL rejects anything else as a group name. Generate one per deployment and never change it on a live cluster. |
| `mysql-admin-user` | the account clients use; its password is `COLORS_PAR_MYSQL_ADMIN_PASSWORD` |
| `mysql-replication-user` | used by distributed recovery and by the binary-log archiver; see the note below |
| `mysql-innodb-buffer-pool-size` | e.g. `1G`. Leave room for the verification instance's 128 MB. |

### The replication account's password is derived, not verbatim

MySQL refuses a replication-channel password longer than 32 characters
(`ERROR 3056` from `CHANGE REPLICATION SOURCE TO`, `ERROR 3972` from
`START GROUP_REPLICATION`), and distributed recovery is a replication channel.

So the `repl` account does **not** carry
`COLORS_PAR_MYSQL_REPLICATION_PASSWORD` verbatim. It carries the first 128 bits
of that value's SHA-256, as 32 hex characters:

```
password = SHA256(COLORS_PAR_MYSQL_REPLICATION_PASSWORD)[:32]   # hex
```

You still supply one replication secret and only one. But if you ever connect
as `repl` by hand, that is the string to use, and you can reproduce it with:

```sh
printf '%s' "$COLORS_PAR_MYSQL_REPLICATION_PASSWORD" | sha256sum | cut -c1-32
```

The `admin` account is unaffected — a normal MySQL account has no such limit and
carries `COLORS_PAR_MYSQL_ADMIN_PASSWORD` exactly as you set it.

## Backups

| Key | Meaning |
|---|---|
| `backup-r2-bucket` | the backup bucket. Must not be the state bucket. |
| `backup-r2-endpoint` | the R2 S3 endpoint |
| `backup-r2-region` | `auto` |
| `backup-r2-prefix` | key prefix inside the bucket |
| `backup-snapshot-oncalendar` | systemd `OnCalendar`, e.g. `*-*-* 01:00:00` |
| `backup-restore-check-oncalendar` | systemd `OnCalendar`, offset after the snapshot |
| `backup-binlog-upload-interval` | how often the binary-log spool is pushed, e.g. `1min`. **This is the recovery-point objective**: it bounds how much can be lost if a member is destroyed. |
| `backup-retention-days` | how long snapshots, archived logs and verdicts are kept |
| `backup-restore-max-lag-seconds` | how far behind the restored copy may be before the verified restore fails |

## Cadence

| Key | Meaning |
|---|---|
| `heartbeat-interval` | how often the primary writes `mysql_ha.heartbeat`, e.g. `10s` |
| `endpoint-poll-interval` | how often each member checks whether it should hold the reserved IP, e.g. `10s`. **This bounds failover time** for the client endpoint. |

## State backend

`local` needs nothing. `s3` needs `s3-bucket` and `s3-region`. `r2` needs
`r2-bucket` and `r2-endpoint`, plus `COLORS_PAR_R2_ACCESS_KEY_ID` and
`COLORS_PAR_R2_SECRET_ACCESS_KEY`. Remote state keys are
`<profile>/mysql-ha-infrastructure.tfstate` and
`<profile>/mysql-ha-dns.tfstate`.

## Credentials

Never in `colors.yml`. Six `COLORS_PAR_*` variables, in a gitignored
`.envrc.private`:

```sh
export COLORS_PAR_DO_TOKEN=…
export COLORS_PAR_CLOUDFLARE_API_TOKEN=…
export COLORS_PAR_R2_ACCESS_KEY_ID=…
export COLORS_PAR_R2_SECRET_ACCESS_KEY=…
export COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID=…
export COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY=…
export COLORS_PAR_MYSQL_ADMIN_PASSWORD=…
export COLORS_PAR_MYSQL_REPLICATION_PASSWORD=…
```

`build` and `create --dry-run` need none of them. `health` needs the provider
credentials but no database credential — every query it makes runs on a member
against that member's local socket.

Never export `COLORS_PAR_PROFILE`; the package refuses to run when it is set.

## What is generated

```text
.colors/<profile>/
├── mysql-ha-infrastructure/  backend.tf.json  main.tf
├── mysql-ha-dns/             backend.tf.json  main.tf
└── mysql-ha-ansible/         ansible.cfg  inventory.json
                              base.yml  cluster.yml  backup.yml
                              health.yml  cleanup.yml
                              files/…  (agents, mysqld.cnf, verify.cnf)
```

Never edit it, never read it as source, never commit it. No file under it ever
holds a credential: the three that do on a member are written directly by
Ansible from the process environment under `no_log`.
