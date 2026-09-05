import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepError, type Opts } from "red/workflow";
import { computeCluster } from "package-once-red";
import * as ssh from "../src/ssh.ts";
import * as sshConfig from "../src/ssh-config.ts";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";
import { run } from "../src/cli.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");
const optoutFile = join(import.meta.dir, "../../test/fixtures/optout.yml");

function readFixture(path: string, overrides: Opts): Opts {
  const text = readFileSync(path, "utf8");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

const fixture = (overrides: Opts = {}) => readFixture(fixtureFile, overrides);
const optout = (overrides: Opts = {}) => readFixture(optoutFile, overrides);

// A pre-adoption state exactly as `tofu output -json` parsed it: the six
// outputs, three parallel lists among them, and no `params`.
const legacyOutputs: Record<string, unknown> = {
  node_public_ips: ["203.0.113.11", "203.0.113.12", "203.0.113.13"],
  node_private_ips: ["10.110.0.5", "10.110.0.6", "10.110.0.7"],
  node_droplet_ids: [512000001, 512000002, 512000003],
  reserved_ip: "203.0.113.10",
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.110.0.0/20",
};

// `params` as the adopted template records it, here through the legacy
// translation so the two shapes are provably one.
const recorded = (): computeCluster.ClusterParams => tools.legacyParams(fixture(), legacyOutputs);

const without = (o: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

// --- tools -------------------------------------------------------------------

describe("tools", () => {
  test("the topology is a pure function of desired state", () => {
    expect(tools.nodes(fixture())).toEqual(tools.nodes(fixture()));
    expect(tools.nodes(fixture()).map((n) => n.name))
      .toEqual(["fixture-node-1", "fixture-node-2", "fixture-node-3"]);
    expect(tools.nodes(fixture()).map((n) => n["server-id"])).toEqual([101, 102, 103]);
    // The archiver's pseudo-replica ids cannot collide with a member's.
    const serverIds = new Set(tools.nodes(fixture()).map((n) => n["server-id"]));
    const connectionIds = new Set(tools.nodes(fixture()).map((n) => n["connection-server-id"]));
    expect([...serverIds].filter((id) => connectionIds.has(id))).toEqual([]);
  });

  test("build never reads state", () => {
    // ONCE's fallbacks at offset 11 are the addresses this package always
    // rendered; documentation range, so a leak fails loudly.
    expect(tools.nodes(fixture()).map((n) => n["public-ip"]))
      .toEqual(["192.0.2.11", "192.0.2.12", "192.0.2.13"]);
    expect(tools.nodes(fixture()).map((n) => n["private-ip"]))
      .toEqual(["10.110.0.11", "10.110.0.12", "10.110.0.13"]);
    expect(tools.nodes(fixture()).map((n) => n["droplet-id"]))
      .toEqual([100000001, 100000002, 100000003]);
    expect(String(tools.fallbackOutputs.reserved_ip).startsWith("192.0.2.")).toBe(true);
    expect(tools.dataFn(fixture()).reserved_ip).toBe(tools.fallbackOutputs.reserved_ip);
  });

  test("a real run reads every node from the adopted cluster", () => {
    const opts = fixture({ "once/cluster": recorded() });
    const members = tools.nodes(opts);
    expect(members.map((n) => n["public-ip"])).toEqual(["203.0.113.11", "203.0.113.12", "203.0.113.13"]);
    expect(members.map((n) => n["private-ip"])).toEqual(["10.110.0.5", "10.110.0.6", "10.110.0.7"]);
    expect(members.map((n) => n["droplet-id"])).toEqual([512000001, 512000002, 512000003]);
    expect(members.map((n) => n.name)).toEqual(["fixture-node-1", "fixture-node-2", "fixture-node-3"]);
    // The cluster facts beside the nodes come from state too.
    expect(tools.dataFn(opts).reserved_ip).toBe("203.0.113.10");
    expect(tools.dataFn(opts).vpc_id).toBe("5a6b7c8d-0000-4000-8000-000000000001");
    expect(tools.groupSeeds(opts)).toBe("10.110.0.5:33061,10.110.0.6:33061,10.110.0.7:33061");
    // And reach the inventory and the DNS records.
    const inv = JSON.parse(tools.inventory(opts));
    expect(inv.all.children.mysql.hosts["fixture-node-2"].ansible_host).toBe("203.0.113.12");
    const records = JSON.parse(String((tools.dnsSpecs(opts)[0]!.data as Opts)["node-records-json"]));
    expect(records["node-3.my-ha.fixture.example"]).toBe("203.0.113.13");
  });

  test("the legacy state is translated into params", () => {
    const params = recorded();
    expect(params.provider).toBe("digitalocean");
    expect(params.nodes!.map((n) => n.index)).toEqual([0, 1, 2]);
    expect(params.nodes!.every((n) => n.role === null)).toBe(true);
    expect(params.nodes!.map((n) => n.name)).toEqual(["fixture-node-1", "fixture-node-2", "fixture-node-3"]);
    const second = params.nodes![1]!;
    expect([second.ip, second.vpc_ip, second.droplet_id, second.user, second.sudoer])
      .toEqual(["203.0.113.12", "10.110.0.6", 512000002, "root", "root"]);
    expect([params.reserved_ip, params.vpc_id, params.vpc_ip_range])
      .toEqual(["203.0.113.10", "5a6b7c8d-0000-4000-8000-000000000001", "10.110.0.0/20"]);
    // ONCE accepts the translation as a whole cluster.
    expect(computeCluster.nodeErrors(validate.spec, fixture(), params)).toEqual([]);
    expect(tools.paramsErrors(params)).toEqual([]);
  });

  test("the legacy translation refuses to guess", () => {
    const refusal = (outputs: Record<string, unknown>): Error => {
      try {
        tools.legacyParams(fixture(), outputs);
      } catch (e) {
        return e as Error;
      }
      throw new Error("not refused");
    };
    // Lists that disagree with each other; the SDK's StepError, so readState
    // reports it.
    const e = refusal({ ...legacyOutputs, node_public_ips: ["203.0.113.11", "203.0.113.12"] });
    expect(e).toBeInstanceOf(StepError);
    expect(e.message).toBe("legacy state lists 2 public addresses, 3 private addresses and 3 droplet ids; refusing to guess the cluster");
    // Lists that disagree with cluster-nodes.
    const four = (v: unknown) => [...(v as unknown[]), (v as unknown[]).at(-1)];
    expect(refusal({
      ...legacyOutputs,
      node_public_ips: four(legacyOutputs.node_public_ips),
      node_private_ips: four(legacyOutputs.node_private_ips),
      node_droplet_ids: four(legacyOutputs.node_droplet_ids),
    }).message).toBe("legacy state lists 4 public addresses, 4 private addresses and 4 droplet ids; refusing to guess the cluster");
    // No reserved ip.
    expect(refusal(without(legacyOutputs, "reserved_ip")).message).toBe("legacy state carries no reserved_ip");
    expect(refusal({ ...legacyOutputs, reserved_ip: "" }).message).toBe("legacy state carries no reserved_ip");
    // The other extension keys are paramsErrors' to refuse, the same as a
    // recorded state.
    expect(tools.paramsErrors(tools.legacyParams(fixture(), without(legacyOutputs, "vpc_id"))))
      .toEqual(["compute state carries no vpc_id"]);
  });

  test("params errors hold the extension keys", () => {
    const params = recorded();
    expect(tools.paramsErrors(params)).toEqual([]);
    expect(tools.paramsErrors({ ...params, reserved_ip: " " })).toEqual(["compute state carries no reserved_ip"]);
    expect(tools.paramsErrors(without(params, "vpc_id"))).toEqual(["compute state carries no vpc_id"]);
    expect(tools.paramsErrors({ ...params, vpc_ip_range: null })).toEqual(["compute state carries no vpc_ip_range"]);
    expect(tools.paramsErrors({ ...params, vpc_ip_range: "10.110.0.1/20" }))
      .toEqual(['compute state vpc_ip_range "10.110.0.1/20" is not a canonical IPv4 network such as 10.40.0.0/24']);
    const nodes = params.nodes!;
    const damaged = [nodes[0]!, without(nodes[1]!, "droplet_id") as computeCluster.Node,
                     { ...nodes[2]!, droplet_id: "" }];
    expect(tools.paramsErrors({ ...params, nodes: damaged }))
      .toEqual(["compute state carries no droplet_id for 1, 2"]);
  });

  test("load-infrastructure adopts the state preflight handed on", async () => {
    const params = recorded();
    const load = (event: string, state: unknown) =>
      tools.loadInfrastructureStep(fixture({ "red/event": event, "mysql-ha/state": state }));
    // A recorded cluster.
    let r = await load("delete", { params });
    expect(r["red/exit"]).toBe(0);
    expect(r["once/cluster"]).toEqual(params);
    expect(r["mysql-ha/infrastructure-present?"]).toBe(true);
    expect("mysql-ha/state" in r).toBe(false);
    expect(tools.nodes(r).map((n) => n["public-ip"])).toEqual(["203.0.113.11", "203.0.113.12", "203.0.113.13"]);
    // A readable state that records no cluster.
    r = await load("delete", { params: undefined });
    expect(r["red/exit"]).toBe(0);
    expect(r["mysql-ha/infrastructure-present?"]).toBe(false);
    expect("once/cluster" in r).toBe(false);
    // The cleanup has nothing to reach and skips itself.
    expect((await tools.cleanupStep(r))["red/exit"]).toBe(0);
    r = await load("health", { params: undefined });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe(tools.noClusterMessage);
    // An unreadable backend fails closed.
    r = await load("delete", { error: "tofu output failed: no backend" });
    expect(r["red/exit"]).toBe(1);
    expect(String(r["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(r["red/err"])).toContain("no backend");
    expect(String((await load("health", { error: "x" }))["red/err"]))
      .toContain("could not read the infrastructure state for health");
    // A partial cluster is refused with ONCE's message.
    r = await load("delete", { params: { ...params, nodes: params.nodes!.slice(0, 2) } });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
    // An adopted cluster without its extension keys is refused.
    r = await load("delete", { params: without(params, "vpc_id") });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("compute state carries no vpc_id");
  });

  test("a real create resolves the cluster from the apply", () => {
    // The apply's `params` output is what every later stage reads; never the
    // fallbacks.
    const params = recorded();
    const opts = fixture({ "red/event": "create" });
    const apply = (p: unknown) => tools.resolveInfrastructure(opts, {
      ...opts, "red/exit": 0, ...(p === undefined ? {} : { "mysql-ha/outputs": { params: p } }),
    });
    let r = apply(params);
    expect(r["red/exit"]).toBe(0);
    expect(r["once/cluster"]).toEqual(params);
    expect(tools.nodes(r).map((n) => n["public-ip"])).toEqual(["203.0.113.11", "203.0.113.12", "203.0.113.13"]);
    r = apply(undefined);
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe(computeCluster.noParamsMessage);
    r = apply({ ...params, nodes: params.nodes!.slice(0, 2) });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
    r = apply({ ...params, nodes: params.nodes!.map((n) => without(n, "droplet_id")) });
    expect(r["red/exit"]).toBe(1);
    expect(r["red/err"]).toBe("compute state carries no droplet_id for 0, 1, 2");
    // A failed apply, a delete and a build hand the result on untouched.
    expect(tools.resolveInfrastructure(opts, { ...opts, "red/exit": 1, "red/err": "apply failed" })["red/exit"]).toBe(1);
    expect("once/cluster" in tools.resolveInfrastructure({ ...opts, "red/event": "build" }, { ...opts, "red/exit": 0 })).toBe(false);
    expect(tools.resolveInfrastructure({ ...opts, "red/event": "delete" }, { ...opts, "red/exit": 0 })["red/exit"]).toBe(0);
  });

  test("the inventory names both groups", () => {
    const inv = JSON.parse(tools.inventory(fixture()));
    const children = inv.all.children;
    expect(Object.keys(children.mysql.hosts).length).toBe(3);
    expect(Object.keys(children.bootstrap.hosts)).toEqual(["fixture-node-1"]);
    // Bootstrap is only ever member one, and only for an empty group.
    expect(children.bootstrap.hosts["fixture-node-1"])
      .toEqual(children.mysql.hosts["fixture-node-1"]);
    // The members are reached with the generated key in keygen mode, on a
    // build through the placeholder, and with the operator's own key in
    // opt-out mode.
    const built = JSON.parse(tools.inventory(fixture({ "red/event": "build" })));
    expect(built.all.children.mysql.hosts["fixture-node-2"].ansible_ssh_private_key_file)
      .toBe("/home/build-placeholder/.ssh/mysql-ha-fixture");
    const optedOut = JSON.parse(tools.inventory(optout()));
    expect(optedOut.all.children.mysql.hosts["fixture-node-2"].ansible_ssh_private_key_file)
      .toBe("~/.ssh/id_ed25519");
  });

  test("the local stage writes one block per alias and carries no address", () => {
    const data = tools.ansibleLocalSpecs(fixture())[0]!.data as Opts;
    expect(data["ssh-keygen"]).toBe(true);
    expect(data["ssh-config-identity-file"]).toBe("~/.ssh/mysql-ha-fixture");
    expect(data["host-alias"]).toBe("mysql-ha-fixture");
    // Addresses travel as extra-vars, never through Selmer.
    expect("ssh_hosts" in data).toBe(false);
    expect((tools.ansibleLocalSpecs(optout())[0]!.data as Opts)["ssh-keygen"]).toBe(false);
    // The bare alias points at member one, then one alias per member.
    expect(tools.sshConfigHosts(fixture())).toEqual([
      { name: "mysql-ha-fixture", ip: "192.0.2.11" },
      { name: "mysql-ha-fixture-0", ip: "192.0.2.11" },
      { name: "mysql-ha-fixture-1", ip: "192.0.2.12" },
      { name: "mysql-ha-fixture-2", ip: "192.0.2.13" },
    ]);
  });

  test("a delete whose state records no cluster has no block to withdraw", async () => {
    const r = await tools.ansibleLocalStep(
      fixture({ "red/event": "delete", "mysql-ha/infrastructure-present?": false }));
    expect(r["red/exit"]).toBe(0);
  });

  test("the inventory is byte-stable", () => {
    expect(tools.inventory(fixture())).toBe(tools.inventory(fixture()));
  });

  test("stage directories are remote-state keys", () => {
    for (const tool of tools.tofuTools) {
      expect(tools.toolDir(fixture(), tool).endsWith(`/${tool}`)).toBe(true);
    }
    expect(tools.tofuTools).toEqual(["mysql-ha-infrastructure", "mysql-ha-dns"]);
  });

  test("the rendered tree is exactly what a member needs", () => {
    const targets = tools.ansibleSpecs(fixture()).map((s) => s.target);
    const names = targets.map((target) => target.split("/").at(-1));
    for (const expected of [
      "ansible.cfg", "base.yml", "cluster.yml", "backup.yml",
      "health.yml", "cleanup.yml", "inventory.json",
      "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
      "mysql-ha-lib", "mysql-ha-endpoint", "mysql-ha-heartbeat",
      "mysql-ha-snapshot", "mysql-ha-binlog-archive",
      "mysql-ha-binlog-upload", "mysql-ha-restore-check", "mysql-ha-health",
    ]) {
      expect(names).toContain(expected);
    }
    // No file holding a credential is ever rendered.
    for (const absent of ["rclone.conf", "secrets.env", "binlog-client.cnf"]) {
      expect(names).not.toContain(absent);
    }
  });

  test("the dns stage points at the reserved IP and the members", () => {
    const data = tools.dnsSpecs(fixture())[0]!.data as Opts;
    const records = JSON.parse(String(data["node-records-json"]));
    expect(data.reserved_ip).toBe(tools.fallbackOutputs.reserved_ip);
    expect(Object.keys(records)).toEqual([
      "node-1.my-ha.fixture.example",
      "node-2.my-ha.fixture.example",
      "node-3.my-ha.fixture.example",
    ]);
  });

  test("the source lists reach the template as JSON lists", () => {
    const data = tools.infrastructureSpecs(fixture())[0]!.data as Opts;
    expect(data["digitalocean-ssh-sources-json"]).toBe('["203.0.113.7/32"]');
    // An overlay string renders the same list.
    const overlaid = tools.infrastructureSpecs(
      fixture({ "digitalocean-client-sources": "203.0.113.7/32, 198.51.100.0/24" }))[0]!.data as Opts;
    expect(overlaid["digitalocean-client-sources-json"]).toBe('["203.0.113.7/32","198.51.100.0/24"]');
  });

  test("the backup prefix never carries a trailing slash", () => {
    expect(utils.backupPrefix(fixture())).toBe("mysql-ha-fixture");
    expect(utils.backupPrefix({ "backup-r2-prefix": "a/b//" })).toBe("a/b");
  });
});

// --- validate ----------------------------------------------------------------

describe("validate", () => {
  test("the fixture is renderable", () => {
    expect(validate.stateErrors(fixture())).toEqual([]);
  });

  test("both keypair modes are renderable", () => {
    // The SSH Keypair Standard has two modes and conformance means both hold.
    expect(validate.stateErrors(optout())).toEqual([]);
    expect(validate.keygen(fixture())).toBe(true);
    expect(validate.keygen(optout())).toBe(false);
  });

  test("the machine key is never required", () => {
    // Its absence is keygen mode, not a missing key.
    expect(validate.stateErrors(fixture()).some((e) => e.includes("digitalocean-ssh-keys"))).toBe(false);
  });

  test("the private key path is desired state in opt-out mode only", () => {
    expect(validate.stateErrors(without(optout(), "digitalocean-ssh-private-key") as Opts))
      .toContain(":digitalocean-ssh-private-key is required when digitalocean-ssh-keys is supplied");
    // Keygen mode names the generated key itself and asks for no path.
    expect(validate.stateErrors(without(fixture(), "digitalocean-ssh-private-key") as Opts)).toEqual([]);
  });

  test("every required key is required", () => {
    for (const key of [...validate.ownRequired, ...validate.computeProviders.digitalocean!.required]) {
      const opts = fixture();
      delete opts[key];
      expect(validate.stateErrors(opts).some((e) => e.includes(`${key} is required`)))
        .toBe(true);
    }
  });

  test("the profile parameter is refused", () => {
    expect(validate.envErrors({})).toEqual([]);
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "" })).toEqual([]);
    expect(validate.envErrors({ COLORS_PAR_PROFILE: "somewhere-else" }).length)
      .toBeGreaterThan(0);
  });

  test("the spec describes one homogeneous role on a discovered network", () => {
    // The Compute Cluster Standard's spec is data ONCE reads; this is the one
    // place its content is asserted, so a drift in any colour is a test
    // failure and not a rendered surprise.
    expect(computeCluster.specErrors(validate.spec)).toEqual([]);
    expect(Object.keys(validate.spec.registry)).toEqual(["digitalocean"]);
    expect(validate.spec.default).toBe("digitalocean");
    expect(validate.spec.registry.digitalocean!.network).toEqual({ mode: "discovered" });
    expect(validate.spec.sources.nonEmpty).toEqual(["ssh-sources", "client-sources"]);
    expect(validate.spec.roles).toEqual([{ role: null, countKey: "cluster-nodes", count: 3, fallbackOffset: 11 }]);
    expect(validate.spec.fallbackSubnet).toBe("10.110.0.0/20");
    expect(computeCluster.topologyErrors(validate.spec, fixture())).toEqual([]);
  });

  test("the node budget is three", () => {
    expect(validate.stateErrors(fixture({ "cluster-nodes": 2 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-nodes": 5 })).length).toBeGreaterThan(0);
    // A count that is not a positive integer is ONCE's to refuse too.
    expect(validate.stateErrors(fixture({ "cluster-nodes": "3" })))
      .toContain(":cluster-nodes must be a positive integer");
  });

  test("the VPC is never desired state", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-mode": "managed" })).length)
      .toBeGreaterThan(0);
    // A pinned VPC is refused by the standard's discovered-network rule.
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-uuid": "00000000-0000-0000-0000-000000000000" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-cidr": "10.110.0.0/20" })).length)
      .toBeGreaterThan(0);
  });

  test("the group name must be a UUID", () => {
    expect(validate.stateErrors(fixture({ "mysql-group-name": "mysql-ha" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "mysql-group-name": "00000000-1111-2222-3333-444444444444" })))
      .toEqual([]);
  });

  test("the endpoint must live in the managed zone", () => {
    expect(validate.stateErrors(fixture({ "cluster-host": "my-ha.example.org" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-host": "not a hostname" })).length)
      .toBeGreaterThan(0);
  });

  test("the proxy cannot carry MySQL", () => {
    expect(validate.stateErrors(fixture({ "cloudflare-proxied": true })).length)
      .toBeGreaterThan(0);
  });

  test("the destroy guard must be a boolean", () => {
    expect(validate.stateErrors(fixture({ "compute-prevent-destroy": "true" })).length)
      .toBeGreaterThan(0);
  });

  test("backups may not share the state bucket", () => {
    expect(validate.stateErrors(
      fixture({ "backup-r2-bucket": String(fixture()["r2-bucket"]) })).length)
      .toBeGreaterThan(0);
  });

  test("source lists must be CIDRs", () => {
    // The messages are ONCE's: the source lists are the Compute Provider
    // Standard's, checked over `spec`.
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })))
      .toContain(":digitalocean-ssh-sources must list at least one CIDR");
    expect(validate.stateErrors(fixture({ "digitalocean-client-sources": ["203.0.113.7"] })))
      .toContain(':digitalocean-client-sources entry "203.0.113.7" is not an IPv4 or IPv6 CIDR');
    // A string is a list, the way an overlay carries one.
    expect(validate.stateErrors(
      fixture({ "digitalocean-ssh-sources": "203.0.113.7/32, 198.51.100.0/24" }))).toEqual([]);
  });

  test("schedules and durations are checked", () => {
    expect(validate.stateErrors(fixture({ "heartbeat-interval": "often" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "backup-snapshot-oncalendar": "daily at one" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "mysql-innodb-buffer-pool-size": "lots" })).length)
      .toBeGreaterThan(0);
  });

  test("the group port cannot be the client port", () => {
    expect(validate.stateErrors(fixture({ "mysql-group-port": 3306 })).length)
      .toBeGreaterThan(0);
  });

  test("a real run needs exactly the credentials the design allows", () => {
    const errors = validate.secretErrors(fixture({ "red/event": "create" }));
    const named = new Set(errors.map((e) => e.match(/(COLORS_PAR_\S+)/)?.[1]));
    // The package must not invent a credential beyond the two it is given.
    expect(named).toEqual(new Set([
      "COLORS_PAR_MYSQL_ADMIN_PASSWORD",
      "COLORS_PAR_MYSQL_REPLICATION_PASSWORD",
      "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
      "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
      "COLORS_PAR_DO_TOKEN",
      "COLORS_PAR_CLOUDFLARE_API_TOKEN",
    ]));
  });

  test("health needs no database credential", () => {
    const errors = validate.secretErrors(fixture({ "red/event": "health" }));
    expect(errors.some((e) => /MYSQL/.test(e))).toBe(false);
    expect(errors.some((e) => /DO_TOKEN/.test(e))).toBe(true);
  });

  test("supplied credentials are not reported missing", () => {
    expect(validate.secretErrors(fixture({
      "red/event": "create",
      "mysql-admin-password": "a",
      "mysql-replication-password": "b",
      "backup-r2-access-key-id": "c",
      "backup-r2-secret-access-key": "d",
      "do-token": "e",
      "cloudflare-api-token": "f",
    }))).toEqual([]);
  });

  test("only the providers this package implements are accepted", () => {
    expect(validate.stateErrors(fixture({ "provider-compute": "hcloud" })))
      .toContain(":provider-compute must be one of digitalocean");
    expect(validate.stateErrors(fixture({ "provider-dns": "yandex" })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "provider-backend": "local" }))).toEqual([]);
  });
});

