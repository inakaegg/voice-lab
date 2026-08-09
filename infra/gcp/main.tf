# Google Cloud側のIaC正本。stateはローカル（git管理外）。
# 認証は gcloud のaccess token（GOOGLE_OAUTH_ACCESS_TOKEN）。
# 取得方法は docs/deployment/ARCHITECTURE.md を参照。

terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

provider "google" {
  project = local.project
  region  = local.region
}

locals {
  project = "mo-speech-501706"
  region  = "us-central1"
}

data "google_project" "current" {
  project_id = local.project
}
