// OpenTofu and Ansible stages for the three-member Group Replication cluster —
// the port of io.github.getcolors.mysql-ha.tools.
//
// Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
// reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
// One Ansible directory holds every playbook, because they share an inventory
// and a set of rendered scripts and splitting them across directories would
// duplicate both.

import * as ansible from "red/ansible";
import { toolEnv } from "red/providers";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import ansibleCfg from "../resources/tools/ansible/ansible.cfg" with { type: "text" };
import ansibleBackup from "../resources/tools/ansible/backup.yml" with { type: "text" };
import ansibleBase from "../resources/tools/ansible/base.yml" with { type: "text" };
import ansibleCleanup from "../resources/tools/ansible/cleanup.yml" with { type: "text" };
import ansibleCluster from "../resources/tools/ansible/cluster.yml" with { type: "text" };
import ansibleHealth from "../resources/tools/ansible/health.yml" with { type: "text" };
import filesApparmorLocal from "../resources/tools/ansible/files/apparmor-local" with { type: "text" };
import filesBinlogArchive from "../resources/tools/ansible/files/mysql-ha-binlog-archive" with { type: "text" };
import filesBinlogUpload from "../resources/tools/ansible/files/mysql-ha-binlog-upload" with { type: "text" };
import filesEndpoint from "../resources/tools/ansible/files/mysql-ha-endpoint" with { type: "text" };
import filesHealth from "../resources/tools/ansible/files/mysql-ha-health" with { type: "text" };
import filesHeartbeat from "../resources/tools/ansible/files/mysql-ha-heartbeat" with { type: "text" };
import filesLib from "../resources/tools/ansible/files/mysql-ha-lib" with { type: "text" };
import filesRestoreCheck from "../resources/tools/ansible/files/mysql-ha-restore-check" with { type: "text" };
import filesSnapshot from "../resources/tools/ansible/files/mysql-ha-snapshot" with { type: "text" };
import filesMysqldCnf from "../resources/tools/ansible/files/mysqld.cnf" with { type: "text" };
import filesNodeEnv from "../resources/tools/ansible/files/node.env" with { type: "text" };
import filesVerifyCnf from "../resources/tools/ansible/files/verify.cnf" with { type: "text" };
import dnsMainTf from "../resources/tools/dns/main.tf" with { type: "text" };
import infrastructureMainTf from "../resources/tools/infrastructure/main.tf" with { type: "text" };

export const infrastructureTool = "mysql-ha-infrastructure";
export const dnsTool = "mysql-ha-dns";
export const ansibleTool = "mysql-ha-ansible";
export const tofuTools = [infrastructureTool, dnsTool];

const templateOpts = PRESERVE_JINJA_DELIMITERS;

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible/ansible.cfg": ansibleCfg,
  "ansible/backup.yml": ansibleBackup,
  "ansible/base.yml": ansibleBase,
  "ansible/cleanup.yml": ansibleCleanup,
  "ansible/cluster.yml": ansibleCluster,
  "ansible/health.yml": ansibleHealth,
  "ansible/files/apparmor-local": filesApparmorLocal,
  "ansible/files/mysql-ha-binlog-archive": filesBinlogArchive,
  "ansible/files/mysql-ha-binlog-upload": filesBinlogUpload,
  "ansible/files/mysql-ha-endpoint": filesEndpoint,
  "ansible/files/mysql-ha-health": filesHealth,
  "ansible/files/mysql-ha-heartbeat": filesHeartbeat,
  "ansible/files/mysql-ha-lib": filesLib,
  "ansible/files/mysql-ha-restore-check": filesRestoreCheck,
  "ansible/files/mysql-ha-snapshot": filesSnapshot,
  "ansible/files/mysqld.cnf": filesMysqldCnf,
  "ansible/files/node.env": filesNodeEnv,
  "ansible/files/verify.cnf": filesVerifyCnf,
  "dns/main.tf": dnsMainTf,
  "infrastructure/main.tf": infrastructureMainTf,
};

