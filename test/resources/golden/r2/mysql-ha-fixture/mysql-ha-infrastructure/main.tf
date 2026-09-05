terraform {
  required_version = ">= 1.8.0"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "2.51.0"
    }
  }
}

provider "digitalocean" {}

locals {
  name           = "fixture"
  ssh_sources    = ["203.0.113.7/32"]
  client_sources = ["203.0.113.7/32"]
}

# The VPC is discovered, never owned. Given only a region, this data source
# returns that region's default VPC, so there is no VPC UUID, no VPC CIDR and
# no VPC resource anywhere in desired state.
data "digitalocean_vpc" "cluster" {
  region = "ams3"
}

# Keygen mode (workspace standards/ssh-keypair.md): the account key is named
# after the profile and lives in this stack's state, which is what makes its
# ownership decidable. One key for the cluster, not one per member — the
# deployment is one thing, and a key per machine would multiply what the
# standard exists to make singular. Never reference a literal key id here in
# keygen mode.
resource "digitalocean_ssh_key" "machine" {
  name       = "mysql-ha-fixture"
  public_key = trimspace(file("/home/build-placeholder/.ssh/mysql-ha-fixture.pub"))
}

# Three homogeneous members. They are identical by construction: which one is
# primary is decided by the group at run time, not here.
resource "digitalocean_droplet" "node" {
  count    = 3
  name     = "${local.name}-node-${count.index + 1}"
  region   = "ams3"
  size     = "s-2vcpu-4gb"
  image    = "ubuntu-24-04-x64"
  vpc_uuid = data.digitalocean_vpc.cluster.id
  ssh_keys = [digitalocean_ssh_key.machine.id]
  tags     = ["colors-mysql-ha", local.name]

  lifecycle {
    prevent_destroy = true
  }
}

# The client endpoint, deliberately created with no droplet_id.
#
# Assignment is not desired state: the member that is currently PRIMARY claims
# this address through the DigitalOcean API, and OpenTofu must never plan a
# change against that. Owning `droplet_id` here would make every `create` after
# a failover silently move the endpoint back to the old primary.
resource "digitalocean_reserved_ip" "endpoint" {
  region = "ams3"

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [droplet_id]
  }
}

# Public ingress is SSH from the operator and the MySQL port from configured
# clients. The group replication port is reachable only inside the VPC, which
# is also what group_replication_ip_allowlist is set to.
resource "digitalocean_firewall" "cluster" {
  name        = "${local.name}-cluster"
  droplet_ids = digitalocean_droplet.node[*].id

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.ssh_sources
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "3306"
    source_addresses = local.client_sources
  }
  inbound_rule {
    protocol         = "icmp"
    source_addresses = concat(local.ssh_sources, [data.digitalocean_vpc.cluster.ip_range])
  }
  inbound_rule {
    protocol         = "tcp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }
  inbound_rule {
    protocol         = "udp"
    port_range       = "1-65535"
    source_addresses = [data.digitalocean_vpc.cluster.ip_range]
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

output "node_public_ips" {
  value = digitalocean_droplet.node[*].ipv4_address
}
output "node_private_ips" {
  value = digitalocean_droplet.node[*].ipv4_address_private
}
output "node_droplet_ids" {
  value = digitalocean_droplet.node[*].id
}
output "reserved_ip" {
  value = digitalocean_reserved_ip.endpoint.ip_address
}
output "vpc_id" {
  value = data.digitalocean_vpc.cluster.id
}
output "vpc_ip_range" {
  value = data.digitalocean_vpc.cluster.ip_range
}

# The Compute Cluster Standard's `params`: the one output every later stage
# reads. The outputs above stay so no state output disappears; after adoption
# nothing reads them but the legacy translation.
output "params" {
  value = {
    provider     = "digitalocean"
    ssh_key_id   = digitalocean_ssh_key.machine.id
    reserved_ip  = digitalocean_reserved_ip.endpoint.ip_address
    vpc_id       = data.digitalocean_vpc.cluster.id
    vpc_ip_range = data.digitalocean_vpc.cluster.ip_range
    nodes = [for i, d in digitalocean_droplet.node : {
      index      = i
      role       = null
      name       = d.name
      ip         = d.ipv4_address
      vpc_ip     = d.ipv4_address_private
      droplet_id = d.id
      user       = "root"
      sudoer     = "root"
    }]
  }
}
