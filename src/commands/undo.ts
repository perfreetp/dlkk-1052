import * as fs from 'fs-extra';
import * as path from 'path';
import { UndoRecord } from '../core/types';
import { getLatestUndoRecord, removeUndoRecord, listUndoRecords } from '../core/logger';
import { printSuccess, printError, printReport, printHeader, printWarning } from '../utils/display';

function findRecordById(id: string): UndoRecord | null {
  const records = listUndoRecords();
  return records.find(r => r.id === id) || null;
}

async function reverseOperation(op: UndoRecord['operations'][number]): Promise<{ reversed: boolean; detail: string }> {
  switch (op.type) {
    case 'rename': {
      if (!fs.existsSync(op.to)) {
        return { reversed: false, detail: `File not found: ${op.to}` };
      }
      const targetDir = path.dirname(op.from);
      fs.ensureDirSync(targetDir);
      fs.renameSync(op.to, op.from);
      return { reversed: true, detail: `Renamed back: ${path.basename(op.to)} -> ${path.basename(op.from)}` };
    }
    case 'copy': {
      if (!fs.existsSync(op.to)) {
        return { reversed: false, detail: `File not found: ${op.to}` };
      }
      fs.removeSync(op.to);
      return { reversed: true, detail: `Removed copy: ${path.basename(op.to)}` };
    }
    case 'modify': {
      if (op.backupPath && fs.existsSync(op.backupPath)) {
        fs.ensureDirSync(path.dirname(op.to));
        fs.copySync(op.backupPath, op.to, { overwrite: true });
        return { reversed: true, detail: `Restored original from backup: ${path.basename(op.to)}` };
      }
      return { reversed: false, detail: `Backup file not found for: ${op.to}` };
    }
    case 'delete': {
      return { reversed: false, detail: `Cannot undo delete operation for: ${op.from}` };
    }
  }
}

async function performUndo(record: UndoRecord): Promise<void> {
  printHeader(`Undoing: ${record.command}`);

  let successCount = 0;
  let failCount = 0;
  const failures: { filePath: string; error: string }[] = [];

  for (const op of record.operations) {
    const result = await reverseOperation(op);
    if (result.reversed) {
      successCount++;
      printSuccess(result.detail);
    } else {
      failCount++;
      failures.push({ filePath: op.from, error: result.detail });
      printWarning(result.detail);
    }
  }

  printReport({
    successCount,
    failCount,
    failures,
    duration: 0,
  });

  if (failCount === 0) {
    removeUndoRecord(record.id);
    printSuccess(`Undo record ${record.id} removed.`);
  } else {
    printWarning(`Undo record ${record.id} kept due to partial failure.`);
  }
}

export async function undoCommand(options: { list?: boolean; id?: string }): Promise<void> {
  if (options.list) {
    const records = listUndoRecords();
    if (records.length === 0) {
      printWarning('No undo records found.');
      return;
    }

    printHeader('Undo Records');
    for (const record of records) {
      console.log(`  ID:        ${record.id}`);
      console.log(`  Timestamp: ${record.timestamp}`);
      console.log(`  Command:   ${record.command}`);
      console.log(`  Operations: ${record.operations.length}`);
      console.log();
    }
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

  await performUndo(record);
}
