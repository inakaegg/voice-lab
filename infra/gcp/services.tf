# Zoovoiceが必要とするAPIだけを管理する。他のAPIの有効・無効へ干渉しない。

locals {
  enabled_apis = [
    "artifactregistry.googleapis.com",
    "iamcredentials.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "storage.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.enabled_apis)

  service            = each.value
  disable_on_destroy = false
}
