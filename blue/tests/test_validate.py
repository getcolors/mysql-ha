from conftest import fixture
from package_mysql_ha_blue import validate
from package_once_blue import compute_cluster as cluster


def test_the_fixture_is_renderable():
    assert validate.state_errors(fixture()) == []


def test_every_required_key_is_required():
    for key in [*validate.own_required,
                *validate.compute_providers["digitalocean"]["required"]]:
        opts = fixture()
        del opts[key]
        assert any(f"{key} is required" in e
                   for e in validate.state_errors(opts)), key


def test_the_profile_parameter_is_refused():
    assert validate.env_errors({}) == []
    assert validate.env_errors({"COLORS_PAR_PROFILE": ""}) == []
    assert validate.env_errors({"COLORS_PAR_PROFILE": "somewhere-else"})


def test_the_spec_describes_one_homogeneous_role_on_a_discovered_network():
    # The Compute Cluster Standard's spec is data ONCE reads; this is the one
    # place its content is asserted, so a drift in any colour is a test
    # failure and not a rendered surprise.
    assert cluster.spec_errors(validate.spec) == []
    assert list(validate.spec["registry"]) == ["digitalocean"]
    assert validate.spec["default"] == "digitalocean"
    assert validate.spec["registry"]["digitalocean"]["network"] == {"mode": "discovered"}
    assert validate.spec["sources"]["non_empty"] == ["ssh-sources", "client-sources"]
    assert validate.spec["roles"] == [
        {"role": None, "count_key": "cluster-nodes", "count": 3, "fallback_offset": 11}]
    assert validate.spec["fallback_subnet"] == "10.110.0.0/20"
    assert cluster.topology_errors(validate.spec, fixture()) == []


def test_the_node_budget_is_three():
    assert validate.state_errors(fixture({"cluster-nodes": 2}))
    assert validate.state_errors(fixture({"cluster-nodes": 5}))
    # A count that is not a positive integer is ONCE's to refuse too.
    assert ":cluster-nodes must be a positive integer" in \
        validate.state_errors(fixture({"cluster-nodes": "3"}))


def test_the_vpc_is_never_desired_state():
    assert validate.state_errors(fixture({"digitalocean-vpc-mode": "managed"}))
    # A pinned VPC is refused by the standard's discovered-network rule.
    assert validate.state_errors(
        fixture({"digitalocean-vpc-uuid": "00000000-0000-0000-0000-000000000000"}))
    assert validate.state_errors(fixture({"digitalocean-vpc-cidr": "10.110.0.0/20"}))


def test_the_group_name_must_be_a_uuid():
    assert validate.state_errors(fixture({"mysql-group-name": "mysql-ha"}))
    assert validate.state_errors(
        fixture({"mysql-group-name": "00000000-1111-2222-3333-444444444444"})) == []


def test_the_endpoint_must_live_in_the_managed_zone():
    assert validate.state_errors(fixture({"cluster-host": "my-ha.example.org"}))
    assert validate.state_errors(fixture({"cluster-host": "not a hostname"}))


def test_the_proxy_cannot_carry_mysql():
    assert validate.state_errors(fixture({"cloudflare-proxied": True}))


def test_the_destroy_guard_must_be_a_boolean():
    assert validate.state_errors(fixture({"compute-prevent-destroy": "true"}))


def test_backups_may_not_share_the_state_bucket():
    assert validate.state_errors(
        fixture({"backup-r2-bucket": fixture()["r2-bucket"]}))


def test_source_lists_must_be_cidrs():
    # The messages are ONCE's: the source lists are the Compute Provider
    # Standard's, checked over `spec`.
    assert ":digitalocean-ssh-sources must list at least one CIDR" in \
        validate.state_errors(fixture({"digitalocean-ssh-sources": []}))
    assert ':digitalocean-client-sources entry "203.0.113.7" is not an IPv4 or IPv6 CIDR' in \
        validate.state_errors(fixture({"digitalocean-client-sources": ["203.0.113.7"]}))
    # A string is a list, the way an overlay carries one.
    assert validate.state_errors(
        fixture({"digitalocean-ssh-sources": "203.0.113.7/32, 198.51.100.0/24"})) == []


def test_schedules_and_durations_are_checked():
    assert validate.state_errors(fixture({"heartbeat-interval": "often"}))
    assert validate.state_errors(
        fixture({"backup-snapshot-oncalendar": "daily at one"}))
    assert validate.state_errors(
        fixture({"mysql-innodb-buffer-pool-size": "lots"}))


def test_the_group_port_cannot_be_the_client_port():
    assert validate.state_errors(fixture({"mysql-group-port": 3306}))


def test_a_real_run_needs_exactly_the_credentials_the_design_allows():
    errors = validate.secret_errors(fixture({"blue/event": "create"}))
    named = {e.rsplit(" ", 1)[-1] for e in errors}
    # The package must not invent a credential beyond the two it is given.
    assert named == {"COLORS_PAR_MYSQL_ADMIN_PASSWORD",
                     "COLORS_PAR_MYSQL_REPLICATION_PASSWORD",
                     "COLORS_PAR_BACKUP_R2_ACCESS_KEY_ID",
                     "COLORS_PAR_BACKUP_R2_SECRET_ACCESS_KEY",
                     "COLORS_PAR_DO_TOKEN",
                     "COLORS_PAR_CLOUDFLARE_API_TOKEN"}


def test_health_needs_no_database_credential():
    errors = validate.secret_errors(fixture({"blue/event": "health"}))
    assert not any("MYSQL" in e for e in errors)
    assert any("DO_TOKEN" in e for e in errors)


def test_supplied_credentials_are_not_reported_missing():
    assert validate.secret_errors(fixture({
        "blue/event": "create",
        "mysql-admin-password": "a",
        "mysql-replication-password": "b",
        "backup-r2-access-key-id": "c",
        "backup-r2-secret-access-key": "d",
        "do-token": "e",
        "cloudflare-api-token": "f",
    })) == []


def test_only_the_providers_this_package_implements_are_accepted():
    assert ":provider-compute must be one of digitalocean" in \
        validate.state_errors(fixture({"provider-compute": "hcloud"}))
    assert validate.state_errors(fixture({"provider-dns": "yandex"}))
    assert validate.state_errors(fixture({"provider-backend": "local"})) == []