export function template(path: string, file: string): Template {
  const name = `${path.replaceAll(".", "/")}/${file}`;
  const content = templates[name];
  if (content === undefined) throw new StepError(`template not found: ${name}`);
  return { name, content };
}

function spec(source: Template, target: string, data: Opts): Spec {
  return { template: source, target, data, opts: templateOpts };
}

const rawSpec = (target: string, content: string): Spec => contentSpec(target, content);

export function toolDir(opts: Opts, tool: string): string {
  return utils.toolDir(opts, tool);
}

export function credentialEnv(opts: Opts, ...slots: string[]): Record<string, string> | undefined {
  return toolEnv(validate.providers, opts, [...slots, "provider-backend"]);
}

// ---------------------------------------------------------------------------
// infrastructure

// Stand-ins so `build` and `--dry-run` render the same shape of file as a real
// run, without ever reading state or contacting a provider. Documentation-range
// addresses, so a rendered artifact that leaked into a real run would fail
// loudly rather than reach something.
export const fallbackOutputs: Opts = {
  node_public_ips: ["192.0.2.11", "192.0.2.12", "192.0.2.13"],
  node_private_ips: ["10.110.0.11", "10.110.0.12", "10.110.0.13"],
  node_droplet_ids: [100000001, 100000002, 100000003],
  reserved_ip: "192.0.2.10",
  vpc_id: "00000000-0000-0000-0000-000000000000",
  vpc_ip_range: "10.110.0.0/20",
};

export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  const data: Opts = {
    ...opts,
    "node-count": utils.nodeCount(opts),
    "digitalocean-ssh-sources-json":
      JSON.stringify(opts["digitalocean-ssh-sources"]),
    "digitalocean-client-sources-json":
      JSON.stringify(opts["digitalocean-client-sources"]),
  };
  return [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`, data)];
}

function outputsMap(result: Opts): Opts {
  return (result["mysql-ha/outputs"] as Opts | undefined) ?? {};
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const result = await tofu.tofuWithSpec(
    opts, infrastructureSpecs(opts),
    {
      dir: toolDir(opts, infrastructureTool),
      env: credentialEnv(opts, "provider-compute"),
      outputKey: "mysql-ha/outputs",
    });
  if (failed(result)) return result;
  if (opts["red/event"] === "delete") return result;
  if (opts["red/event"] === "build") return { ...result, ...fallbackOutputs };
  return { ...result, ...fallbackOutputs, ...outputsMap(result) };
}

export function processResult(
  opts: Opts, label: string, res: { exit: number; out: string; err: string },
): Opts {
  if (res.exit === 0) return { ...opts, "red/exit": 0 };
  return {
    ...opts,
    "red/exit": Math.max(1, res.exit),
    "red/err": `${label} failed: ${res.err || res.out || "(no output)"}`,
  };
}

// Read node addresses out of remote state without planning or changing
// anything. Delete and health both need the inventory and neither can
// re-derive it; `k8s` needs the same thing for the same reason.
export async function loadInfrastructureStep(opts: Opts): Promise<Opts> {
  const dir = toolDir(opts, infrastructureTool);
  const rendered: Opts = {
    ...scaffold({ ...opts, "red/event": "build" }, infrastructureSpecs(opts)),
    "red/event": opts["red/event"],
  };
  const env = credentialEnv(opts, "provider-compute");
  const init = await runtime.exec(
    ["tofu", `-chdir=${dir}`, "init", "-input=false", "-no-color"], { env });
  if (init.exit !== 0) {
    return processResult(rendered, "infrastructure state initialization", init);
  }
  try {
    const outputs = await tofu.outputs(dir, env);
    return {
      ...rendered, ...fallbackOutputs, ...outputs,
      "mysql-ha/infrastructure-present?": "reserved_ip" in outputs,
    };
  } catch (t) {
    return {
      ...rendered,
      "red/exit": 1,
      "red/err": `infrastructure state output failed: ${
        t instanceof Error ? t.message || t.constructor.name : String(t)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// shared template data

// One map per member, in ordinal order, merging desired state with whatever
// the infrastructure stage reported. Pure: given the same opts it is the same
// vector, which is what makes the inventory and the goldens deterministic.
export function nodes(opts: Opts): Opts[] {
  const data = { ...fallbackOutputs, ...opts };
  return utils.ordinals(opts).map((ordinal) => {
    const idx = ordinal - 1;
    return {
      ordinal,
      name: utils.nodeName(opts, ordinal),
      host: utils.nodeHost(opts, ordinal),
      "public-ip": (data.node_public_ips as unknown[])?.[idx] ?? null,
      "private-ip": (data.node_private_ips as unknown[])?.[idx] ?? null,
      "droplet-id": (data.node_droplet_ids as unknown[])?.[idx] ?? null,
      "server-id": utils.serverId(ordinal),
      "connection-server-id": utils.connectionServerId(ordinal),
    };
  });
}

// `group_replication_group_seeds`: every member's private address on the group
// port. Every member gets the same list, so a joining member can reach the
// group through whichever seed is up.
export function groupSeeds(opts: Opts): string {
  return nodes(opts)
    .map((node) => `${node["private-ip"]}:${opts["mysql-group-port"]}`)
    .join(",");
}

export function dataFn(opts: Opts): Opts {
  const data = { ...fallbackOutputs, ...opts };
  return {
    ...data,
    "node-count": utils.nodeCount(opts),
    "backup-prefix": utils.backupPrefix(opts),
    "group-seeds": groupSeeds(data),
    "cluster-record": utils.recordName(opts["cluster-host"]),
  };
}

// Java's Double.toString, which is what Cheshire renders floats through and
// therefore what green's committed inventory bytes would carry. Integral
// numbers print as longs. JS's shortest-round-trip digits are the same digits
// Java chooses; only the layout differs.
function javaNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  const negative = value < 0;
  const [mantissa, exponentPart] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentPart);
  const digits = mantissa!.replace(".", "");
  let body: string;
  if (exponent >= -3 && exponent < 7) {
    if (exponent >= 0) {
      const intPart = digits.padEnd(exponent + 1, "0").slice(0, exponent + 1);
      const fracPart = digits.slice(exponent + 1);
      body = `${intPart}.${fracPart.length > 0 ? fracPart : "0"}`;
    } else {
      body = `0.${"0".repeat(-exponent - 1)}${digits}`;
    }
  } else {
    const rest = digits.slice(1);
    body = `${digits[0]}.${rest.length > 0 ? rest : "0"}E${exponent}`;
  }
  return negative ? `-${body}` : body;
}

