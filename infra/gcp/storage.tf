# Zoovoiceのbuild資材（ASRモデルと動物音源セット）の正本を置くbucket。
# 音源には再配布が禁止された素材を含むため、publicにしない。
# 資材の配置と復旧の方針は docs/deployment/MODEL_STORAGE.md を正とする。

resource "google_storage_bucket" "zoovoice_artifacts" {
  name          = "${local.project}-zoovoice-artifacts"
  location      = upper(local.region)
  storage_class = "STANDARD"

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # objectのpathへ内容hashを含め、上書きしない運用にするが、
  # 運用ミスの余地は仕組みでも塞ぐ。
  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800
  }
}
