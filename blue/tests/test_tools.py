import json
from pathlib import Path

import pytest
from colors_compute import collect, expand
from conftest import fixture
from package_mysql_ha_blue import compute, tools


def recorded():
    return collect(expand([{'count': 3}]), [
        {'node_id': str(i), 'provider': 'digitalocean', 'provider_id': str(100+i), 'name': f'member-{i}',
         'ip': f'203.0.113.{i+1}', 'vpc_ip': f'10.20.0.{i+11}', 'user': 'root', 'sudoer': 'root'} for i in range(3)], '0')


def converged():
    return fixture({'blue/event': 'create', 'colors-compute/cluster': recorded(),
                    'colors-compute/shared': {'params': {'network_cidr': '10.20.0.0/20', 'endpoint_ip': '203.0.113.99'}},
                    'ssh-private-key-path': '/tmp/owned'})


def test_live_endpoint_and_member_identities_reach_application_inventory():
    opts = converged()
    data = tools.data_fn(opts)
    assert data['reserved_ip'] == '203.0.113.99' and data['vpc_ip_range'] == '10.20.0.0/20'
    groups = json.loads(tools.inventory(opts))['all']['children']
    assert len(groups['mysql']['hosts']) == 3 and list(groups['bootstrap']['hosts']) == ['member-0']
    assert groups['mysql']['hosts']['member-0']['node_uid'] == '100'
    assert data['group-seeds'] == '10.20.0.11:33061,10.20.0.12:33061,10.20.0.13:33061'


def test_application_requires_endpoint_capability_and_legacy_migration_guard():
    policy = compute.requirements(fixture())
    assert policy['endpoint'] == {'kind': 'reserved-ip', 'assignment': 'application'}
    assert policy['private'] is True
    assert policy['legacy_state_keys'] == ['mysql-ha-fixture/mysql-ha-infrastructure.tfstate']
    with pytest.raises(ValueError):
        tools.nodes(fixture({'blue/event': 'create'}))
    opts = converged()
    del opts['colors-compute/cluster']['nodes'][0]['provider_id']
    with pytest.raises(ValueError, match='provider identity'):
        tools.nodes(opts)


def test_endpoint_assignment_and_health_delegate_to_library_agent():
    source = Path(tools.__file__).parent / 'resources/tools/ansible'
    endpoint = (source / 'files/mysql-ha-endpoint').read_text()
    assert 'is_primary || exit 0' in endpoint and 'SELECT @@super_read_only' in endpoint
    assert 'colors-compute-endpoint' in endpoint and 'api.digitalocean.com' not in endpoint
    health = (source / 'files/mysql-ha-health').read_text()
    assert '--action status' in health and 'api.digitalocean.com' not in health
    backup = (source / 'backup.yml').read_text()
    assert 'endpoint-credentials' in backup and '| quote' in backup and 'no_log: true' in backup
    specifications = tools.ansible_specs(converged())
    assert any(str(spec['target']).endswith('/files/colors-compute-endpoint') for spec in specifications)


def test_dns_backend_uses_only_backend_and_dns_credentials():
    env = tools.credential_env(fixture({'r2-access-key-id': 'test-access', 'r2-secret-access-key': 'test-secret', 'cloudflare-api-token': 'dns-token'}), 'provider-dns')
    assert env['AWS_ACCESS_KEY_ID'] == 'test-access' and env['AWS_SECRET_ACCESS_KEY'] == 'test-secret'
    assert env['CLOUDFLARE_API_TOKEN'] == 'dns-token' and 'DIGITALOCEAN_TOKEN' not in env
