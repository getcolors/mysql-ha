import * as ansible from "red/ansible";
import { toolEnv } from "red/providers";
import { PRESERVE_JINJA_DELIMITERS, contentSpec, scaffold, type Spec, type Template } from "red/scaffold";
import * as tofu from "red/tofu";
import { runtime } from "red/runtime";
import type { Opts } from "red/workflow";
import { StepError, failed } from "red/workflow";
import {providers as onceBackends} from "package-once-red";
import {orchestrate,plan_deployment,read_deployment,endpoint_agent} from "colors-compute-red";
import * as compute from "./compute.ts";
import {mkdirSync,writeFileSync} from "node:fs";
import {dirname} from "node:path";
import * as ssh from "./ssh.ts";
import * as sshConfig from "./ssh-config.ts";
import * as utils from "./utils.ts";
import * as validate from "./validate.ts";

import ansibleLocalCfg from "../resources/tools/ansible-local/ansible.cfg" with { type: "text" };
import ansibleLocalInventory from "../resources/tools/ansible-local/inventory.ini" with { type: "text" };
import ansibleLocalMain from "../resources/tools/ansible-local/main.yml" with { type: "text" };
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


export const infrastructureTool = "mysql-ha-infrastructure";
export const dnsTool = "mysql-ha-dns";
export const ansibleLocalTool = "mysql-ha-ansible-local";
export const ansibleTool = "mysql-ha-ansible";
export const tofuTools = [infrastructureTool, dnsTool];

const templateOpts = PRESERVE_JINJA_DELIMITERS;

