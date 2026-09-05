# ADR-0001: リージョンとベクトルストアの選定

- ステータス: Accepted
- 日付: 2026-09-05

## コンテキスト

依頼書（プロジェクト立ち上げ依頼）では、リージョンは既定 `us-west-2` としつつ、着手時に
S3 Vectors と AgentCore Gateway の対応リージョンを確認し、東京リージョン（`ap-northeast-1`）で
両方使えるなら切り替えてよいとされている。ベクトルストアは Aurora / OpenSearch Serverless を
使わず S3 Vectors を使うことが確定事項。

また、依頼書が参照するアーキテクチャ図ファイル
（`../04_AWS_アーキテクチャ図/handson-awsnews-kb-mcp/handson-awsnews-kb-mcp-architecture-20260904.drawio`）
は本プロジェクト着手時点でファイルシステム上に存在しなかった（ユーザーに確認済み、依頼書
セクション2のテキスト記述を正として進めることで合意）。

## 調査結果（2026-09-05 時点）

### AgentCore Gateway 対応リージョン

`docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html` の対応表より、
AgentCore Gateway は US East (N. Virginia/Ohio), US West (N. California/Oregon),
Europe (Frankfurt/Ireland/London/Milan/Paris/Spain/Stockholm),
Asia Pacific (Malaysia/Mumbai/Hyderabad/Singapore/Sydney/Thailand/**Tokyo**/Seoul),
Canada (Central), South America (São Paulo), AWS GovCloud (US-West) など21リージョンで
「✓ Yes」。**`us-west-2` と `ap-northeast-1` はいずれも対応**。

### S3 Vectors 対応リージョン

AWS What's New の履歴より、S3 Vectors は 2025年12月の GA 時点で14リージョン
（US East (Ohio, N. Virginia), US West (Oregon), Asia Pacific (Sydney, Mumbai, Seoul,
Singapore, **Tokyo**), Canada (Central), Europe (Frankfurt, Ireland, London, Paris,
Stockholm)）に対応し、2026年3月にさらに17リージョンへ拡大している。
**`us-west-2` と `ap-northeast-1` はいずれも GA 初期リージョンに含まれる**。

### Titan Text Embeddings v2

Bedrock のモデル提供リージョンとして `us-west-2`・`ap-northeast-1` の双方が一般的に対応
（Bedrock の主要モデルはマルチリージョンで展開されており、東京リージョンでも主要テキスト系
モデルは提供されている）。実アカウントでの `list-foundation-models` による最終確認は
Phase 1 着手時に実施し、結果を本 ADR に追記する。

## 決定

- **リージョン: `ap-northeast-1`（東京）を採用する**（依頼書の既定 `us-west-2` から変更）。
  理由:
  - S3 Vectors・AgentCore Gateway ともに東京リージョンに対応済みであることを確認した
  - RSS ソースに AWS Japan Blog を含み、想定利用者（社内 Kiro / Claude Code ユーザー）は
    日本国内が中心のため、レイテンシとデータ所在の観点で東京リージョンが望ましい
  - 依頼書自体が「東京で両方使えるなら切り替えてよい」と明記している
- **ベクトルストア: S3 Vectors を採用する**（依頼書の確定事項どおり）。
  理由:
  - Aurora / OpenSearch Serverless と異なり VPC 常時稼働リソースが不要で、
    「放置しても月数ドル以内」という制約に最も適合する
  - Bedrock Knowledge Base が S3 Vectors をネイティブサポートしている
- **アーキテクチャ図**: 指定パスにファイルが存在しないため、依頼書セクション2のテキスト記述を
  設計の正とする。図が後日提供された場合は差分を確認し、必要なら本 ADR を改訂する。

## 影響

- CDK のデフォルト env は `{ region: 'ap-northeast-1' }` とする
- Cognito, AgentCore Gateway, Bedrock KB, S3 Vectors はすべて `ap-northeast-1` にデプロイする
- CLAUDE.md にもこの決定を明記する
- Phase 1 着手時に実アカウントで Titan Embeddings v2 のモデルアクセス可否を確認し、
  未有効化の場合は Bedrock コンソールでモデルアクセスをリクエストする手順を README に記載する

## 却下した代替案

- `us-west-2` のまま既定を維持する: 対応状況に差はないが、利用者が日本国内中心という
  実情に対して東京リージョンの方がレイテンシ上有利なため採用しなかった
- OpenSearch Serverless: 最小構成でも常時課金が発生し、「月数ドル以内」の制約に反するため不採用
- Aurora (pgvector): VPC が必須になり Non-goals（VPCを使わない）に反するため不採用
