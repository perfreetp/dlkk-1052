import * as path from 'path';
import chalk from 'chalk';
import { getLogFiles, readLog, getBatchLogFiles, getBatchStepLogs, findBatchById } from '../core/logger';
import { printHeader, printSection, printSuccess, printError, printTable } from '../utils/display';

export async function logCommand(options: { limit?: number; command?: string; detail?: boolean; batchId?: string }): Promise<void> {
  if (options.batchId) {
    const batch = findBatchById(options.batchId);

    if (!batch) {
      printError(`Batch not found: ${options.batchId}`);
      return;
    }

    const br = batch.batchResult;
    printHeader(`BATCH: ${chalk.yellow(br.batchId)}`);
    console.log(`  ${chalk.bold('Name:')}       ${br.name}`);
    console.log(`  ${chalk.bold('Input Dir:')}  ${br.inputDir}`);
    console.log(`  ${chalk.bold('Timestamp:')}  ${br.timestamp}`);
    console.log(`  ${chalk.bold('Duration:')}   ${br.duration}ms`);
    console.log(`  ${chalk.bold('Status:')}     ${br.overallSuccess ? chalk.green('SUCCESS') : chalk.red('FAILED')}`);

    if (options.detail) {
      for (const step of br.steps) {
        const statusIcon = step.success ? chalk.green('✅') : chalk.red('❌');
        printSection(`Step ${step.stepIndex}: ${step.name} ${statusIcon}`);

        if (step.result) {
          const r = step.result;
          console.log(`  ${chalk.bold('Success:')} ${chalk.green(String(r.successCount))}`);
          console.log(`  ${chalk.bold('Fail:')}    ${chalk.red(String(r.failCount))}`);

          if (r.failures && r.failures.length > 0) {
            console.log(chalk.bold.red('\n  Failures:'));
            for (const failure of r.failures) {
              console.log(`    ${chalk.red('✗')} ${failure.filePath}`);
              console.log(`      ${chalk.gray(failure.error)}`);
            }
          }
        } else if (step.error) {
          console.log(`  ${chalk.bold.red('Error:')} ${step.error}`);
        }
      }
    } else {
      const headers = ['StepIndex', 'Name', 'Status', 'SuccessCount', 'FailCount', 'Duration'];
      const rows = br.steps.map((step: any) => {
        const status = step.success ? chalk.green('✅') : chalk.red('❌');
        const successCount = step.result ? String(step.result.successCount) : '0';
        const failCount = step.result ? String(step.result.failCount) : '0';
        let duration = '0ms';
        if (step.startedAt && step.finishedAt) {
          duration = `${new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()}ms`;
        }
        return [String(step.stepIndex), step.name, status, successCount, failCount, duration];
      });
      printTable(headers, rows);
    }

    console.log();
    if (br.overallSuccess) {
      printSuccess(`Batch ${chalk.yellow(br.batchId)} completed successfully`);
    } else {
      printError(`Batch ${chalk.yellow(br.batchId)} failed`);
    }
    return;
  }

  printHeader('DICOM Log');

  let logFiles = getLogFiles().filter(f => !path.basename(f).startsWith('BATCH_'));

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
      const titleParts = [result.timestamp, entry.command];
      if (result.batchId) {
        titleParts.push(chalk.yellow(`[${result.batchId}]`));
      }
      printSection(titleParts.join(' - '));
      console.log(`  ${chalk.bold('Command:')}        ${entry.command}`);
      console.log(`  ${chalk.bold('Timestamp:')}      ${result.timestamp}`);
      if (result.batchId) {
        console.log(`  ${chalk.bold('BatchId:')}        ${chalk.yellow(result.batchId)}`);
      }
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
    const headers = ['Timestamp', 'Command', 'BatchId', 'Success', 'Fail', 'Duration'];
    const rows = entries.map(entry => {
      const result = entry.result;
      return [
        result.timestamp.replace('T', ' ').substring(0, 19),
        entry.command,
        result.batchId ? chalk.yellow(result.batchId) : '',
        chalk.green(String(result.successCount)),
        chalk.red(String(result.failCount)),
        `${result.duration}ms`,
      ];
    });

    printTable(headers, rows);
  }

  printSuccess(`Showing ${entries.length} log entry/entries`);
}