// --- workflow ----------------------------------------------------------------

const create: Opts = { "red/event": "create" };
const build: Opts = { "red/event": "build" };
const del: Opts = { "red/event": "delete" };
const health: Opts = { "red/event": "health" };

const credentials: Opts = {
  "mysql-admin-password": "a",
  "mysql-replication-password": "b",
  "backup-r2-access-key-id": "c",
  "backup-r2-secret-access-key": "d",
  "do-token": "e",
  "cloudflare-api-token": "f",
};

// `params` as a converged deployment records it.
const converged = (): computeCluster.ClusterParams => ({
  provider: "digitalocean",
  reserved_ip: "203.0.113.10",
  vpc_id: "5a6b7c8d-0000-4000-8000-000000000001",
  vpc_ip_range: "10.110.0.0/20",
  nodes: [0, 1, 2].map((i) => ({
    index: i, role: null, name: `fixture-node-${i + 1}`,
    ip: `203.0.113.1${i + 1}`, vpc_ip: `10.110.0.${5 + i}`,
    droplet_id: 512000001 + i, user: "root", sudoer: "root",
  })),
});

// The compute state is read once per run, through the injectable reader, on a
// real create, delete or health. Every lifecycle test injects one: undefined
// is a readable state holding no compute, a map is a recorded `params`, and a
// throw is a backend that cannot be read.
const start = (opts: Opts, state: computeCluster.ClusterParams | undefined) =>
  workflow.startStep(opts, {}, async () => state);
