import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { UndoRecord } from '../core/types';
import { getLatestUndoRecord, removeUndoRecord, listUndoRecords, ensureUndoDir } from '../core/logger';
import { printSuccess, printError, printReport, printHeader, printWarning, printSection, printTable } from '../utils/display';

function findRecordById(id: string): UndoRecord | null {
  const records = listUndoRecords();
  return records.find(r => r.id === id) || null;
}

function getActionDescription(op: UndoRecord['operations'][number]): string {
  switch (op.type) {
    case 'rename':
      return `Rename back to ${path.basename(op.from)}`;
    case 'copy':
      return `Delete copy at ${path.basename(op.to)}`;
    case 'modify':
      return op.backupPath ? 'Restore original from backup' : 'Restore original from backup';
    case 'delete':
      return 'Cannot undo delete';
  }
}

function buildPreviewRows(operations: UndoRecord['operations']): string[][] {
  return operations.map(op => {
    const type = op.type;
    const action = getActionDescription(op);
    const from = op.from;
    const to = op.to;
    if (op.type === 'modify') {
      const backupNote = op.backupPath && fs.existsSync(op.backupPath) ? 'Has backup' : chalk.yellow('⚠ NO backup');
      return [type, `${action} (${backupNote})`, from, to];
    }
    return [type, action, from, to];
  });
}

function promptUser(question: string): Promise<string> {
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    readline.question(question, (answer: string) => {
      readline.close();
      resolve(answer);
    });
  });
}

