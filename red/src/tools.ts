// OpenTofu and Ansible stages for the three-member Group Replication cluster —
// the port of io.github.getcolors.mysql-ha.tools.
//
// Two OpenTofu stages: `mysql-ha-infrastructure` owns the droplets, the
// reserved IP and both firewalls; `mysql-ha-dns` owns the Cloudflare records.
// One Ansible directory holds every playbook, because they share an inventory
// and a set of rendered scripts and splitting them across directories would
// duplicate both.
//
// The cluster itself — which machines exist, at which addresses — is the
// Compute Cluster Standard's `params`, adopted through ONCE's `computeCluster`
// module and carried under `once/cluster`. This package puts its own facts
// inside it: `reserved_ip`, `vpc_id` and `vpc_ip_range` at the top level, a
// `droplet_id` on every node.

import * as ansible from "red/ansible";
import { toolEnv } from "red/providers";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import { compute, computeCluster } from "package-once-red";
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

// The state backend of one OpenTofu stage, written before the stage runs.
// `dir` and `key` are explicit so the state addresses cannot move.
export function backendAdvice(tool: string) {
  return tofu.conventionalBackendAdvice({
    dir: (opts) => toolDir(opts, tool),
    key: (opts) => `${opts.profile}/${tool}.tfstate`,
  });
}

function refuse(opts: Opts, errors: string[]): Opts {
  return { ...opts, "red/exit": 1, "red/err": errors.join("\n") };
}

// ---------------------------------------------------------------------------
// infrastructure

// Stand-ins for the cluster facts beside the nodes, so `build` and `--dry-run`
// render the same shape of file as a real run without ever reading state or
// contacting a provider. Documentation-range values, so a rendered artifact
// that leaked into a real run would fail loudly rather than reach something.
// The nodes themselves are ONCE's fallbacks, cut from `spec`'s subnet at
// offset 11.
export const fallbackOutputs: Opts = {
  reserved_ip: "192.0.2.10",
  vpc_id: "00000000-0000-0000-0000-000000000000",
  vpc_ip_range: "10.110.0.0/20",
};

// The droplet id a build renders for member `ordinal`; a real run reads every
// id from state.
const fallbackDropletId = (ordinal: number): number => 100000000 + ordinal;

export function infrastructureSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, infrastructureTool);
  const data: Opts = {
    ...opts,
    "node-count": utils.nodeCount(opts),
    "digitalocean-ssh-sources-json":
      JSON.stringify(compute.cidrs(opts, "digitalocean-ssh-sources")),
    "digitalocean-client-sources-json":
      JSON.stringify(compute.cidrs(opts, "digitalocean-client-sources")),
  };
  return [spec(template("infrastructure", "main.tf"), `${dir}/main.tf`, data)];
}

// The compute stage's `params` output, as ONCE reads it; undefined when the
// apply reported none.
export function outputParams(result: Opts): computeCluster.ClusterParams | undefined {
  return computeCluster.outputParams({ "tofu/outputs": result["mysql-ha/outputs"] });
}

const nonBlank = (v: unknown): boolean =>
  (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && v.trim() !== "");

// The extension keys this package puts inside `params`, which ONCE preserves
// but does not read: a non-blank `reserved_ip` and `vpc_id`, a canonical
// `vpc_ip_range`, and a non-blank `droplet_id` on every node. A real run is
// refused without them; the legacy translation is held to the same rule.
export function paramsErrors(params: computeCluster.ClusterParams): string[] {
  const errors: string[] = [];
  for (const k of ["reserved_ip", "vpc_id"]) {
    if (!nonBlank(params[k])) errors.push(`compute state carries no ${k}`);
  }
  if (!nonBlank(params.vpc_ip_range)) {
    errors.push("compute state carries no vpc_ip_range");
  } else if (!computeCluster.ipv4Network(params.vpc_ip_range)) {
    errors.push(`compute state vpc_ip_range ${JSON.stringify(params.vpc_ip_range)}`
      + " is not a canonical IPv4 network such as 10.40.0.0/24");
  }
  const missing = (params.nodes ?? [])
    .filter((n) => !nonBlank(n.droplet_id))
    .map((n) => computeCluster.nodeIdStr(n));
  if (missing.length > 0) {
    errors.push(`compute state carries no droplet_id for ${missing.join(", ")}`);
  }
  return errors;
}

