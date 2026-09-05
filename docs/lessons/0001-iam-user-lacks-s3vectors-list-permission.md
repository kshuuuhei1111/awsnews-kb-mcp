# IAM ユーザーに s3vectors:ListVectorBuckets 権限がない

- 発生フェーズ: Phase 1（KnowledgeBaseStack デプロイ後の動作確認）

## 事象

デプロイ確認のため CLI ユーザー（`agentcore-handson`）で
`aws s3vectors list-vector-buckets` を実行すると
`AccessDeniedException: ... is not authorized to perform: s3vectors:ListVectorBuckets`
となる。

## 原因

S3 Vectors バケット・インデックスは Bedrock Knowledge Base の実行ロール（CDK が自動生成する
`KnowledgeBaseRole`）からのみアクセスされる設計になっており、ハンズオン用 IAM ユーザー
自体には `s3vectors:*` の権限を付与していなかった。

## 対処・回避策

- KB 自体の動作確認は `aws bedrock-agent get-knowledge-base` /
  `get-data-source` で `status: ACTIVE` / `AVAILABLE` を見れば十分で、
  S3 Vectors バケットへの直接アクセスは必須ではない
- CLI から S3 Vectors リソースを直接確認したい場合は、IAM ユーザーに
  `s3vectors:ListVectorBuckets` / `s3vectors:GetVectorBucket` 等の読み取り権限を
  一時的に付与する（本番運用では不要な権限は付与しないこと）

## 影響

- README のトラブルシュートに、KB 動作確認は `bedrock-agent` API で行う旨を記載する