async function reverseRenamePhase1(
  renameOps: UndoRecord['operations'][number][],
  undoDir: string
): Promise<{ tmpMappings: Map<string, string>; failed: { op: UndoRecord['operations'][number]; error: string }[] }> {
  const tmpDir = path.join(undoDir, 'tmp');
  fs.ensureDirSync(tmpDir);

  const tmpMappings = new Map<string, string>();
  const failed: { op: UndoRecord['operations'][number]; error: string }[] = [];

  for (const op of renameOps) {
    if (!fs.existsSync(op.to)) {
      failed.push({ op, error: `File not found: ${op.to}` });
      continue;
    }
    const tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.tmp`);
    try {
      fs.renameSync(op.to, tmpPath);
      tmpMappings.set(op.to, tmpPath);
    } catch (err: any) {
      failed.push({ op, error: err.message || 'Failed to rename to temp path' });
    }
  }

  return { tmpMappings, failed };
}

async function reverseRenamePhase2(
  renameOps: UndoRecord['operations'][number][],
  tmpMappings: Map<string, string>
): Promise<{ succeeded: UndoRecord['operations'][number][]; failed: { op: UndoRecord['operations'][number]; error: string }[] }> {
  const succeeded: UndoRecord['operations'][number][] = [];
  const failed: { op: UndoRecord['operations'][number]; error: string }[] = [];

  for (const op of renameOps) {
    const tmpPath = tmpMappings.get(op.to);
    if (!tmpPath) {
      failed.push({ op, error: `No temp path mapping found for ${op.to}` });
      continue;
    }
    try {
      const targetDir = path.dirname(op.from);
      fs.ensureDirSync(targetDir);
      fs.renameSync(tmpPath, op.from);
      succeeded.push(op);
    } catch (err: any) {
      failed.push({ op, error: err.message || 'Failed to rename from temp path' });
    }
  }

  return { succeeded, failed };
}

async function performUndo(record: UndoRecord, dryRun: boolean): Promise<void> {
  const headerTitle = record.batchId
    ? `Batch Rollback: ${record.command} (Batch: ${record.batchId})`
    : `Undoing: ${record.command}`;
  printHeader(headerTitle);

  if (record.batchId) {
    printWarning(`This is a batch rollback for batch ${chalk.bold(record.batchId)}`);
  }

  printSection('Operations Preview');
  const previewRows = buildPreviewRows(record.operations);
  printTable(['Type', 'Action', 'From', 'To'], previewRows);

  if (dryRun) {
    printWarning('DRY RUN MODE - No changes will be made');
    return;
  }

  const answer = await promptUser('\nProceed with undo? (y/N): ');
  if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
    printWarning('Undo cancelled by user.');
    return;
  }

  const undoDir = ensureUndoDir();
  let successCount = 0;
  let failCount = 0;
  const failures: { filePath: string; error: string }[] = [];

  const renameOps = record.operations.filter(op => op.type === 'rename');
  const otherOps = record.operations.filter(op => op.type !== 'rename');

  if (renameOps.length > 0) {
    printSection('Processing rename operations (two-phase)');

    const phase1Result = await reverseRenamePhase1(renameOps, undoDir);
    for (const f of phase1Result.failed) {
      failCount++;
      failures.push({ filePath: f.op.to, error: f.error });
      printError(`Phase 1 failed: ${f.op.to} - ${f.error}`);
    }

    const phase1SuccessCount = renameOps.length - phase1Result.failed.length;
    if (phase1SuccessCount > 0) {
      printSuccess(`Phase 1: ${phase1SuccessCount} file(s) moved to temp paths`);
    }

    const phase2Result = await reverseRenamePhase2(renameOps, phase1Result.tmpMappings);
    for (const op of phase2Result.succeeded) {
      successCount++;
      printSuccess(`Renamed back: ${path.basename(op.to)} -> ${path.basename(op.from)}`);
    }
    for (const f of phase2Result.failed) {
      failCount++;
      failures.push({ filePath: f.op.from, error: f.error });
      printError(`Phase 2 failed: ${f.op.from} - ${f.error}`);
    }
  }

  for (const op of otherOps) {
    switch (op.type) {
      case 'copy': {
        if (!fs.existsSync(op.to)) {
          failCount++;
          failures.push({ filePath: op.to, error: `File not found: ${op.to}` });
          printWarning(`Copy target not found: ${op.to}`);
          break;
        }
        try {
          fs.removeSync(op.to);
          successCount++;
          printSuccess(`Removed copy: ${path.basename(op.to)}`);
        } catch (err: any) {
          failCount++;
          failures.push({ filePath: op.to, error: err.message || 'Failed to remove copy' });
          printError(`Failed to remove copy: ${op.to} - ${err.message}`);
        }
        break;
      }
      case 'modify': {
        if (op.backupPath && fs.existsSync(op.backupPath)) {
          try {
            fs.ensureDirSync(path.dirname(op.to));
            fs.copySync(op.backupPath, op.to, { overwrite: true });
            successCount++;
            printSuccess(`Restored original from backup: ${path.basename(op.to)}`);
          } catch (err: any) {
            failCount++;
            failures.push({ filePath: op.to, error: err.message || 'Failed to restore from backup' });
            printError(`Failed to restore: ${op.to} - ${err.message}`);
          }
        } else {
          failCount++;
          failures.push({ filePath: op.to, error: `Backup file not found for: ${op.to}` });
          printWarning(`Backup not found for: ${op.to}`);
        }
        break;
      }
      case 'delete': {
        failCount++;
        failures.push({ filePath: op.from, error: `Cannot undo delete operation for: ${op.from}` });
        printWarning(`Cannot undo delete: ${op.from}`);
        break;
      }
    }
  }

  printSection('Undo Summary');
  printReport({
    successCount,
    failCount,
    failures,
    duration: 0,
  });

  if (failCount === 0) {
    if (record.batchId) {
      const allRecords = listUndoRecords();
      for (const r of allRecords) {
        if (r.batchId === record.batchId && r.id !== record.id) {
          try {
            removeUndoRecord(r.id);
            printSuccess(`Cleaned up step undo record: ${r.id}`);
          } catch {}
        }
      }
    }
    removeUndoRecord(record.id);
    printSuccess(`Undo record ${record.id} removed.`);
  } else {
    printWarning(`Undo record ${record.id} kept due to partial failure.`);
  }
}

export async function undoCommand(options: { list?: boolean; id?: string; dryRun?: boolean }): Promise<void> {
  if (options.list) {
    const records = listUndoRecords();
    if (records.length === 0) {
      printWarning('No undo records found.');
      return;
    }

    printHeader('Undo Records');
    const rows = records.map(r => [
      r.id,
      r.timestamp,
      r.command,
      String(r.operations.length),
      r.batchId ? `Yes (${r.batchId})` : 'No',
    ]);
    printTable(['ID', 'Timestamp', 'Command', 'Operation Count', 'Is Batch'], rows);
    return;
  }

  let record: UndoRecord | null = null;

  if (options.id) {
    record = findRecordById(options.id);
    if (!record) {
      printError(`Undo record not found: ${options.id}`);
      return;
    }
  } else {
    record = getLatestUndoRecord();
    if (!record) {
      printWarning('No undo records available.');
      return;
    }
  }

  await performUndo(record, options.dryRun ?? false);
}
