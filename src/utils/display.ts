import chalk from 'chalk';
import * as cliProgress from 'cli-progress';
import ora from 'ora';

export function createProgressBar(total: number, label: string = 'Processing'): cliProgress.SingleBar {
  const bar = new cliProgress.SingleBar({
    format: `${chalk.cyan(label)} |${chalk.green('{bar}')}| {percentage}% | {value}/{total} files`,
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
  });
  bar.start(total, 0);
  return bar;
}

export function createSpinner(text: string) {
  return ora({ text, spinner: 'dots' });
}

export function printSuccess(message: string): void {
  console.log(chalk.green('✓'), message);
}

export function printError(message: string): void {
  console.log(chalk.red('✗'), message);
}

export function printWarning(message: string): void {
  console.log(chalk.yellow('⚠'), message);
}

export function printInfo(message: string): void {
  console.log(chalk.blue('ℹ'), message);
}

export function printHeader(title: string): void {
  console.log('\n' + chalk.bold.cyan('═'.repeat(50)));
  console.log(chalk.bold.cyan(`  ${title}`));
  console.log(chalk.bold.cyan('═'.repeat(50)) + '\n');
}

export function printSection(title: string): void {
  console.log(chalk.bold.white(`\n▸ ${title}`));
  console.log(chalk.gray('─'.repeat(40)));
}

export function printTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => {
    const maxRowLen = rows.reduce((max, row) => Math.max(max, (row[i] || '').length), 0);
    return Math.max(h.length, maxRowLen);
  });

  const formatRow = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(colWidths[i])).join('  ');

  console.log(chalk.bold(formatRow(headers)));
  console.log(chalk.gray(colWidths.map(w => '─'.repeat(w)).join('──')));
  rows.forEach(row => console.log(formatRow(row)));
}

export function printReport(result: { successCount: number; failCount: number; failures: { filePath: string; error: string }[]; duration: number }): void {
  console.log('\n' + chalk.bold('━━━ 处理报告 ━━━'));
  console.log(`  成功: ${chalk.green(String(result.successCount))}  失败: ${chalk.red(String(result.failCount))}  耗时: ${result.duration}ms`);

  if (result.failures.length > 0) {
    console.log(chalk.bold.red('\n失败列表:'));
    result.failures.forEach(f => {
      console.log(`  ${chalk.red('✗')} ${f.filePath}`);
      console.log(`    ${chalk.gray(f.error)}`);
    });
  }
  console.log();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function formatDicomDate(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return `${dateStr.substring(0, 4)}-${dateStr.substring(4, 6)}-${dateStr.substring(6, 8)}`;
}

export function truncate(str: string, maxLen: number = 40): string {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen - 3) + '...' : str;
}