// The template tree this colour carries, keyed the way green names its
// classpath resources: "<path>/<file>" with dots as directories.
const templates: Record<string, string> = {
  "ansible-local/ansible.cfg": ansibleLocalCfg,
  "ansible-local/inventory.ini": ansibleLocalInventory,
  "ansible-local/main.yml": ansibleLocalMain,
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
  return toolEnv({...validate.providers,"provider-backend":onceBackends["provider-backend"]!}, opts, [...slots, "provider-backend"]);
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

const clusterNodes=(opts:Opts)=>compute.resolved(opts);
export async function infrastructureStep(opts:Opts):Promise<Opts>{
 const planning=opts['red/event']==='build'||opts['red/dry-run'];
 const result:any=planning?plan_deployment(opts,compute.topology(opts),compute.requirements(opts)):await orchestrate(opts,compute.topology(opts),compute.requirements(opts));
 if(!['planned','ready','destroyed'].includes(result.status))return refuse(opts,result.errors?.length?result.errors:['compute lifecycle refused; legacy monolithic state requires explicit migration']);
 if(planning){
  const sorted=(v:any):any=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
  for(const [stage,docs] of [['shared',result.documents.shared],...Object.entries(result.documents.nodes).map(([id,docs])=>['nodes/'+id,docs])] as [string,Record<string,any>][])
   for(const [filename,document] of Object.entries(docs)){const target=toolDir(opts,infrastructureTool)+'/'+stage+'/'+filename;mkdirSync(dirname(target),{recursive:true});writeFileSync(target,JSON.stringify(sorted(document),null,2)+'\n');}
 }
 const values:Opts={...opts,'red/exit':0};if(result.cluster){values['colors-compute/cluster']=result.cluster;values['colors-compute/shared']=result.shared??{};}
 if(result.key?.private_key_path)values['ssh-private-key-path']=planning?result.key.private_key_path.replace('$HOME/.ssh','/home/build-placeholder/.ssh'):result.key.private_key_path;
 return values;
}
export async function loadInfrastructureStep(opts:Opts,reader:typeof read_deployment=read_deployment):Promise<Opts>{
 if(opts['red/event']==='build'||opts['red/dry-run'])return infrastructureStep(opts);
 const result:any=await reader(opts);if(result.status==='destroyed')return {...opts,'mysql-ha/already-destroyed':true,'red/exit':0};
 if(result.status!=='present')return refuse(opts,['compute state unavailable; legacy monolithic state requires explicit migration']);
 return {...opts,'colors-compute/cluster':result.cluster,'colors-compute/shared':result.shared??{},'mysql-ha/infrastructure-present?':true,...(result.key?.private_key_path?{'ssh-private-key-path':result.key.private_key_path}:{}),'red/exit':0};
}

export function nodes(opts: Opts): Opts[] {
  return clusterNodes(opts).map((node) => {
    if(!node.provider_id)throw Error("compute node provider identifier unavailable");
    const ordinal = node.index + 1;
    return {
      ordinal,
      name: node.name,
      host: utils.nodeHost(opts, ordinal),
      "public-ip": node.ip ?? null,
      "private-ip": node.vpc_ip ?? null,
      uid:node.provider_id,user:node.user,
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

export const privateKeyFile=(opts:Opts)=>String(opts['ssh-private-key-path']??'');
export function dataFn(opts:Opts):Opts{
 opts=ssh.withMachineKey(opts);
 const shared=opts['colors-compute/shared']??((opts['red/event']==='build'||opts['red/dry-run'])?plan_deployment(opts,compute.topology(opts),compute.requirements(opts)).shared:{});
 const facts=shared.params??{};if(!facts.network_cidr||!facts.endpoint_ip)throw Error('compute shared network or reserved endpoint unavailable');
 const agent=endpoint_agent(opts['provider-compute']);
 const data={...opts,'endpoint-credentials':agent.credentials,vpc_ip_range:facts.network_cidr,reserved_ip:facts.endpoint_ip};
 return {...data,'node-count':utils.nodeCount(opts),'backup-prefix':utils.backupPrefix(opts),'group-seeds':groupSeeds(data),'cluster-record':utils.recordName(opts['cluster-host'])};
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
  const keyFile = privateKeyFile(data);
  const members = nodes(data);
  const hosts: Record<string, Opts> = Object.fromEntries(
    members
      .map((node) => [String(node.name), {
        // Key order matches green's sorted-map: alphabetical.
        ansible_host: node["public-ip"],
        ansible_ssh_private_key_file: keyFile,
        ansible_user: node.user,
        connection_server_id: node["connection-server-id"],
        node_host: node.host,
        node_ordinal: node.ordinal,
        node_uid: node.uid,
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
// ssh config (local)

// Only what a `build` genuinely knows. Addresses are run-time facts and reach
// the play as extra-vars instead, so the rendered playbook carries no IP and is
// identical on every workstation (SSH Config Standard §6).
export function ansibleLocalData(opts: Opts): Opts {
  opts=ssh.withMachineKey(opts);
  return {
    ...opts,
    "ssh-keygen": validate.keygen(opts),
    "ssh-config-identity-file": validate.keygen(opts) ? sshConfig.identityFile(opts) : opts["ssh-private-key-path"] || "",
    "host-alias": sshConfig.hostAlias(opts),
  };
}

export function ansibleLocalSpecs(opts: Opts): Spec[] {
  const dir = toolDir(opts, ansibleLocalTool);
  const data = ansibleLocalData(opts);
  return [
    spec(template("ansible-local", "ansible.cfg"), `${dir}/ansible.cfg`, data),
    spec(template("ansible-local", "inventory.ini"), `${dir}/inventory.ini`, data),
    spec(template("ansible-local", "main.yml"), `${dir}/main.yml`, data),
  ];
}

export function sshConfigHosts(opts:Opts){const list=clusterNodes(opts);return [{...list[0],name:opts.profile},...list.map(node=>({...node,name:opts.profile+'-'+node.index}))];}

// Write or remove the `~/.ssh/config` block. The same playbook serves both
// events; `block_state` is what distinguishes them. Skipped on a delete whose
// state records no cluster: there is no block to withdraw.
export async function ansibleLocalStep(opts: Opts): Promise<Opts> {
  const isDelete = opts["red/event"] === "delete";
  if (isDelete && opts["mysql-ha/infrastructure-present?"] === false) {
    return { ...opts, "red/exit": 0 };
  }
  return ansible.ansibleWithSpec(opts, {
    dir: toolDir(opts, ansibleLocalTool),
    inventory: "inventory.ini",
    playbooks: { create: "main.yml", delete: "main.yml" },
    extraVars: {
      host_alias: sshConfig.hostAlias(opts),
      ssh_hosts: sshConfigHosts(opts),
      block_state: isDelete ? "absent" : "present",
    },
  }, ansibleLocalSpecs(opts));
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
    rawSpec(`${dir}/files/colors-compute-endpoint`, endpoint_agent(opts["provider-compute"]).content),
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
