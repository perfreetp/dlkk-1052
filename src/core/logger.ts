import * as fs from 'fs-extra';
import * as path from 'path';
import { ProcessResult, UndoRecord, BatchResult } from './types';
import { loadConfig } from './config';

export function ensureLogDir(): string {
  const config = loadConfig();
  const logDir = path.resolve(config.logDir);
  fs.ensureDirSync(logDir);
  return logDir;
}

export function ensureUndoDir(): string {
  const config = loadConfig();
  const undoDir = path.resolve(config.undoDir);
  fs.ensureDirSync(undoDir);
  return undoDir;
}

export function writeLog(command: string, result: ProcessResult): void {
  const logDir = ensureLogDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  let prefix = result.batchId
    ? `${result.batchId}_${String(result.stepIndex ?? 0).padStart(2, '0')}_${command}`
    : `${timestamp}_${command}`;
  const logFile = path.join(logDir, `${prefix}.json`);
  fs.writeJsonSync(logFile, { command, result }, { spaces: 2 });
}

export function writeBatchLog(batchResult: BatchResult): void {
  const logDir = ensureLogDir();
  const logFile = path.join(logDir, `BATCH_${batchResult.batchId}.json`);
  fs.writeJsonSync(logFile, { command: 'batch', batchResult }, { spaces: 2 });
}

export function getLogFiles(): string[] {
  const logDir = ensureLogDir();
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => path.join(logDir, f));
}

export function getBatchLogFiles(): string[] {
  const logDir = ensureLogDir();
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter(f => f.startsWith('BATCH_') && f.endsWith('.json'))
    .sort()
    .reverse()
    .map(f => path.join(logDir, f));
}

export function getBatchStepLogs(batchId: string): string[] {
  const logDir = ensureLogDir();
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter(f => f.startsWith(`${batchId}_`) && f.endsWith('.json'))
    .sort()
    .map(f => path.join(logDir, f));
}

export function findBatchById(batchId: string): any | null {
  const batchLogs = getBatchLogFiles();
  for (const f of batchLogs) {
    try {
      const data = fs.readJsonSync(f);
      if (data.batchResult && data.batchResult.batchId === batchId) return data;
    } catch {}
  }
  return null;
}

export function readLog(filePath: string): any {
  return fs.readJsonSync(filePath);
}

export function saveUndoRecord(record: UndoRecord): void {
  const undoDir = ensureUndoDir();
  const undoFile = path.join(undoDir, `${record.id}.json`);
  fs.writeJsonSync(undoFile, record, { spaces: 2 });
}

export function ensureBackupDir(recordId: string): string {
  const undoDir = ensureUndoDir();
  const backupDir = path.join(undoDir, `backup-${recordId}`);
  fs.ensureDirSync(backupDir);
  return backupDir;
}

export function getLatestUndoRecord(): UndoRecord | null {
  const undoDir = ensureUndoDir();
  if (!fs.existsSync(undoDir)) return null;

  const files = fs.readdirSync(undoDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;
  return fs.readJsonSync(path.join(undoDir, files[0]));
}

export function removeUndoRecord(id: string): void {
  const undoDir = ensureUndoDir();
  const undoFile = path.join(undoDir, `${id}.json`);
  const backupDir = path.join(undoDir, `backup-${id}`);
  if (fs.existsSync(undoFile)) {
    fs.removeSync(undoFile);
  }
  if (fs.existsSync(backupDir)) {
    fs.removeSync(backupDir);
  }
}

export function listUndoRecords(): UndoRecord[] {
  const undoDir = ensureUndoDir();
  if (!fs.existsSync(undoDir)) return [];

  const files = fs.readdirSync(undoDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  return files.map(f => fs.readJsonSync(path.join(undoDir, f)));
}
