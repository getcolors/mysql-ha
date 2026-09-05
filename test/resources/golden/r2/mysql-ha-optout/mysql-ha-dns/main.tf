terraform {
  required_version = ">= 1.8.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

data "cloudflare_zone" "zone" {
  filter = { name = "fixture.example" }
}

locals {
  node_records = {"node-1.my-ha.fixture.example":"192.0.2.11","node-2.my-ha.fixture.example":"192.0.2.12","node-3.my-ha.fixture.example":"192.0.2.13"}
}

# The client endpoint. Its content is the reserved IP and never changes: a
# failover moves the address between droplets, not the record between
# addresses, so this record is stable desired state rather than something the
# cluster rewrites behind OpenTofu's back.
resource "cloudflare_dns_record" "cluster" {
  zone_id = data.cloudflare_zone.zone.id
  name    = "my-ha.fixture.example"
  content = "192.0.2.10"
  type    = "A"
  ttl     = 60
  proxied = false
}

# Per-member administrative names, so an operator can reach one specific node
# without looking up an address. These never serve clients.
resource "cloudflare_dns_record" "node" {
  for_each = local.node_records

  zone_id = data.cloudflare_zone.zone.id
  name    = each.key
  content = each.value
  type    = "A"
  ttl     = 300
  proxied = false
}

output "cluster_record" {
  value = cloudflare_dns_record.cluster.name
}
output "cluster_endpoint" {
  value = cloudflare_dns_record.cluster.content
}