// `opts` once the adopted cluster passes `paramsErrors`, or the refusal.
function checked(opts: Opts): Opts {
  const errors = "once/cluster" in opts
    ? paramsErrors(opts["once/cluster"] as computeCluster.ClusterParams) : [];
  return errors.length > 0 ? refuse(opts, errors) : opts;
}

// What the infrastructure stage hands on after its apply: `result` as it is on
// a failure, a delete or a build, and otherwise ONCE's `resolvedCluster` over
// the apply's `params` output — undefined outputs and a partial cluster are
// refused there — checked against `paramsErrors`. Pure, so the wiring is
// testable without an apply.
export function resolveInfrastructure(opts: Opts, result: Opts): Opts {
  if (failed(result)) return result;
  if (opts["red/event"] === "delete" || opts["red/event"] === "build") return result;
  const resolved = computeCluster.resolvedCluster(validate.spec, opts, result, {}, outputParams(result));
  return failed(resolved) ? resolved : checked(resolved);
}

export async function infrastructureStep(opts: Opts): Promise<Opts> {
  const result = await tofu.tofuWithSpec(
    opts, infrastructureSpecs(opts),
    {
      dir: toolDir(opts, infrastructureTool),
      env: credentialEnv(opts, "provider-compute"),
      outputKey: "mysql-ha/outputs",
    });
  return resolveInfrastructure(opts, result);
}

// A state written before this package recorded `params`: the parallel
// `node_public_ips`, `node_private_ips` and `node_droplet_ids` lists, zipped
// into the nodes the standard describes, with `reserved_ip`, `vpc_id` and
// `vpc_ip_range` copied and the names this package has always given its
// members. Refused, as the SDK's `StepError`, when the three lists disagree
// with each other or with `cluster-nodes` — guessing which droplet is which is
// how a delete destroys around a member — and when no `reserved_ip` was
// recorded. A missing `vpc_id` or `vpc_ip_range` is `paramsErrors`' to refuse,
// the same way for a legacy and a recorded state.
export function legacyParams(opts: Opts, outputs: Record<string, unknown>): computeCluster.ClusterParams {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const publics = list(outputs.node_public_ips);
  const privates = list(outputs.node_private_ips);
  const ids = list(outputs.node_droplet_ids);
  const n = opts["cluster-nodes"];
  if (!(n === publics.length && n === privates.length && n === ids.length)) {
    throw new StepError(`legacy state lists ${publics.length} public addresses, `
      + `${privates.length} private addresses and ${ids.length} droplet ids; `
      + "refusing to guess the cluster");
  }
  if (!nonBlank(outputs.reserved_ip)) throw new StepError("legacy state carries no reserved_ip");
  return {
    provider: validate.defaultComputeProvider,
    reserved_ip: outputs.reserved_ip,
    vpc_id: outputs.vpc_id,
    vpc_ip_range: outputs.vpc_ip_range,
    nodes: Array.from({ length: n as number }, (_, i) => ({
      index: i,
      role: null,
      name: utils.nodeName(opts, i + 1),
      ip: publics[i] as string,
      vpc_ip: privates[i] as string,
      droplet_id: ids[i],
      user: "root",
      sudoer: "root",
    })),
  };
}

