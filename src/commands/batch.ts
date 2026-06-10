import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { ProcessResult, BatchResult, BatchStepResult, BatchStepConfig, BatchConfig, UndoRecord, ScanResult } from '../core/types';
import { writeLog, writeBatchLog, saveUndoRecord, ensureBackupDir, listUndoRecords, ensureUndoDir } from '../core/logger';
import { scanCommand } from './scan';
import { validateCommand } from './validate';
import { anonymizeCommand } from './anonymize';
import { renameCommand } from './rename';
import { previewCommand } from './preview';
import { exportCommand } from './export';
import { printHeader, printSection, printSuccess, printError, printWarning, printReport, printTable, createSpinner } from '../utils/display';

export async function batchCommand(
  configFile: string,
  options: { dryRun?: boolean; continueOnFailure?: boolean }
): Promise<BatchResult> {
  const startTime = Date.now();
  const batchId = crypto.randomUUID().substring(0, 8);
  const timestamp = new Date().toISOString();

  printHeader('DICOM Batch Pipeline');
  printSection(`Loading batch config: ${configFile}`);

  const resolvedConfigPath = path.resolve(configFile);
  if (!fs.existsSync(resolvedConfigPath)) {
    printError(`Config file not found: ${resolvedConfigPath}`);
    const failedResult: BatchResult = {
      batchId,
      name: 'unknown',
      timestamp,
      inputDir: '',
      totalSteps: 0,
      completedSteps: 0,
      failedAtStep: 0,
      overallSuccess: false,
      steps: [],
      duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  let config: BatchConfig;
  try {
    config = fs.readJsonSync(resolvedConfigPath) as BatchConfig;
  } catch (err: any) {
    printError(`Failed to parse config file: ${err.message || 'Invalid JSON'}`);
    const failedResult: BatchResult = {
      batchId,
      name: 'unknown',
      timestamp,
      inputDir: '',
      totalSteps: 0,
      completedSteps: 0,
      failedAtStep: 0,
      overallSuccess: false,
      steps: [],
      duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  if (!config.inputDir) {
    printError('Config validation failed: inputDir is required');
    const failedResult: BatchResult = {
      batchId,
      name: config.name || 'unknown',
      timestamp,
      inputDir: '',
      totalSteps: 0,
      completedSteps: 0,
      failedAtStep: 0,
      overallSuccess: false,
      steps: [],
      duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  if (!config.steps || !Array.isArray(config.steps)) {
    printError('Config validation failed: steps array is required');
    const failedResult: BatchResult = {
      batchId,
      name: config.name || 'unknown',
      timestamp,
      inputDir: config.inputDir,
      totalSteps: 0,
      completedSteps: 0,
      failedAtStep: 0,
      overallSuccess: false,
      steps: [],
      duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  const enabledSteps = config.steps.filter(s => s.enabled !== false);
  const totalSteps = enabledSteps.length;

  console.log(`  Batch ID       : ${chalk.bold(batchId)}`);
  console.log(`  Batch Name     : ${chalk.bold(config.name || 'Unnamed')}`);
  console.log(`  Input Dir      : ${chalk.bold(config.inputDir)}`);
  console.log(`  Total Steps    : ${chalk.bold(String(totalSteps))}`);
  console.log(`  Continue On Fail: ${chalk.bold(String(config.continueOnFailure ?? options.continueOnFailure ?? false))}`);
  if (options.dryRun) {
    console.log(`  ${chalk.yellow('DRY RUN MODE')}`);
  }
  console.log();

  const existingUndoIds = new Set(listUndoRecords().map(r => r.id));
  const stepResults: BatchStepResult[] = [];
  let failedAtStep: number | null = null;
  let completedSteps = 0;
  const allOperations: UndoRecord['operations'] = [];

  for (let stepIndex = 0; stepIndex < enabledSteps.length; stepIndex++) {
    const step = enabledSteps[stepIndex];
    const stepStartedAt = new Date().toISOString();
    const stepNumber = stepIndex + 1;

    printHeader(`Step ${stepNumber}/${totalSteps}: ${step.name}`);
    const spinner = createSpinner(`Executing ${step.name}...`);
    spinner.start();

    let processResult: ProcessResult;
    const mergedOptions = {
      ...(step.options || {}),
      batchId,
      stepIndex,
      dryRun: options.dryRun,
    };

    try {
      switch (step.name) {
        case 'scan': {
          const scanResult: ScanResult = await scanCommand(config.inputDir, mergedOptions as any);
          processResult = {
            success: scanResult.errors.length === 0 || scanResult.dicomFiles > 0,
            totalProcessed: scanResult.totalFiles,
            successCount: scanResult.dicomFiles,
            failCount: scanResult.invalidFiles,
            failures: scanResult.errors,
            duration: 0,
            timestamp: new Date().toISOString(),
            command: 'scan',
          };
          break;
        }
        case 'validate': {
          const validateStartTime = Date.now();
          await validateCommand(config.inputDir, mergedOptions as any);
          processResult = {
            success: true,
            totalProcessed: 0,
            successCount: 0,
            failCount: 0,
            failures: [],
            duration: Date.now() - validateStartTime,
            timestamp: new Date().toISOString(),
            command: 'validate',
          };
          break;
        }
        case 'anonymize': {
          processResult = await anonymizeCommand(config.inputDir, mergedOptions as any);
          break;
        }
        case 'rename': {
          processResult = await renameCommand(config.inputDir, mergedOptions as any);
          break;
        }
        case 'preview': {
          processResult = await previewCommand(config.inputDir, mergedOptions as any);
          break;
        }
        case 'export': {
          const exportStartTime = Date.now();
          await exportCommand(config.inputDir, mergedOptions as any);
          processResult = {
            success: true,
            totalProcessed: 0,
            successCount: 0,
            failCount: 0,
            failures: [],
            duration: Date.now() - exportStartTime,
            timestamp: new Date().toISOString(),
            command: 'export',
          };
          break;
        }
        default: {
          throw new Error(`Unknown step: ${step.name}`);
        }
      }

      processResult.batchId = batchId;
      processResult.stepIndex = stepIndex;
      processResult.stepName = step.name;

      spinner.stop();

      const stepFinishedAt = new Date().toISOString();

      if (processResult.success) {
        console.log(chalk.green(`  ✅ Step ${stepNumber}/${totalSteps}: ${step.name} - SUCCESS`));
      } else {
        console.log(chalk.red(`  ❌ Step ${stepNumber}/${totalSteps}: ${step.name} - FAILED`));
      }

      writeLog(step.name, processResult);

      const stepResult: BatchStepResult = {
        name: step.name,
        stepIndex,
        startedAt: stepStartedAt,
        finishedAt: stepFinishedAt,
        success: processResult.success,
        result: processResult,
      };
      stepResults.push(stepResult);
      completedSteps++;

      const currentUndoRecords = listUndoRecords();
      for (const record of currentUndoRecords) {
        if (!existingUndoIds.has(record.id)) {
          existingUndoIds.add(record.id);
          for (const op of record.operations) {
            allOperations.push(op);
          }
        }
      }

      const shouldContinue = step.continueOnFailure ?? config.continueOnFailure ?? options.continueOnFailure ?? false;
      if (!processResult.success && !shouldContinue) {
        failedAtStep = stepIndex;
        printError(`Pipeline stopped at step ${stepNumber} (${step.name})`);
        break;
      }
    } catch (err: any) {
      spinner.stop();
      const stepFinishedAt = new Date().toISOString();
      console.log(chalk.red(`  ❌ Step ${stepNumber}/${totalSteps}: ${step.name} - ERROR`));
      printError(err.message || 'Unknown error');

      const errorResult: ProcessResult = {
        success: false,
        totalProcessed: 0,
        successCount: 0,
        failCount: 1,
        failures: [{ filePath: '', error: err.message || 'Unknown error' }],
        duration: 0,
        timestamp: new Date().toISOString(),
        command: step.name,
        batchId,
        stepIndex,
        stepName: step.name,
      };

      writeLog(step.name, errorResult);

      const stepResult: BatchStepResult = {
        name: step.name,
        stepIndex,
        startedAt: stepStartedAt,
        finishedAt: stepFinishedAt,
        success: false,
        result: errorResult,
        error: err.message || 'Unknown error',
      };
      stepResults.push(stepResult);
      completedSteps++;

      failedAtStep = stepIndex;
      const shouldContinue = step.continueOnFailure ?? config.continueOnFailure ?? options.continueOnFailure ?? false;
      if (!shouldContinue) {
        printError(`Pipeline stopped at step ${stepNumber} (${step.name})`);
        break;
      }
    }
  }

  if (allOperations.length > 0) {
    const unifiedUndoRecord: UndoRecord = {
      id: batchId,
      timestamp: new Date().toISOString(),
      command: 'batch',
      batchId,
      operations: allOperations,
    };
    saveUndoRecord(unifiedUndoRecord);
  }

  const overallSuccess = failedAtStep === null;
  const batchResult: BatchResult = {
    batchId,
    name: config.name || 'Unnamed',
    timestamp,
    inputDir: config.inputDir,
    totalSteps,
    completedSteps,
    failedAtStep,
    overallSuccess,
    steps: stepResults,
    duration: Date.now() - startTime,
  };

  writeBatchLog(batchResult);

  printSection('Batch Summary');

  const tableRows = stepResults.map((sr, idx) => {
    const status = sr.success ? chalk.green('SUCCESS') : chalk.red('FAILED');
    const successCount = sr.result ? String(sr.result.successCount) : '0';
    const failCount = sr.result ? String(sr.result.failCount) : '0';
    const duration = sr.result ? `${sr.result.duration}ms` : '0ms';
    return [
      `${idx + 1}`,
      sr.name,
      status,
      successCount,
      failCount,
      duration,
    ];
  });

  printTable(
    ['#', 'Step', 'Status', 'Success', 'Fail', 'Duration'],
    tableRows,
  );

  console.log();
  console.log(`  Total Duration: ${chalk.bold(`${batchResult.duration}ms`)}`);
  console.log(`  Completed: ${chalk.bold(String(completedSteps))}/${chalk.bold(String(totalSteps))}`);

  if (!overallSuccess) {
    const failedStep = stepResults.find(sr => !sr.success);
    if (failedStep) {
      printError(`Batch failed at step ${failedAtStep! + 1}: ${failedStep.name}`);
      if (failedStep.error) {
        printError(`Error: ${failedStep.error}`);
      }
    }
  } else {
    printSuccess('Batch completed successfully!');
  }

  return batchResult;
}
