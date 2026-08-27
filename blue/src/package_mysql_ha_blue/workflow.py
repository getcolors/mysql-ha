"""The lifecycle graph, preflight, and the backend advice each OpenTofu stage
runs behind — the port of io.github.getcolors.mysql-ha.workflow.

Create forks after the infrastructure: Cloudflare and apt have nothing to say
to each other, so `dns` and `base` run in parallel and join at `cluster`.
Joining DNS there rather than leaving it dangling means a bad zone or a
missing token surfaces before any data-plane work starts.

Delete and health both begin by reading node addresses out of remote state,
because neither can re-derive them.
"""

from __future__ import annotations

from blue import dry_run, progress, tofu
from blue.cli import par_name, read_pars
from blue.lifecycle import preflight
from blue.workflow import advice_add, workflow

from . import tools, validate

DEFAULTS = {"compute-prevent-destroy": True,
            "provider-compute": "digitalocean",
            "provider-dns": "cloudflare",
            "provider-backend": "local",
            "workdir": ".colors"}

# Events that reach a provider and therefore need credentials. `build` is
# deliberately absent: a fresh checkout with an empty environment must render.
CREDENTIAL_EVENTS = ("create", "delete", "health")


async def start_step(opts: dict, env: dict | None = None) -> dict:
    return await preflight(
        opts, defaults=DEFAULTS, overlay=read_pars, env=env,
        validators=[
            lambda _o, e, _c: validate.env_errors(e),
            lambda o, _e, _c: validate.state_errors(o),
            lambda o, _e, c: (validate.secret_errors(o)
                              if c["real"] and c["event"] in CREDENTIAL_EVENTS else []),
            lambda o, _e, c: ([f"compute destruction is protected; set "
                               f"{par_name('compute-prevent-destroy')}=false to delete"]
                              if c["real"] and c["event"] == "delete"
                              and o.get("compute-prevent-destroy") else []),
        ])


def wire_fn(step: str, run_opts: dict):
    if run_opts.get("blue/event") == "delete":
        return {
            "mysql-ha/start": (start_step, "mysql-ha/load-infrastructure"),
            "mysql-ha/load-infrastructure": (tools.load_infrastructure_step,
                                             "mysql-ha/cleanup"),
            "mysql-ha/cleanup": (tools.cleanup_step, "mysql-ha/dns"),
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
    return {
        "mysql-ha/start": (start_step, "mysql-ha/infrastructure"),
        "mysql-ha/infrastructure": (tools.infrastructure_step,
                                    "mysql-ha/dns", "mysql-ha/base"),
        "mysql-ha/dns": (tools.dns_step, "mysql-ha/cluster"),
        "mysql-ha/base": (tools.base_step, "mysql-ha/cluster"),
        "mysql-ha/cluster": (tools.cluster_step, "mysql-ha/backup"),
        "mysql-ha/backup": (tools.backup_step, "mysql-ha/health"),
        "mysql-ha/health": (tools.health_step,),
    }.get(step)


def backend_advice(tool: str):
    return tofu.conventional_backend_advice(
        dir=lambda o, tool=tool: tools.tool_dir(o, tool),
        key=lambda o, tool=tool: f"{o.get('profile')}/{tool}.tfstate")


side_effecting = ["mysql-ha/infrastructure", "mysql-ha/load-infrastructure",
                  "mysql-ha/dns", "mysql-ha/base", "mysql-ha/cluster",
                  "mysql-ha/backup", "mysql-ha/health", "mysql-ha/cleanup"]


def create_workflow():
    wf = workflow(start="mysql-ha/start", wire_fn=wire_fn)
    wf = progress.advise(wf)
    wf = dry_run.advise(wf, side_effecting)
    for tool in tools.tofu_tools:
        wf = advice_add(wf, f"mysql-ha/{tool[len('mysql-ha-'):]}", "before",
                        f"io.github.getcolors.mysql-ha.workflow/backend-{tool}",
                        backend_advice(tool))
    # `load-infrastructure` runs `tofu init` in the infrastructure stage's
    # own directory, so it needs that stage's backend written first — the
    # same advice, targeted at a different step.
    return advice_add(wf, "mysql-ha/load-infrastructure", "before",
                      "io.github.getcolors.mysql-ha.workflow/backend-load-infrastructure",
                      backend_advice(tools.infrastructure_tool))


mysql_ha_workflow = create_workflow()
