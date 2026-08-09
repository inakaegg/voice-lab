// 開発者個人のアカウントは公開リポジトリへ書かず、gitで管理しない terraform.tfvars から渡す。
variable "smoke_invoker_principal" {
  description = "smoke用service accountの短期tokenを取れる開発者のprincipal（例: user:someone@example.com）"
  type        = string
}
