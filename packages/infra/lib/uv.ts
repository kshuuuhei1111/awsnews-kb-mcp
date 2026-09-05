import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * uv workspace の指定パッケージのランタイム依存関係を requirements.txt として書き出す。
 *
 * `aws-lambda-python-alpha` の `PythonFunction` は entry ディレクトリに requirements.txt が
 * あれば Docker バンドリングで pip install する。uv workspace ではロックファイルがリポジトリ
 * ルートに1つだけ存在し、各 Lambda ディレクトリには存在しないため、ここで `uv export` の
 * 結果を該当 Lambda ディレクトリに書き出してから PythonFunction に渡す
 * (docs/adr/0002-lambda-dependency-management.md 参照)。
 *
 * dev dependency group (pytest 等) は除外し、workspace メンバー自身への editable install
 * 行 (`-e ./...`) も取り除く。依存が無い Lambda では requirements.txt を生成せず、
 * PythonFunction が Docker を使わない軽量バンドリングにフォールバックできるようにする。
 */
export function exportLambdaRequirements(packageName: string, entryDir: string): void {
  const output = execFileSync(
    'uv',
    [
      'export',
      '--package',
      packageName,
      '--no-dev',
      '--no-hashes',
      '--no-header',
      '--no-annotate',
    ],
    { cwd: REPO_ROOT, encoding: 'utf-8' },
  );

  const filtered = output
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.startsWith('-e '))
    .join('\n');

  const requirementsPath = path.join(entryDir, 'requirements.txt');
  if (filtered.length === 0) {
    if (fs.existsSync(requirementsPath)) {
      fs.unlinkSync(requirementsPath);
    }
    return;
  }
  fs.writeFileSync(requirementsPath, filtered + '\n');
}
