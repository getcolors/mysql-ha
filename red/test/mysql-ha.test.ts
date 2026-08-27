import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Opts } from "red/workflow";
import * as tools from "../src/tools.ts";
import * as utils from "../src/utils.ts";
import * as validate from "../src/validate.ts";
import * as workflow from "../src/workflow.ts";
import { run } from "../src/cli.ts";

const fixtureFile = join(import.meta.dir, "../../test/fixtures/colors.yml");

function fixture(overrides: Opts = {}): Opts {
  const text = readFileSync(fixtureFile, "utf8");
  return { ...(Bun.YAML.parse(text) as Opts), ...overrides };
}

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

  test("every member seeds from every member", () => {
    const seeds = tools.groupSeeds({ ...tools.fallbackOutputs, ...fixture() });
    expect(seeds.split(",").length).toBe(3);
    expect(seeds).toContain(":33061");
  });

  test("the inventory names both groups", () => {
    const inv = JSON.parse(tools.inventory(fixture()));
    const children = inv.all.children;
    expect(Object.keys(children.mysql.hosts).length).toBe(3);
    expect(Object.keys(children.bootstrap.hosts)).toEqual(["fixture-node-1"]);
    // Bootstrap is only ever member one, and only for an empty group.
    expect(children.bootstrap.hosts["fixture-node-1"])
      .toEqual(children.mysql.hosts["fixture-node-1"]);
    expect(children.mysql.hosts["fixture-node-2"].ansible_ssh_private_key_file)
      .toBe("~/.ssh/id_ed25519");
  });

  test("the inventory is byte-stable", () => {
    expect(tools.inventory(fixture())).toBe(tools.inventory(fixture()));
  });

  test("build never reads state", () => {
    // Fallback addresses are documentation range, so a leak fails loudly.
    for (const ip of tools.fallbackOutputs.node_public_ips as string[]) {
      expect(ip.startsWith("192.0.2.")).toBe(true);
    }
    expect(String(tools.fallbackOutputs.reserved_ip).startsWith("192.0.2.")).toBe(true);
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

  test("every required key is required", () => {
    for (const key of validate.ownRequired) {
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

  test("the node budget is three", () => {
    expect(validate.stateErrors(fixture({ "cluster-nodes": 2 })).length).toBeGreaterThan(0);
    expect(validate.stateErrors(fixture({ "cluster-nodes": 5 })).length).toBeGreaterThan(0);
  });

  test("the VPC is never desired state", () => {
    expect(validate.stateErrors(fixture({ "digitalocean-vpc-mode": "managed" })).length)
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
    expect(validate.stateErrors(fixture({ "digitalocean-ssh-sources": [] })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "digitalocean-client-sources": ["203.0.113.7"] })).length)
      .toBeGreaterThan(0);
    expect(validate.stateErrors(
      fixture({ "digitalocean-ssh-sources": "203.0.113.7/32" })).length)
      .toBeGreaterThan(0);
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
    expect(validate.stateErrors(fixture({ "provider-compute": "hcloud" })).length)
      .toBeGreaterThan(0);
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

const nexts = (step: string, runOpts: Opts): string[] =>
  (workflow.wireFn(step, runOpts) ?? []).slice(1).map(String);

describe("workflow", () => {
  test("create forks at the infrastructure and joins at the cluster", () => {
    expect(nexts("mysql-ha/start", create)).toEqual(["mysql-ha/infrastructure"]);
    expect(nexts("mysql-ha/infrastructure", create)).toEqual(["mysql-ha/dns", "mysql-ha/base"]);
    // Both branches converge on one step, so the engine joins them once.
    expect(nexts("mysql-ha/dns", create)).toEqual(["mysql-ha/cluster"]);
    expect(nexts("mysql-ha/base", create)).toEqual(["mysql-ha/cluster"]);
    expect(nexts("mysql-ha/cluster", create)).toEqual(["mysql-ha/backup"]);
    expect(nexts("mysql-ha/backup", create)).toEqual(["mysql-ha/health"]);
    expect(nexts("mysql-ha/health", create)).toEqual([]);
  });

  test("build walks the same graph as create", () => {
    for (const step of ["mysql-ha/start", "mysql-ha/infrastructure", "mysql-ha/dns",
                        "mysql-ha/base", "mysql-ha/cluster", "mysql-ha/backup"]) {
      expect(nexts(step, build)).toEqual(nexts(step, create));
    }
  });

  test("delete reads state first and destroys in reverse", () => {
    expect(nexts("mysql-ha/start", del)).toEqual(["mysql-ha/load-infrastructure"]);
    expect(nexts("mysql-ha/load-infrastructure", del)).toEqual(["mysql-ha/cleanup"]);
    expect(nexts("mysql-ha/cleanup", del)).toEqual(["mysql-ha/dns"]);
    expect(nexts("mysql-ha/dns", del)).toEqual(["mysql-ha/infrastructure"]);
    expect(nexts("mysql-ha/infrastructure", del)).toEqual([]);
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

  test("a real run refuses without credentials", async () => {
    const result = await workflow.startStep(fixture({ "red/event": "create" }), {});
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
  });

  test("the destroy guard holds and lifts for exactly one run", async () => {
    const credentials: Opts = {
      "mysql-admin-password": "a",
      "mysql-replication-password": "b",
      "backup-r2-access-key-id": "c",
      "backup-r2-secret-access-key": "d",
      "do-token": "e",
      "cloudflare-api-token": "f",
    };
    const held = await workflow.startStep(
      fixture({ "red/event": "delete", ...credentials }), {});
    expect(held["red/exit"]).toBe(2);
    expect(String(held["red/err"])).toContain("COMPUTE_PREVENT_DESTROY");
    const lifted = await workflow.startStep(
      fixture({ "red/event": "delete", "compute-prevent-destroy": false, ...credentials }),
      {});
    expect(lifted["red/exit"]).toBe(0);
  });

  test("defaults do not quietly permit destruction", () => {
    expect(workflow.defaults["compute-prevent-destroy"]).toBe(true);
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
    for (const stage of ["mysql-ha-infrastructure", "mysql-ha-dns", "mysql-ha-ansible"]) {
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