// Cheshire's pretty printer, byte for byte: spaces around colons, arrays
// inline, nested objects newline-indented, floats in Java notation.
function pretty(value: unknown, indent = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[ ]";
    return `[ ${value.map((item) => pretty(item, indent)).join(", ")} ]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{ }";
    const pad = " ".repeat(indent + 2);
    return `{\n${entries
      .map(([key, nested]) => `${pad}${JSON.stringify(key)} : ${pretty(nested, indent + 2)}`)
      .join(",\n")}\n${" ".repeat(indent)}}`;
  }
  if (typeof value === "number") return javaNumber(value);
  return JSON.stringify(value ?? null);
}

// Ansible inventory as JSON. Every member is in `mysql`; `primary_candidate`
// names member one, which is only ever used to pick who bootstraps an empty
// group — it carries no meaning once the group exists.
export function inventory(opts: Opts): string {
  const data = dataFn(opts);
  const keyFile = String(data["digitalocean-ssh-private-key"]);
  const hosts: Record<string, Opts> = Object.fromEntries(
    nodes(data)
      .map((node) => [String(node.name), {
        // Key order matches green's sorted-map: alphabetical.
        ansible_host: node["public-ip"],
        ansible_ssh_private_key_file: keyFile,
        ansible_user: "root",
        connection_server_id: node["connection-server-id"],
        droplet_id: node["droplet-id"],
        node_host: node.host,
        node_ordinal: node.ordinal,
        private_ip: node["private-ip"],
        server_id: node["server-id"],
      }] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const bootstrapName = utils.nodeName(opts, 1);
  return pretty({
    all: {
      children: {
        mysql: { hosts },
        bootstrap: {
          hosts: bootstrapName in hosts
            ? { [bootstrapName]: hosts[bootstrapName] }
            : {},
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// dns

export function dnsSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, dnsTool);
  const base = dataFn(opts);
  const records: Record<string, unknown> = Object.fromEntries(
    nodes(base)
      .map((node) => [utils.recordName(node.host), node["public-ip"]] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const data = { ...base, "node-records-json": JSON.stringify(records) };
  return [spec(template("dns", "main.tf"), `${dir}/main.tf`, data)];
}

export async function dnsStep(opts: Opts): Promise<Opts> {
  return tofu.tofuWithSpec(opts, dnsSpecs(opts), {
    dir: toolDir(opts, dnsTool),
    env: credentialEnv(opts, "provider-dns"),
    outputKey: "mysql-ha/dns-outputs",
  });
}

// ---------------------------------------------------------------------------
// ansible

const playbooks = ["base.yml", "cluster.yml", "backup.yml", "health.yml", "cleanup.yml"];

// Everything copied onto a member. Credentials are deliberately absent: the
// three files that hold one (`rclone.conf`, `binlog-client.cnf`,
// `secrets.env`) are written by Ansible from `lookup('env', ...)` under
// `no_log`, so no secret is ever rendered into the work directory.
const nodeFiles = [
  "mysql-ha-lib", "mysql-ha-endpoint", "mysql-ha-heartbeat", "mysql-ha-snapshot",
  "mysql-ha-binlog-archive", "mysql-ha-binlog-upload", "mysql-ha-restore-check",
  "mysql-ha-health", "mysqld.cnf", "verify.cnf", "apparmor-local", "node.env",
];

export function ansibleSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleTool);
  const data = dataFn(opts);
  return [
    spec(template("ansible", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    ...playbooks.map((playbook) =>
      spec(template("ansible", playbook), `${dir}/${playbook}`, data)),
    ...nodeFiles.map((file) =>
      spec(template("ansible.files", file), `${dir}/files/${file}`, data)),
    rawSpec(`${dir}/inventory.json`, inventory(opts)),
  ];
}

function ansibleConfig(opts: Opts, playbook: string, recapKey: string): ansible.AnsibleConfig {
  return {
    dir: toolDir(opts, ansibleTool),
    inventory: "inventory.json",
    playbooks: { create: playbook, delete: playbook },
    hostKeyChecking: false,
    recapKey,
  };
}

// Render the whole Ansible directory once, so every later stage runs against
// one materialized tree rather than re-rendering per playbook.
export function ansibleRenderStep(opts: Opts): Opts {
  return scaffold(opts, ansibleSpecs(opts));
}

async function playbookStep(opts: Opts, playbook: string, recapKey: string): Promise<Opts> {
  if (opts["red/event"] === "build") return scaffold(opts, ansibleSpecs(opts));
  return ansible.ansibleStep(
    scaffold({ ...opts, "red/event": "create" }, ansibleSpecs(opts)),
    ansibleConfig(opts, playbook, recapKey));
}

export async function baseStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "base.yml", "mysql-ha/base-recap")),
           "red/event": opts["red/event"] };
}

export async function clusterStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "cluster.yml", "mysql-ha/cluster-recap")),
           "red/event": opts["red/event"] };
}

export async function backupStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "backup.yml", "mysql-ha/backup-recap")),
           "red/event": opts["red/event"] };
}

export async function healthStep(opts: Opts): Promise<Opts> {
  return { ...(await playbookStep(opts, "health.yml", "mysql-ha/health-recap")),
           "red/event": opts["red/event"] };
}

// Stop the managed units before the droplets go away. Skipped when the
// infrastructure is already gone, because there is nothing to reach.
export async function cleanupStep(opts: Opts): Promise<Opts> {
  if (opts["mysql-ha/infrastructure-present?"] === false) {
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(
    opts, ansibleConfig(opts, "cleanup.yml", "mysql-ha/cleanup-recap"),
    ansibleSpecs(opts));
}
