import * as path from 'path';
import { getLogFiles, readLog } from '../core/logger';
import { printHeader, printSection, printSuccess, printTable } from '../utils/display';
import chalk from 'chalk';

export async function logCommand(options: { limit?: number; command?: string; detail?: boolean }): Promise<void> {
  printHeader('DICOM Log');

  const logFiles = getLogFiles();

  if (logFiles.length === 0) {
    printSuccess('No log entries found');
    return;
  }

  let entries = logFiles.map(f => readLog(f));

  if (options.command) {
    entries = entries.filter(e => e.command === options.command);
  }

  const limit = options.limit ?? 10;
  entries = entries.slice(0, limit);

  if (entries.length === 0) {
    printSuccess('No matching log entries found');
    return;
  }

  if (options.detail) {
    for (const entry of entries) {
      const result = entry.result;
      printSection(`${result.timestamp} - ${entry.command}`);
      console.log(`  ${chalk.bold('Command:')}        ${entry.command}`);
      console.log(`  ${chalk.bold('Timestamp:')}      ${result.timestamp}`);
      console.log(`  ${chalk.bold('Total Processed:')} ${result.totalProcessed}`);
      console.log(`  ${chalk.bold('Success Count:')}  ${chalk.green(String(result.successCount))}`);
      console.log(`  ${chalk.bold('Fail Count:')}     ${chalk.red(String(result.failCount))}`);
      console.log(`  ${chalk.bold('Duration:')}       ${result.duration}ms`);
      console.log(`  ${chalk.bold('Status:')}         ${result.success ? chalk.green('Success') : chalk.red('Failed')}`);

      if (result.failures && result.failures.length > 0) {
        console.log(chalk.bold.red('\n  Failures:'));
        for (const failure of result.failures) {
          console.log(`    ${chalk.red('✗')} ${failure.filePath}`);
          console.log(`      ${chalk.gray(failure.error)}`);
        }
      }
      console.log();
    }
  } else {
    const headers = ['Timestamp', 'Command', 'Success', 'Fail', 'Duration'];
    const rows = entries.map(entry => {
      const result = entry.result;
      return [
        result.timestamp.replace('T', ' ').substring(0, 19),
        entry.command,
        String(result.successCount),
        String(result.failCount),
        `${result.duration}ms`,
      ];
    });

    printTable(headers, rows);
  }

  printSuccess(`Showing ${entries.length} log entry/entries`);
}
