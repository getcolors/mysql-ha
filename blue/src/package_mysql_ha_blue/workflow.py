"""The lifecycle graph, preflight, and the backend advice each OpenTofu stage
runs behind — the port of io.github.getcolors.mysql-ha.workflow.

Create forks after the infrastructure: Cloudflare and apt have nothing to say
to each other, so `dns` and `base` run in parallel and join at `cluster`.
Joining DNS there rather than leaving it dangling means a bad zone or a
missing token surfaces before any data-plane work starts.

Delete and health both begin by adopting the cluster out of remote state,
because neither can re-derive it. The state is read once, in preflight, so
the Compute Provider Standard's switch guard runs before the credentials are
checked; the read is handed to `load-infrastructure` rather than repeated.
"""

from __future__ import annotations

import os

from blue import dry_run, progress
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, failed, workflow


from . import ssh, ssh_config, tools, validate

DEFAULTS = {"compute-prevent-destroy": True,
            "provider-compute": validate.default_compute_provider,
            "provider-dns": "cloudflare",
            "provider-backend": "r2",
            "workdir": ".colors"}

# Events that reach a provider and therefore need credentials. `build` is
# deliberately absent: a fresh checkout with an empty environment must render.
CREDENTIAL_EVENTS = ("create", "delete", "health")


def _real_credential_event(context: dict) -> bool:
    return bool(context.get("real") and context.get("event") in CREDENTIAL_EVENTS)


async def start_step(original, env=None, reader=None):
    environment = dict(os.environ if env is None else env)
    async def after(opts, _env, context):
        if context['real'] and context['event'] == 'create':
            return ssh_config.preflight(opts)
        return {**ssh.with_machine_key(opts), 'blue/exit': 0}
    return await preflight(original, defaults=DEFAULTS, overlay=read_pars, env=environment,
        validators=[lambda _o, e, _c: validate.env_errors(e),
                    lambda o, _e, _c: validate.state_errors(o),
                    lambda o, _e, c: validate.secret_errors(o) if _real_credential_event(c) and not validate.state_errors(o) else [],
                    lambda o, _e, c: ['compute destruction is protected; set COLORS_PAR_COMPUTE_PREVENT_DESTROY=false for this one delete'] if c['real'] and c['event'] == 'delete' and o.get('compute-prevent-destroy') else []], after_validate=after)


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        # The `~/.ssh/config` block goes before the destroy, the keypair after
        # it. A block that outlives its host is stale but harmless; a key that
        # predeceases its host locks the operator out of members that still
        # exist. Both orders are deliberate — standards/ssh-config.md §4 is
        # explicit that they must not be tidied into agreement.
        return {
            "mysql-ha/start": (start_step, "mysql-ha/load-infrastructure"),
            "mysql-ha/load-infrastructure": (tools.load_infrastructure_step,
                                             "mysql-ha/cleanup"),
            "mysql-ha/cleanup": (tools.cleanup_step, "mysql-ha/ansible-local"),
            "mysql-ha/ansible-local": (tools.ansible_local_step, "mysql-ha/dns"),
            "mysql-ha/dns": (tools.dns_step, "mysql-ha/infrastructure"),
            "mysql-ha/infrastructure": (tools.infrastructure_step,),
        }.get(step)
    if run_opts.get("blue/event") == "health":
        return {
            "mysql-ha/start": (start_step, "mysql-ha/load-infrastructure"),
            "mysql-ha/load-infrastructure": (tools.load_infrastructure_step,
                                             "mysql-ha/health"),
            "mysql-ha/health": (tools.health_step,),
        }.get(step)
    # The block is written after compute, where the addresses first exist,
    # and before the members are converged (ssh-config.md §4).
    return {
        "mysql-ha/start": (start_step, "mysql-ha/infrastructure"),
        "mysql-ha/infrastructure": (tools.infrastructure_step, "mysql-ha/ansible-local"),
        "mysql-ha/ansible-local": (tools.ansible_local_step,
                                   "mysql-ha/dns", "mysql-ha/base"),
        "mysql-ha/dns": (tools.dns_step, "mysql-ha/cluster"),
        "mysql-ha/base": (tools.base_step, "mysql-ha/cluster"),
        "mysql-ha/cluster": (tools.cluster_step, "mysql-ha/backup"),
        "mysql-ha/backup": (tools.backup_step, "mysql-ha/health"),
        "mysql-ha/health": (tools.health_step,),
    }.get(step)


def backend_advice(tool: str):
    """The state backend of one OpenTofu stage: `tools.backend_advice`, which
    the state reader also runs, so a delete from a fresh clone finds its
    state."""
    return tools.backend_advice(tool)


side_effecting = ["mysql-ha/infrastructure", "mysql-ha/load-infrastructure",
                  "mysql-ha/ansible-local", "mysql-ha/dns", "mysql-ha/base",
                  "mysql-ha/cluster", "mysql-ha/backup", "mysql-ha/health",
                  "mysql-ha/cleanup", "mysql-ha/ssh-cleanup"]


def create_workflow():
    wf = workflow(start="mysql-ha/start", wire_fn=wire_fn, next_fn=lambda step, successors, opts: [] if opts.get('mysql-ha/already-destroyed') or failed(opts) else [(successor, opts) for successor in successors or []])
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting)
    return advice_add(wf, 'mysql-ha/dns', 'before', 'mysql-ha.workflow/backend-dns', backend_advice(tools.dns_tool))


mysql_ha_workflow = create_workflow()
