from blue.workflow import run
from conftest import fixture, optout
from package_mysql_ha_blue import tools, validate, workflow
from test_tools import recorded


def test_application_fork_join_and_cleanup_order_are_preserved():
    assert workflow.wire_fn('mysql-ha/ansible-local', {'blue/event': 'create'})[1:] == ('mysql-ha/dns', 'mysql-ha/base')
    assert workflow.wire_fn('mysql-ha/dns', {'blue/event': 'create'})[1] == 'mysql-ha/cluster'
    assert workflow.wire_fn('mysql-ha/base', {'blue/event': 'create'})[1] == 'mysql-ha/cluster'
    assert workflow.wire_fn('mysql-ha/dns', {'blue/event': 'delete'})[1] == 'mysql-ha/infrastructure'
    assert len(workflow.wire_fn('mysql-ha/infrastructure', {'blue/event': 'delete'})) == 1


async def test_native_build_renders_shared_endpoint_compute_and_application_agents(tmp_path):
    for load in (fixture, optout):
        directory = tmp_path / load()['profile']
        result = await run(workflow.mysql_ha_workflow, load({'blue/event': 'build', 'workdir': str(directory)}))
        assert result['blue/exit'] == 0, result.get('blue/err')
        assert list(directory.rglob('inventory.json'))
        assert list(directory.rglob('colors-compute-endpoint'))
        assert list(directory.rglob('*.tf.json'))
        assert result.get('ssh-private-key-path')


async def test_compute_adapter_adopts_only_library_success(monkeypatch):
    async def operation(opts, topology, requirements):
        assert topology == [{'role': None, 'count': 3}] and requirements['endpoint']['assignment'] == 'application'
        return {'status': 'ready', 'cluster': recorded(), 'shared': {'params': {'network_cidr': '10.20.0.0/20', 'endpoint_ip': '203.0.113.99'}}, 'key': {'private_key_path': '/tmp/owned'}}
    monkeypatch.setattr(tools, 'orchestrate', operation)
    result = await tools.infrastructure_step(fixture({'blue/event': 'create'}))
    assert result['blue/exit'] == 0 and tools.data_fn(result)['reserved_ip'] == '203.0.113.99'
    async def refused(*args): return {'status': 'error'}
    monkeypatch.setattr(tools, 'orchestrate', refused)
    assert (await tools.infrastructure_step(fixture({'blue/event': 'create'})))['blue/exit'] == 1


async def test_delete_and_health_never_adopt_unreadable_or_legacy_state(monkeypatch):
    async def read(opts): return {'status': 'error'}
    monkeypatch.setattr(tools, 'read_deployment', read)
    for event in ('delete', 'health'):
        result = await tools.load_infrastructure_step(fixture({'blue/event': event, 'compute-prevent-destroy': False}))
        assert result['blue/exit'] == 1 and 'explicit migration' in result['blue/err']


async def test_protected_delete_stops_before_work(monkeypatch):
    monkeypatch.setattr(validate, 'secret_errors', lambda *_: [])
    assert (await workflow.start_step(fixture({'blue/event': 'delete'}), {}))['blue/exit'] != 0