// The reader ONCE's `readState` takes: the compute `params` recorded in the
// infrastructure state, undefined when the state is readable and holds
// nothing, and the legacy translation when it holds only the pre-adoption
// outputs. Delete and health both need the cluster and neither can re-derive
// it — nor can a fresh clone, so the stage is rendered, its backend written
// and initialized here, before the read. A failed initialization throws the
// SDK's `StepError`, the shape `red/tofu` throws on an unreadable backend;
// `readState` reports both fail-closed. Injectable into `startStep` and
// `loadInfrastructureStep`, so tests never shell out to tofu.
export async function stateOutput(opts: Opts): Promise<computeCluster.ClusterParams | undefined> {
  const dir = toolDir(opts, infrastructureTool);
  const env = credentialEnv(opts, "provider-compute");
  scaffold({ ...opts, "red/event": "build" }, infrastructureSpecs(opts));
  await backendAdvice(infrastructureTool)(opts);
  const init = await runtime.exec(
    ["tofu", `-chdir=${dir}`, "init", "-input=false", "-no-color"], { env });
  if (init.exit !== 0) {
    throw new StepError(`infrastructure state initialization failed: ${init.err || init.out || "(no output)"}`);
  }
  const outputs = await tofu.outputs(dir, env);
  if ("params" in outputs) return outputs.params as computeCluster.ClusterParams;
  if (Object.keys(outputs).length === 0) return undefined;
  return legacyParams(opts, outputs);
}

// The health refusal when the state is readable and records no cluster: a
// real run never checks the documentation addresses.
export const noClusterMessage =
  "the infrastructure state records no cluster; refusing to check the documentation addresses";

// Adopt the cluster out of remote state without planning or changing anything:
// ONCE's `adoptState` over the read `startStep` handed on under
// `mysql-ha/state`, or a fresh read when nothing was. An unreadable backend and
// a partial cluster fail closed; the adopted `params` must then pass
// `paramsErrors`. A readable state without a cluster means there is nothing to
// clean up on a delete and nothing to check on a health.
export async function loadInfrastructureStep(
  opts: Opts,
  reader: compute.StateReader = stateOutput,
): Promise<Opts> {
  const event = String(opts["red/event"]);
  const { "mysql-ha/state": handed, ...rest } = opts;
  const state = "mysql-ha/state" in opts
    ? handed as compute.StateRead
    : await computeCluster.readState(opts, reader);
  const adopted = computeCluster.adoptState(validate.spec, rest, event, state);
  const present = "once/cluster" in adopted;
  if (failed(adopted)) return adopted;
  if (!present && event === "health") return refuse(adopted, [noClusterMessage]);
  const result = checked(adopted);
  if (failed(result)) return result;
  return { ...result, "mysql-ha/infrastructure-present?": present };
}

// ---------------------------------------------------------------------------
// shared template data

// ONCE's nodes for this deployment: the adopted `params.nodes` on a real run,
// the fallbacks on a build — renamed to what this package has always called
// its members and given a documentation droplet id, so the rendered inventory
// is byte-identical to what it was.
function clusterNodes(opts: Opts): computeCluster.Node[] {
  const params = opts["once/cluster"] as computeCluster.ClusterParams | undefined;
  const members = computeCluster.nodes(validate.spec, opts, params);
  if (params !== undefined && params !== null) return members;
  return members.map((node) => ({
    ...node,
    name: utils.nodeName(opts, node.index + 1),
    droplet_id: fallbackDropletId(node.index + 1),
  }));
}

// One map per member, in ordinal order: desired state's derivations over the
// node ONCE reports. Pure: given the same opts it is the same array, which is
// what makes the inventory and the goldens deterministic.
export function nodes(opts: Opts): Opts[] {
  return clusterNodes(opts).map((node) => {
    const ordinal = node.index + 1;
    return {
      ordinal,
      name: node.name,
      host: utils.nodeHost(opts, ordinal),
      "public-ip": node.ip ?? null,
      "private-ip": node.vpc_ip ?? null,
      "droplet-id": node.droplet_id ?? null,
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

// Template data: desired state over the fallback cluster facts, with the
// adopted cluster's `reserved_ip`, `vpc_id` and `vpc_ip_range` winning on a
// real run.
export function dataFn(opts: Opts): Opts {
  const recorded = (opts["once/cluster"] ?? {}) as Opts;
  const facts = Object.fromEntries(
    Object.keys(fallbackOutputs).filter((k) => k in recorded).map((k) => [k, recorded[k]]));
  const data = { ...fallbackOutputs, ...opts, ...facts };
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
  const members = nodes(data);
  const hosts: Record<string, Opts> = Object.fromEntries(
    members
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
  const bootstrapName = String(members[0]?.name);
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
