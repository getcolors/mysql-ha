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
  name           = "<{ digitalocean-name }>"
  ssh_sources    = <{ digitalocean-ssh-sources-json|safe }>
  client_sources = <{ digitalocean-client-sources-json|safe }>
}

# The VPC is discovered, never owned. Given only a region, this data source
# returns that region's default VPC, so there is no VPC UUID, no VPC CIDR and
# no VPC resource anywhere in desired state.
data "digitalocean_vpc" "cluster" {
  region = "<{ digitalocean-region }>"
}

# Three homogeneous members. They are identical by construction: which one is
# primary is decided by the group at run time, not here.
resource "digitalocean_droplet" "node" {
  count    = <{ node-count }>
  name     = "${local.name}-node-${count.index + 1}"
  region   = "<{ digitalocean-region }>"
  size     = "<{ digitalocean-size }>"
  image    = "<{ digitalocean-image }>"
  vpc_uuid = data.digitalocean_vpc.cluster.id
  ssh_keys = ["<{ digitalocean-ssh-keys }>"]
  tags     = ["colors-mysql-ha", local.name]

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
  }
}

# The client endpoint, deliberately created with no droplet_id.
#
# Assignment is not desired state: the member that is currently PRIMARY claims
# this address through the DigitalOcean API, and OpenTofu must never plan a
# change against that. Owning `droplet_id` here would make every `create` after
# a failover silently move the endpoint back to the old primary.
resource "digitalocean_reserved_ip" "endpoint" {
  region = "<{ digitalocean-region }>"

  lifecycle {
    prevent_destroy = <{ compute-prevent-destroy }>
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
    port_range       = "<{ mysql-port }>"
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
    prevent_destroy = <{ compute-prevent-destroy }>
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
