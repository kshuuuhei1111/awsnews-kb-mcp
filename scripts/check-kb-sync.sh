#!/usr/bin/env bash
# S3記事バケット → Bedrock Knowledge Base → S3 Vectors の取り込み状況を追跡する。
#
# 使い方:
#   scripts/check-kb-sync.sh                       # 直近のIngestion Job履歴 + ステータス別件数
#   scripts/check-kb-sync.sh <S3キーの一部/URL断片>  # 特定記事がINDEXED済みか調べる
#
# KnowledgeBaseStackのCfnOutput（KnowledgeBaseId / DataSourceId）から対象を自動解決する。
set -euo pipefail

STACK_NAME="${KB_STACK_NAME:-KnowledgeBaseStack}"
JOB_HISTORY_LIMIT="${JOB_HISTORY_LIMIT:-5}"

outputs=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' --output json)

kb_id=$(echo "${outputs}" | jq -r '.[] | select(.OutputKey=="KnowledgeBaseId") | .OutputValue')
ds_id=$(echo "${outputs}" | jq -r '.[] | select(.OutputKey=="DataSourceId") | .OutputValue')

if [[ -z "${kb_id}" || -z "${ds_id}" ]]; then
  echo "KnowledgeBaseId / DataSourceId が ${STACK_NAME} の出力から取得できませんでした" >&2
  exit 1
fi

echo "KnowledgeBaseId: ${kb_id}"
echo "DataSourceId:    ${ds_id}"
echo

if [[ $# -ge 1 ]]; then
  # --- 特定記事の追跡: S3キー/URLの一部から該当ドキュメントのINDEXEDステータスを探す ---
  needle="$1"
  echo "--- '${needle}' を含むドキュメントのステータス ---"
  aws bedrock-agent list-knowledge-base-documents \
    --knowledge-base-id "${kb_id}" --data-source-id "${ds_id}" \
    --query 'documentDetails[].{uri:identifier.s3.uri,status:status,updatedAt:updatedAt,reason:statusReason}' \
    --output json \
  | jq --arg needle "${needle}" '[.[] | select(.uri | contains($needle))]'
  exit 0
fi

# --- 全体サマリ: Ingestion Job履歴とドキュメントのステータス別件数 ---
echo "--- 直近${JOB_HISTORY_LIMIT}件のIngestion Job ---"
aws bedrock-agent list-ingestion-jobs \
  --knowledge-base-id "${kb_id}" --data-source-id "${ds_id}" \
  --max-results "${JOB_HISTORY_LIMIT}" \
  --query 'ingestionJobSummaries[].{id:ingestionJobId,status:status,startedAt:startedAt,scanned:statistics.numberOfDocumentsScanned,indexed:statistics.numberOfNewDocumentsIndexed,modified:statistics.numberOfModifiedDocumentsIndexed,failed:statistics.numberOfDocumentsFailed}' \
  --output table

echo
echo "--- ドキュメントのステータス別件数（S3 Vectorsへの登録完了 = INDEXED） ---"
aws bedrock-agent list-knowledge-base-documents \
  --knowledge-base-id "${kb_id}" --data-source-id "${ds_id}" \
  --query 'documentDetails[].status' --output json \
| jq -r 'group_by(.) | map({status: .[0], count: length}) | .[] | "\(.status)\t\(.count)"'

echo
echo "特定記事を追跡するには: scripts/check-kb-sync.sh <S3キーの一部 例: aurora-dsql>"
