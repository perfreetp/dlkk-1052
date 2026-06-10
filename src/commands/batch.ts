import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { ProcessResult, BatchResult, BatchStepResult, BatchStepConfig, BatchConfig, UndoRecord, ScanResult, BatchStatus } from '../core/types';
import { writeLog, writeBatchLog, saveUndoRecord, ensureBackupDir, listUndoRecords, ensureUndoDir, findBatchById, removeUndoRecord } from '../core/logger';
import { scanCommand } from './scan';
import { validateCommand } from './validate';
import { anonymizeCommand } from './anonymize';
import { renameCommand } from './rename';
import { previewCommand } from './preview';
import { exportCommand } from './export';
import { printHeader, printSection, printSuccess, printError, printWarning, printReport, printTable, createSpinner } from '../utils/display';

const DICOM_OUTPUT_STEPS = new Set(['anonymize', 'split', 'filter', 'copy', 'merge', 'rename']);
const AUX_OUTPUT_STEPS = new Set(['preview', 'export']);
const ALL_OUTPUT_STEPS = new Set([...DICOM_OUTPUT_STEPS, ...AUX_OUTPUT_STEPS]);

function resolveStepWorkDir(step: BatchStepConfig, currentWorkDir: string, batchWorkDir: string | null): { inputDir: string; outputDir: string | null; nextWorkDir: string } {
  const stepOpts = step.options || {};
  const inputDir = stepOpts.inputDir || currentWorkDir;
  const outputDir = stepOpts.output || null;
  let nextWorkDir = currentWorkDir;

  if (outputDir && DICOM_OUTPUT_STEPS.has(step.name)) {
    nextWorkDir = outputDir;
  }

  return { inputDir, outputDir, nextWorkDir };
}

