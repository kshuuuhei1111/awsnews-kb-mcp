#!/usr/bin/env bash
# 取り込み済み記事の .metadata.json に published_at_epoch / lang を追記し、KBを再同期する。
#
# 使い方:
#   scripts/backfill-metadata.sh            # ドライラン（変更対象の件数と差分例を表示するだけ）
#   scripts/backfill-metadata.sh --apply    # S3に書き戻し、StartIngestionJob を1回実行する
#
# S3イベント通知は `.md` のみが対象のため、.metadata.json の更新では取り込みが自動起動しない。
# そのため --apply 時は最後に StartIngestionJob を明示的に呼ぶ。
set -euo pipefail

STACK_NAME="${KB_STACK_NAME:-KnowledgeBaseStack}"
apply=false
[[ "${1:-}" == "--apply" ]] && apply=true

outputs=$(aws cloudformation describe-stacks --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs' --output json)
bucket=$(echo "${outputs}" | jq -r '.[] | select(.OutputKey=="ArticlesBucketName") | .OutputValue')
kb_id=$(echo "${outputs}" | jq -r '.[] | select(.OutputKey=="KnowledgeBaseId") | .OutputValue')
ds_id=$(echo "${outputs}" | jq -r '.[] | select(.OutputKey=="DataSourceId") | .OutputValue')

work_dir=$(mktemp -d)
trap 'rm -rf "${work_dir}"' EXIT

aws s3 sync "s3://${bucket}/news/" "${work_dir}/news/" \
  --exclude '*' --include '*.metadata.json' --quiet

changed=0
while IFS= read -r -d '' file; do
  if jq -e '.metadataAttributes | has("published_at_epoch") and has("lang")' "${file}" >/dev/null; then
    continue
  fi
  # published_at は Fetch Lambda が UTC の "+00:00" 付き ISO8601 で書き出している。
  jq -c '.metadataAttributes |= (
      .published_at_epoch = (.published_at | sub("\\+00:00$"; "Z") | fromdateiso8601)
      | .lang = (if .source == "jp-blog" then "ja" else "en" end)
    )' "${file}" > "${file}.new"
  if [[ ${changed} -eq 0 ]]; then
    echo "--- 変更例: ${file#"${work_dir}/"}"
    jq -c '.metadataAttributes | {published_at, published_at_epoch, source, lang}' "${file}.new"
  fi
  mv "${file}.new" "${file}"
  changed=$((changed + 1))
done < <(find "${work_dir}/news" -name '*.metadata.json' -print0)

echo "変更対象: ${changed} 件"

if ! ${apply}; then
  echo "ドライランのため書き戻していません。反映するには --apply を付けて再実行してください"
  exit 0
fi

# 1件ずつ aws s3 cp すると CLI の起動だけで数百件×約1秒かかるため、まとめて sync する。
# 項目を追記したファイルはサイズが変わるので、sync で変更分だけがアップロードされる。
if [[ ${changed} -gt 0 ]]; then
  aws s3 sync "${work_dir}/news/" "s3://${bucket}/news/" \
    --exclude '*' --include '*.metadata.json' \
    --content-type application/json --only-show-errors
fi

if [[ ${changed} -gt 0 ]]; then
  aws bedrock-agent start-ingestion-job --knowledge-base-id "${kb_id}" --data-source-id "${ds_id}" \
    --query 'ingestionJob.{id:ingestionJobId,status:status}' --output table
  echo "取り込み状況は scripts/check-kb-sync.sh で確認できます"
fi
