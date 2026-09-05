# ADR-0002: Lambda の依存管理方式

- ステータス: Accepted
- 日付: 2026-09-05

## コンテキスト

依頼書は Lambda のパッケージ管理を uv（workspace）とし、ビルドは Hatchling、lint/format は
ruff、テストは pytest とすることを確定事項としつつ、CDK 側での実際の Lambda 依存の持ち込み方
（`PythonFunction` か、uv でエクスポートした requirements を使うか）は「最初に決めて CLAUDE.md
に書く」ことを求めている。

## 決定

**`aws-cdk/aws-lambda-python-alpha` の `PythonFunction` + `uv export` の組み合わせを採用する。**

- 各 Lambda パッケージ（`packages/ingestion/*`, `packages/tools/*`)は uv workspace のメンバーと
  してローカル開発・テストを行う（`uv sync`, `uv run pytest`, `uv run ruff check`）
- CDK の `PythonFunction` の `bundling` フックで、デプロイ時に
  `uv export --no-hashes --no-dev -o requirements.txt` を実行してから Docker 上で
  `pip install -r requirements.txt` させる。Docker バンドリングにより Lambda 実行環境
  （Amazon Linux, Python 3.13）とのバイナリ互換性を保証する
- ローカルの `uv.lock` を単一の依存解決の真実源とし、requirements.txt は都度生成する
  生成物（リポジトリにはコミットしない）として扱う

## 根拠

- 依頼書の「既存社内リポジトリの流儀」に沿い、uv による高速な依存解決とロックファイル管理を
  維持しつつ、CDK の実績あるバンドリング機構（`PythonFunction`）を使うことで、
  Lambda 特有のクロスプラットフォームビルド問題（C 拡張など）を CDK 側の Docker バンドリングに
  任せられる
- 依存が少ない Lambda（stdlib + boto3 中心）であっても、将来 feedparser や markdownify 等の
  純 Python パッケージが増えた場合に自前 bundling コードを書き直す必要がない

## 却下した代替案

- uv export した requirements.txt を `lambda.Code.fromAsset` の bundling オプションで
  直接 pip install する自前実装: `PythonFunction` が同等のことを提供しており、車輪の再発明に
  なるため不採用
- Lambda Layer に共通依存をまとめる: ツール数が少なく（2〜3 Lambda）、依頼書の
  「1〜2日で構築」というハンズオン規模に対して複雑さが見合わないため見送り
  （依存が増え共通化のメリットが出た場合に再検討する）

## 影響

- `packages/ingestion/` と `packages/tools/` はそれぞれ `pyproject.toml` を持つ uv workspace
  メンバーとする
- CDK スタック（`packages/infra`）から `aws-cdk/aws-lambda-python-alpha` を依存に追加する
- CI/ローカル双方で `uv export` が実行できるよう、uv のインストールを前提条件として
  README に明記する