export async function batchCommand(
  configFile: string,
  options: { dryRun?: boolean; continueOnFailure?: boolean; resume?: string; fromStep?: number }
): Promise<BatchResult> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  printHeader('DICOM Batch Pipeline');
  printSection(`Loading batch config: ${configFile}`);

  const resolvedConfigPath = path.resolve(configFile);
  if (!fs.existsSync(resolvedConfigPath)) {
    printError(`Config file not found: ${resolvedConfigPath}`);
    const failedResult: BatchResult = {
      batchId: 'unknown', name: 'unknown', timestamp, inputDir: '',
      totalSteps: 0, completedSteps: 0, failedAtStep: 0, overallSuccess: false, status: 'failed', steps: [], duration: Date.now() - startTime,
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
      batchId: 'unknown', name: 'unknown', timestamp, inputDir: '',
      totalSteps: 0, completedSteps: 0, failedAtStep: 0, overallSuccess: false, status: 'failed', steps: [], duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  if (!config.inputDir) {
    printError('Config validation failed: inputDir is required');
    const failedResult: BatchResult = {
      batchId: 'unknown', name: config.name || 'unknown', timestamp, inputDir: '',
      totalSteps: 0, completedSteps: 0, failedAtStep: 0, overallSuccess: false, status: 'failed', steps: [], duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  if (!config.steps || !Array.isArray(config.steps)) {
    printError('Config validation failed: steps array is required');
    const failedResult: BatchResult = {
      batchId: 'unknown', name: config.name || 'unknown', timestamp, inputDir: config.inputDir,
      totalSteps: 0, completedSteps: 0, failedAtStep: 0, overallSuccess: false, status: 'failed', steps: [], duration: Date.now() - startTime,
    };
    writeBatchLog(failedResult);
    return failedResult;
  }

  const enabledSteps = config.steps.filter(s => s.enabled !== false);
  const totalSteps = enabledSteps.length;

  let batchId: string;
  let previousSteps: BatchStepResult[] = [];
  let startStepIndex = 0;
  let existingUndoIds = new Set<string>();

  if (options.resume) {
    batchId = options.resume;
    const existingBatch = findBatchById(batchId);
    if (!existingBatch) {
      printError(`Batch ${batchId} not found. Cannot resume.`);
      const failedResult: BatchResult = {
        batchId, name: config.name || 'unknown', timestamp, inputDir: config.inputDir,
        totalSteps, completedSteps: 0, failedAtStep: 0, overallSuccess: false, status: 'failed', steps: [], duration: Date.now() - startTime,
      };
      writeBatchLog(failedResult);
      return failedResult;
    }

    const existingResult: BatchResult = existingBatch.batchResult;
    previousSteps = existingResult.steps || [];

    if (options.fromStep !== undefined) {
      startStepIndex = Math.max(0, Math.min(options.fromStep, totalSteps - 1));
    } else {
      const failIdx = existingResult.failedAtStep;
      startStepIndex = failIdx !== null ? failIdx : previousSteps.length;
    }

    const keptPrevious = previousSteps.filter(s => s.stepIndex < startStepIndex && s.success);
    previousSteps = keptPrevious;
    existingUndoIds = new Set(listUndoRecords().map(r => r.id));

    printSection(`Resuming batch ${chalk.bold(batchId)} from step ${startStepIndex + 1}`);
    console.log(`  Previous successful steps: ${keptPrevious.length}`);
    console.log(`  Resuming from step: ${startStepIndex + 1} (${enabledSteps[startStepIndex]?.name || 'N/A'})}`);
  } else {
    batchId = crypto.randomUUID().substring(0, 8);
    existingUndoIds = new Set(listUndoRecords().map(r => r.id));
  }

  console.log(`  Batch ID        : ${chalk.bold(batchId)}`);
  console.log(`  Batch Name      : ${chalk.bold(config.name || 'Unnamed')}`);
  console.log(`  Input Dir       : ${chalk.bold(config.inputDir)}`);
  console.log(`  Total Steps     : ${chalk.bold(String(totalSteps))}`);
  console.log(`  Continue On Fail: ${chalk.bold(String(config.continueOnFailure ?? options.continueOnFailure ?? false))}`);
  if (options.dryRun) {
    console.log(`  ${chalk.yellow('DRY RUN MODE')}`);
  }
  console.log();

  let currentWorkDir = path.resolve(config.inputDir);
  for (const prevStep of previousSteps) {
    const prevStepConfig = enabledSteps[prevStep.stepIndex];
    if (prevStepConfig) {
      const resolved = resolveStepWorkDir(prevStepConfig, currentWorkDir, null);
      currentWorkDir = resolved.nextWorkDir;
    }
  }

  const stepResults: BatchStepResult[] = [...previousSteps];
  let failedAtStep: number | null = null;
  let completedSteps = previousSteps.length;
  const allOperations: UndoRecord['operations'] = [];
  const stepUndoRecordIds: string[] = [];

  if (options.resume) {
    const existingBatchUndo = listUndoRecords().find(r => r.id === batchId);
    if (existingBatchUndo) {
      for (const op of existingBatchUndo.operations) {
        allOperations.push(op);
      }
      stepUndoRecordIds.push(existingBatchUndo.id);
    }
  }

  for (const prevRecord of listUndoRecords()) {
    if (!existingUndoIds.has(prevRecord.id)) {
      existingUndoIds.add(prevRecord.id);
      prevRecord.batchId = batchId;
      saveUndoRecord(prevRecord);
      stepUndoRecordIds.push(prevRecord.id);
      for (const op of prevRecord.operations) {
        allOperations.push(op);
      }
    }
  }

  for (let stepIndex = startStepIndex; stepIndex < enabledSteps.length; stepIndex++) {
    const step = enabledSteps[stepIndex];
    const stepStartedAt = new Date().toISOString();
    const stepNumber = stepIndex + 1;
    const { inputDir: stepInputDir, outputDir: stepOutputDir, nextWorkDir } = resolveStepWorkDir(step, currentWorkDir, null);

    printHeader(`Step ${stepNumber}/${totalSteps}: ${step.name}`);
    console.log(`  Input Dir : ${chalk.cyan(stepInputDir)}`);
    if (stepOutputDir) {
      console.log(`  Output Dir: ${chalk.cyan(stepOutputDir)}`);
    }
    const spinner = createSpinner(`Executing ${step.name}...`);
    spinner.start();

    let processResult: ProcessResult;
    const mergedOptions: Record<string, any> = {
      ...(step.options || {}),
      batchId,
      stepIndex,
      dryRun: options.dryRun,
    };

    if (stepOutputDir && ALL_OUTPUT_STEPS.has(step.name)) {
      mergedOptions.output = stepOutputDir;
    }

    try {
      switch (step.name) {
        case 'scan': {
          const scanResult: ScanResult = await scanCommand(stepInputDir, mergedOptions as any);
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
          processResult = await validateCommand(stepInputDir, mergedOptions as any);
          break;
        }
        case 'anonymize': {
          processResult = await anonymizeCommand(stepInputDir, mergedOptions as any);
          break;
        }
        case 'rename': {
          processResult = await renameCommand(stepInputDir, mergedOptions as any);
          break;
        }
        case 'preview': {
          processResult = await previewCommand(stepInputDir, mergedOptions as any);
          break;
        }
        case 'export': {
          processResult = await exportCommand(stepInputDir, mergedOptions as any);
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
        console.log(chalk.green(`  ✅ Step ${stepNumber}/${totalSteps}: ${step.name} - SUCCESS (${processResult.successCount} ok, ${processResult.failCount} fail)`));
      } else {
        console.log(chalk.red(`  ❌ Step ${stepNumber}/${totalSteps}: ${step.name} - FAILED (${processResult.successCount} ok, ${processResult.failCount} fail)`));
      }

      writeLog(step.name, processResult);

      const stepResult: BatchStepResult = {
        name: step.name,
        stepIndex,
        startedAt: stepStartedAt,
        finishedAt: stepFinishedAt,
        success: processResult.success,
        result: processResult,
        workDir: stepInputDir,
        outputDir: stepOutputDir || undefined,
      };
      stepResults.push(stepResult);
      completedSteps++;

      const currentUndoRecords = listUndoRecords();
      for (const record of currentUndoRecords) {
        if (!existingUndoIds.has(record.id)) {
          existingUndoIds.add(record.id);
          record.batchId = batchId;
          saveUndoRecord(record);
          stepUndoRecordIds.push(record.id);
          for (const op of record.operations) {
            allOperations.push(op);
          }
        }
      }

      currentWorkDir = nextWorkDir;

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
        success: false, totalProcessed: 0, successCount: 0, failCount: 1,
        failures: [{ filePath: '', error: err.message || 'Unknown error' }],
        duration: 0, timestamp: new Date().toISOString(), command: step.name,
        batchId, stepIndex, stepName: step.name,
      };

      writeLog(step.name, errorResult);

      const stepResult: BatchStepResult = {
        name: step.name, stepIndex, startedAt: stepStartedAt, finishedAt: stepFinishedAt,
        success: false, result: errorResult, error: err.message || 'Unknown error',
        workDir: stepInputDir, outputDir: stepOutputDir || undefined,
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

  const unifiedUndoRecord: UndoRecord = {
    id: batchId,
    timestamp: new Date().toISOString(),
    command: 'batch',
    batchId,
    operations: allOperations,
  };
  saveUndoRecord(unifiedUndoRecord);

  const allStepsSucceeded = stepResults.every(sr => sr.success);
  const overallSuccess = allStepsSucceeded;
  const hasAnyFailure = stepResults.some(sr => !sr.success);
  let overallStatus: BatchStatus;
  if (allStepsSucceeded) {
    overallStatus = 'success';
  } else if (hasAnyFailure && failedAtStep === null) {
    overallStatus = 'partial';
  } else {
    overallStatus = 'failed';
  }
  const batchResult: BatchResult = {
    batchId,
    name: config.name || 'Unnamed',
    timestamp,
    inputDir: config.inputDir,
    totalSteps,
    completedSteps,
    failedAtStep,
    overallSuccess,
    status: overallStatus,
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
    const workDirCol = sr.workDir ? path.basename(sr.workDir) : '-';
    return [`${idx + 1}`, sr.name, status, successCount, failCount, duration, workDirCol];
  });

  printTable(['#', 'Step', 'Status', 'Success', 'Fail', 'Duration', 'WorkDir'], tableRows);

  console.log();
  console.log(`  Total Duration: ${chalk.bold(`${batchResult.duration}ms`)}`);
  console.log(`  Completed: ${chalk.bold(String(completedSteps))}/${chalk.bold(String(totalSteps))}`);

  if (overallStatus === 'success') {
    printSuccess('Batch completed successfully!');
  } else if (overallStatus === 'partial') {
    const failedSteps = stepResults.filter(sr => !sr.success);
    printWarning(`Batch completed with partial failures (${failedSteps.length} step(s) failed, continue-on-failure applied)`);
    console.log(`  ${chalk.yellow('Tip:')} Resume with: dicom-tools batch ${configFile} --resume ${batchId}`);
  } else {
    const failedStep = stepResults.find(sr => !sr.success);
    if (failedStep) {
      printError(`Batch failed at step ${failedAtStep! + 1}: ${failedStep.name}`);
      if (failedStep.error) {
        printError(`Error: ${failedStep.error}`);
      }
      console.log(`\n  ${chalk.yellow('Tip:')} Resume with: dicom-tools batch ${configFile} --resume ${batchId}`);
    }
  }

  return batchResult;
}
