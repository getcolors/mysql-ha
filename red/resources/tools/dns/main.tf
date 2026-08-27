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
  filter = { name = "<{ cloudflare-zone }>" }
}

locals {
  node_records = <{ node-records-json|safe }>
}

# The client endpoint. Its content is the reserved IP and never changes: a
# failover moves the address between droplets, not the record between
# addresses, so this record is stable desired state rather than something the
# cluster rewrites behind OpenTofu's back.
resource "cloudflare_dns_record" "cluster" {
  zone_id = data.cloudflare_zone.zone.id
  name    = "<{ cluster-record }>"
  content = "<{ reserved_ip }>"
  type    = "A"
  ttl     = 60
  proxied = <{ cloudflare-proxied }>
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
  proxied = <{ cloudflare-proxied }>
}

output "cluster_record" {
  value = cloudflare_dns_record.cluster.name
}
output "cluster_endpoint" {
  value = cloudflare_dns_record.cluster.content
}
