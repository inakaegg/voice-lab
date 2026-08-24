# Cloudflare側のIaC正本。stateはローカル（git管理外）。
# 認証は環境変数 CLOUDFLARE_API_TOKEN。取得方法は infra/README.md を参照。

terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

locals {
  account_id = "d206f9d1c1bf98daaa408b9eccc8bc14"
}
