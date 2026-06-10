import * as fs from 'fs-extra';
import * as path from 'path';
import { ProcessResult, UndoRecord } from './types';
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
  const logFile = path.join(logDir, `${timestamp}_${command}.json`);
  fs.writeJsonSync(logFile, { command, result }, { spaces: 2 });
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
