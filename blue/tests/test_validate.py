from conftest import fixture, optout
from package_mysql_ha_blue import validate


def test_the_fixture_is_renderable():
    assert validate.state_errors(fixture()) == []


def test_both_keypair_modes_are_renderable():
    # The SSH Keypair Standard has two modes and conformance means both hold.
    assert validate.state_errors(optout()) == []
    assert validate.keygen(fixture())
    assert not validate.keygen(optout())


def test_the_machine_key_is_never_required():
    # Its absence is keygen mode, not a missing key.
    assert not any("digitalocean-ssh-keys" in e for e in validate.state_errors(fixture()))


def test_the_private_key_path_is_desired_state_in_opt_out_mode_only():
    opts = optout()
    del opts["digitalocean-ssh-private-key"]
    assert ":ssh-private-key-path is required for external SSH access" \
        in validate.state_errors(opts)
    # Keygen mode names the generated key itself and asks for no path.
    opts = fixture()
    opts.pop("digitalocean-ssh-private-key", None)
    assert validate.state_errors(opts) == []


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




def test_the_node_budget_is_three():
    assert validate.state_errors(fixture({"cluster-nodes": 2}))
    assert validate.state_errors(fixture({"cluster-nodes": 5}))
    # A count that is not a positive integer is ONCE's to refuse too.
    assert validate.state_errors(fixture({"cluster-nodes": "3"}))




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
                     "COLORS_PAR_R2_ACCESS_KEY_ID",
                     "COLORS_PAR_R2_SECRET_ACCESS_KEY",
                     "COLORS_PAR_CLOUDFLARE_API_TOKEN"}


def test_health_needs_no_database_credential():
    errors = validate.secret_errors(fixture({"blue/event": "health"}))
    assert not any("MYSQL" in e for e in errors)
    assert not any("DO_TOKEN" in e for e in errors)


def test_supplied_credentials_are_not_reported_missing():
    assert validate.secret_errors(fixture({
        "blue/event": "create",
        "mysql-admin-password": "a",
        "mysql-replication-password": "b",
        "backup-r2-access-key-id": "c",
        "backup-r2-secret-access-key": "d",
        "do-token": "e",
        "cloudflare-api-token": "f",
        "r2-access-key-id": "state-access", "r2-secret-access-key": "state-secret",
    })) == []




def test_endpoint_capability_and_backend_requirements_are_library_owned():
    assert validate.state_errors(fixture({'provider-backend': 'local'}))
    assert validate.state_errors(fixture({'digitalocean-ssh-sources': []}))
    assert not any('DO_TOKEN' in error for error in validate.secret_errors(fixture({'blue/event': 'create'})))