// The shape `red/tofu` throws: the SDK's StepError. Only that is an unreadable
// backend; anything else propagates as a defect.
const startUnreadable = (opts: Opts) =>
  workflow.startStep(opts, {}, async () => { throw new StepError("tofu output failed: no backend"); });
const never = async (): Promise<undefined> => { throw new Error("the reader must not run"); };

const nexts = (step: string, runOpts: Opts): string[] =>
  (workflow.wireFn(step, runOpts) ?? []).slice(1).map(String);

describe("workflow", () => {
  test("create forks after the local ssh config and joins at the cluster", () => {
    expect(nexts("mysql-ha/start", create)).toEqual(["mysql-ha/infrastructure"]);
    // The block is written after compute, where the addresses first exist,
    // and before any member is converged.
    expect(nexts("mysql-ha/infrastructure", create)).toEqual(["mysql-ha/ansible-local"]);
    expect(workflow.wireFn("mysql-ha/ansible-local", create)?.[0]).toBe(tools.ansibleLocalStep);
    expect(nexts("mysql-ha/ansible-local", create)).toEqual(["mysql-ha/dns", "mysql-ha/base"]);
    // Both branches converge on one step, so the engine joins them once.
    expect(nexts("mysql-ha/dns", create)).toEqual(["mysql-ha/cluster"]);
    expect(nexts("mysql-ha/base", create)).toEqual(["mysql-ha/cluster"]);
    expect(nexts("mysql-ha/cluster", create)).toEqual(["mysql-ha/backup"]);
    expect(nexts("mysql-ha/backup", create)).toEqual(["mysql-ha/health"]);
    expect(nexts("mysql-ha/health", create)).toEqual([]);
  });

  test("build walks the same graph as create", () => {
    for (const step of ["mysql-ha/start", "mysql-ha/infrastructure", "mysql-ha/ansible-local",
                        "mysql-ha/dns", "mysql-ha/base", "mysql-ha/cluster", "mysql-ha/backup"]) {
      expect(nexts(step, build)).toEqual(nexts(step, create));
    }
  });

  test("delete reads state first and destroys in reverse", () => {
    expect(nexts("mysql-ha/start", del)).toEqual(["mysql-ha/load-infrastructure"]);
    expect(nexts("mysql-ha/load-infrastructure", del)).toEqual(["mysql-ha/cleanup"]);
    // The ssh config block goes before the destroy, the keypair after it
    // (ssh-config.md §4).
    expect(nexts("mysql-ha/cleanup", del)).toEqual(["mysql-ha/ansible-local"]);
    expect(nexts("mysql-ha/ansible-local", del)).toEqual(["mysql-ha/dns"]);
    expect(nexts("mysql-ha/dns", del)).toEqual(["mysql-ha/infrastructure"]);
    expect(nexts("mysql-ha/infrastructure", del)).toEqual(["mysql-ha/ssh-cleanup"]);
    expect(workflow.wireFn("mysql-ha/ssh-cleanup", del)?.[0]).toBe(ssh.cleanupStep);
    expect(nexts("mysql-ha/ssh-cleanup", del)).toEqual([]);
  });

  test("a build fills the placeholder key paths", async () => {
    // Every event fills the machine-key paths in preflight so the templates
    // and the inventory render the same whichever step scaffolds them; a build
    // gets the fixed placeholder, never the operator's home.
    const r = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect(r["red/exit"]).toBe(0);
    expect(r["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/mysql-ha-fixture");
    expect(r["ssh-keygen"]).toBe(true);
    // Opt-out invents no key path.
    const o = await workflow.startStep(optout({ "red/event": "build" }), {});
    expect(o["red/exit"]).toBe(0);
    expect(o["ssh-private-key-path"]).toBeUndefined();
    expect(o["ssh-keygen"]).toBeUndefined();
  });

  test("health changes nothing", () => {
    expect(nexts("mysql-ha/start", health)).toEqual(["mysql-ha/load-infrastructure"]);
    expect(nexts("mysql-ha/load-infrastructure", health)).toEqual(["mysql-ha/health"]);
    expect(workflow.wireFn("mysql-ha/health", health)?.[0]).toBe(tools.healthStep);
    // No stage that converges anything is reachable from health.
    for (const fn of [workflow.wireFn("mysql-ha/load-infrastructure", health)?.[0],
                      workflow.wireFn("mysql-ha/health", health)?.[0]]) {
      expect([tools.infrastructureStep, tools.dnsStep, tools.clusterStep])
        .not.toContain(fn);
    }
  });

  test("a build needs no credential", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "build" }), {});
    expect(result["red/exit"]).toBe(0);
  });

  test("build and dry-run never read the state", async () => {
    // A throwing reader proves nothing on these paths reaches the backend.
    for (const opts of [fixture({ "red/event": "build" }),
                        fixture({ "red/event": "create", "red/dry-run": true }),
                        fixture({ "red/event": "delete", "red/dry-run": true }),
                        fixture({ "red/event": "health", "red/dry-run": true })]) {
      const r = await startUnreadable(opts);
      expect(r["red/exit"]).toBe(0);
      expect("mysql-ha/state" in r).toBe(false);
    }
  });

  test("a real run refuses without credentials", async () => {
    const result = await start(fixture({ "red/event": "create" }), undefined);
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_MYSQL_ADMIN_PASSWORD");
  });

  test("a dry-run needs no credential", async () => {
    const result = await workflow.startStep(
      fixture({ "red/event": "create", "red/dry-run": true }), {});
    expect(result["red/exit"]).toBe(0);
  });

  test("the profile parameter is refused before anything else", async () => {
    const result = await workflow.startStep(
      fixture({ "red/event": "build" }), { COLORS_PAR_PROFILE: "elsewhere" });
    expect(result["red/exit"]).toBe(2);
    expect(String(result["red/err"])).toContain("COLORS_PAR_PROFILE");
    // The state is not read for a refused profile, nor for invalid desired
    // state.
    const refused = await workflow.startStep(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }),
      { COLORS_PAR_PROFILE: "elsewhere" }, never);
    expect(refused["red/exit"]).toBe(2);
    const invalid = await workflow.startStep(
      fixture({ "red/event": "delete", "cluster-nodes": 2, ...credentials }), {}, never);
    expect(invalid["red/exit"]).toBe(2);
  });

  test("the destroy guard holds and lifts for exactly one run", async () => {
    const held = await start(fixture({ "red/event": "delete", ...credentials }), undefined);
    expect(held["red/exit"]).toBe(2);
    expect(String(held["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
    const lifted = await start(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }),
      undefined);
    expect(lifted["red/exit"]).toBe(0);
  });

  test("defaults do not quietly permit destruction", () => {
    expect(workflow.defaults["compute-prevent-destroy"]).toBe(true);
  });

  // --- the Compute Cluster Standard's safety boundaries

  test("a provider switch is refused before the credentials", async () => {
    for (const event of ["create", "delete", "health"]) {
      const r = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
                            { ...converged(), provider: "vultr" });
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"]))
        .toContain("state holds a vultr machine; set provider-compute back to vultr and delete first");
      // The validator order is the thing under test: the actionable error,
      // not a missing token for the provider that was just selected.
      expect(String(r["red/err"])).not.toContain("required credential is not set");
    }
  });

  test("legacy state accepts only the default provider", async () => {
    // A recorded provider is absent from every pre-adoption state; on the one
    // provider this package offers that is the default, and the run proceeds
    // to its credentials. A second provider would be refused by selection
    // before the state is read, so the other branch of the rule has no
    // reachable input here.
    for (const event of ["create", "delete", "health"]) {
      const r = await start(fixture({ "red/event": event, "compute-prevent-destroy": false }),
                            without(converged(), "provider"));
      expect(r["red/exit"]).toBe(2);
      expect(String(r["red/err"])).not.toContain("state holds");
      expect(String(r["red/err"])).toContain("required credential is not set");
    }
  });

  test("a matching provider passes to the credentials", async () => {
    const r = await start(fixture({ "red/event": "create" }), converged());
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("an unreadable backend counts as no state on create", async () => {
    // A fresh clone has no readable state and must still be able to create.
    const r = await startUnreadable(fixture({ "red/event": "create" }));
    expect(r["red/exit"]).toBe(2);
    expect(String(r["red/err"])).not.toContain("could not read");
    expect(String(r["red/err"])).not.toContain("state holds");
    expect(String(r["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
  });

  test("a real create on a fresh work directory reports the credentials, not a crash", async () => {
    // No reader stub: the real `stateOutput` runs against a work directory
    // that holds no stage yet, as a fresh clone's does. It renders the stage,
    // writes its local backend and initializes it, and finds no state — or
    // fails to launch tofu, which the SDK reports as its StepError. Either way
    // ONCE's `readState` counts it as no usable state, so the create reports
    // its credentials instead of crashing.
    const work = mkdtempSync(join(tmpdir(), "mysql-ha-red-fresh"));
    try {
      const result = await workflow.startStep(fixture({ workdir: work, "red/event": "create" }), {});
      expect(result["red/exit"]).toBe(2);
      expect(String(result["red/err"])).toContain("COLORS_PAR_DO_TOKEN");
      expect(String(result["red/err"])).not.toContain("could not read");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("an unreadable backend fails a real delete closed", async () => {
    // Swallowing it is how a teardown ends up converging against 192.0.2.11.
    // Preflight hands the read on; `load-infrastructure`, the first step after
    // it and before any side effect, is where the delete stops.
    const r = await startUnreadable(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }));
    expect(r["red/exit"]).toBe(0);
    expect(r["mysql-ha/state"]).toEqual({ error: "tofu output failed: no backend" });
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(1);
    expect(String(loaded["red/err"])).toContain("could not read the infrastructure state for the delete cleanup");
    expect(String(loaded["red/err"])).toContain("no backend");
  });

  test("a real delete adopts the recorded cluster", async () => {
    const r = await start(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }),
      converged());
    expect(r["red/exit"]).toBe(0);
    expect(r["mysql-ha/state"]).toEqual({ params: converged() });
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(0);
    expect(loaded["once/cluster"]).toEqual(converged());
    expect(tools.nodes(loaded).map((n) => n["public-ip"])).toEqual(["203.0.113.11", "203.0.113.12", "203.0.113.13"]);
    // A readable state without a cluster leaves nothing to clean up.
    const empty = await tools.loadInfrastructureStep(await start(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }), undefined));
    expect(empty["red/exit"]).toBe(0);
    expect(empty["mysql-ha/infrastructure-present?"]).toBe(false);
  });

  test("a partial cluster is refused on a real run", async () => {
    const params = converged();
    const r = await start(fixture({ "red/event": "health", ...credentials }),
                          { ...params, nodes: params.nodes!.slice(0, 2) });
    // The switch guard reads only the provider.
    expect(r["red/exit"]).toBe(0);
    const loaded = await tools.loadInfrastructureStep(r);
    expect(loaded["red/exit"]).toBe(1);
    expect(loaded["red/err"]).toBe("the compute stage did not report nodes this package declares: 2");
  });

  test("every side-effecting step is skipped by dry-run", () => {
    for (const event of ["create", "delete", "health"]) {
      const wired = workflow.sideEffecting.filter((step) =>
        workflow.wireFn(step, { "red/event": event }));
      for (const step of wired) expect(workflow.sideEffecting).toContain(step);
    }
  });

  test("a whole build renders every stage", async () => {
    const result = await run("build", "-f", fixtureFile);
    expect(result["red/exit"]).toBe(0);
    const root = join(import.meta.dir, "../../test/fixtures/.colors/mysql-ha-fixture");
    for (const stage of ["mysql-ha-infrastructure", "mysql-ha-ansible-local", "mysql-ha-dns", "mysql-ha-ansible"]) {
      expect(statSync(join(root, stage)).isDirectory()).toBe(true);
    }
    // The backend is written by advice, before the stage runs.
    expect(existsSync(join(root, "mysql-ha-infrastructure", "backend.tf.json"))).toBe(true);
    expect(existsSync(join(root, "mysql-ha-dns", "backend.tf.json"))).toBe(true);
    // Nothing that looks like a credential is written.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of files(root)) {
      expect(readFileSync(file, "utf8"))
        .not.toMatch(/REPLACE_ME|BEGIN [A-Z ]*PRIVATE KEY/);
    }
  });
});

// --- the machine keypair -----------------------------------------------------

describe("ssh", () => {
  test("a build never names the operator's home", () => {
    // Committed goldens must mean the same thing on every workstation, so a
    // build renders a fixed placeholder rather than reading ~/.ssh.
    const opts = ssh.withMachineKey(fixture({ "red/event": "build" }));
    expect(opts["ssh-private-key-path"]).toBe("/home/build-placeholder/.ssh/mysql-ha-fixture");
    expect(opts["ssh-public-key-path"]).toBe("/home/build-placeholder/.ssh/mysql-ha-fixture.pub");
    // The placeholder lands on the provider's own machine-key key.
    expect(opts["digitalocean-ssh-keys"]).toBe("/home/build-placeholder/.ssh/mysql-ha-fixture.pub");
    expect(String(process.env.HOME)).not.toContain("build-placeholder");
  });

  test("a dry-run is held to the same rule as a build", () => {
    // A dry-run is a create that touches nothing; testing the event alone would
    // let it reach the real key path.
    expect(ssh.renderedOnly({ "red/event": "build" })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create", "red/dry-run": true })).toBe(true);
    expect(ssh.renderedOnly({ "red/event": "create" })).toBe(false);
    expect(ssh.withMachineKey(fixture({ "red/event": "create", "red/dry-run": true }))["ssh-private-key-path"])
      .toBe("/home/build-placeholder/.ssh/mysql-ha-fixture");
  });

  test("real events render the real path", () => {
    const opts = ssh.withMachineKey(fixture({ "red/event": "health" }));
    expect(String(opts["ssh-private-key-path"])).not.toContain("build-placeholder");
    expect(String(opts["ssh-private-key-path"]).endsWith("/.ssh/mysql-ha-fixture")).toBe(true);
  });

  test("opt-out opts pass through untouched", () => {
    const opts = optout({ "red/event": "build" });
    expect(ssh.withMachineKey(opts)).toEqual(opts);
    expect(ssh.withMachineKey(opts)["ssh-private-key-path"]).toBeUndefined();
  });
});

// --- ~/.ssh/config -----------------------------------------------------------

describe("ssh-config", () => {
  const opts = fixture({ profile: "mysql-ha-digitalocean" });

  test("the deployment claims one alias per member and the bare profile", () => {
    // `ssh mysql-ha-digitalocean` is what the standard promises; the numbered
    // aliases are what make a group operable, since half of running one is
    // reaching a specific member.
    expect(sshConfig.aliases(opts)).toEqual(
      ["mysql-ha-digitalocean", "mysql-ha-digitalocean-0", "mysql-ha-digitalocean-1", "mysql-ha-digitalocean-2"]);
  });

  test("the identity file stays unexpanded", () => {
    expect(sshConfig.identityFile(opts)).toBe("~/.ssh/mysql-ha-digitalocean");
  });

  test("a foreign stanza is found for any alias, not just the first", () => {
    const lines = "Host something\n  HostName 1.2.3.4\n\nHost mysql-ha-digitalocean-2\n  HostName 5.6.7.8\n"
      .split("\n");
    expect(sshConfig.foreignStanzaLine(lines, "mysql-ha-digitalocean")).toBeUndefined();
    expect(sshConfig.foreignStanzaLine(lines, "mysql-ha-digitalocean-2")).toBe(4);
  });

  test("our own managed block is not foreign for any alias in it", () => {
    // One block, marked with the profile, holding a stanza per member. Deriving
    // the marker from the stanza being searched — which a single-node package
    // can get away with — makes the check hunt for
    // `# BEGIN mysql-ha-digitalocean-0 …`, never find it, and refuse to
    // converge because of a block this package wrote itself.
    const lines = [
      "# BEGIN mysql-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host mysql-ha-digitalocean", "  HostName 1.2.3.4",
      "Host mysql-ha-digitalocean-0", "  HostName 1.2.3.4",
      "Host mysql-ha-digitalocean-1", "  HostName 1.2.3.5",
      "Host mysql-ha-digitalocean-2", "  HostName 1.2.3.6",
      "# END mysql-ha-digitalocean ANSIBLE MANAGED BLOCK",
    ];
    for (const alias of sshConfig.aliases(opts)) {
      expect(sshConfig.foreignStanzaLine(lines, alias, "mysql-ha-digitalocean")).toBeUndefined();
    }
  });

  test("a member stanza outside our block is still foreign", () => {
    const lines = [
      "# BEGIN mysql-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host mysql-ha-digitalocean", "  HostName 1.2.3.4",
      "# END mysql-ha-digitalocean ANSIBLE MANAGED BLOCK",
      "Host mysql-ha-digitalocean-1", "  HostName 9.9.9.9",
    ];
    expect(sshConfig.foreignStanzaLine(lines, "mysql-ha-digitalocean-1", "mysql-ha-digitalocean")).toBe(5);
  });

  test("a global option above the first Host blocks the run", () => {
    // The block is inserted at BOF, so it would capture such an option into one
    // stanza and silently narrow a setting that applied to every host.
    expect(sshConfig.leadingOptionLine(["ServerAliveInterval 60", "Host x"])).toBe(1);
    expect(sshConfig.leadingOptionLine(["# a comment", "", "Host x", "  User root"]))
      .toBeUndefined();
    // An option below a Host line belongs to that host and is fine.
    expect(sshConfig.leadingOptionLine(["Host x", "  ServerAliveInterval 60"])).toBeUndefined();
  });

  test("the refusal is reported as a failed step", () => {
    const refused = sshConfig.preflight(opts, {
      adoptError: () => "no",
      placementError: () => undefined,
    });
    expect(refused["red/exit"]).toBe(1);
    expect(refused["red/err"]).toBe("no");
    const passed = sshConfig.preflight(opts, {
      adoptError: () => undefined,
      placementError: () => undefined,
    });
    expect(passed["red/exit"]).toBeUndefined();
  });
});
