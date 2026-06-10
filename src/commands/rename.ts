import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import chalk from 'chalk';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { ProcessResult, UndoRecord } from '../core/types';
import { loadConfig } from '../core/config';
import { writeLog, saveUndoRecord } from '../core/logger';
import {
  createProgressBar,
  printSuccess,
  printError,
  printReport,
  printHeader,
  printWarning,
} from '../utils/display';

function walkDir(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory()) {
      files.push(...walkDir(fullPath));
    }
  }
  return files;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
}

function buildFileName(pattern: string, tags: Record<string, string>): string {
  let result = pattern;
  for (const [key, value] of Object.entries(tags)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }
  result = result.replace(/\{[^}]+\}/g, '');
  return sanitizeFileName(result);
}

function getFileExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.dcm' ? '.dcm' : ext || '.dcm';
}

function resolveUniqueRenameName(
  dirPath: string,
  baseName: string,
  ext: string,
  originalPath: string,
  usedNames: Map<string, number>
): { newPath: string; addedSuffix: boolean } {
  let candidateName = `${baseName}${ext}`;
  let candidatePath = path.join(dirPath, candidateName);
  const nameKey = candidatePath.toLowerCase();

  if (!usedNames.has(nameKey) && (!fs.existsSync(candidatePath) || candidatePath.toLowerCase() === originalPath.toLowerCase())) {
    usedNames.set(nameKey, 0);
    return { newPath: candidatePath, addedSuffix: false };
  }

  const startCount = (usedNames.get(nameKey) ?? 0) + 1;
  let counter = startCount;
  while (true) {
    candidateName = `${baseName}_${counter}${ext}`;
    candidatePath = path.join(dirPath, candidateName);
    const lowerCandidate = candidatePath.toLowerCase();
    if (!usedNames.has(lowerCandidate) && (!fs.existsSync(candidatePath) || lowerCandidate === originalPath.toLowerCase())) {
      usedNames.set(nameKey, counter);
      usedNames.set(lowerCandidate, counter);
      return { newPath: candidatePath, addedSuffix: true };
    }
    counter++;
  }
}

export async function renameCommand(
  dir: string,
  options: { pattern?: string; dryRun?: boolean }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const command = 'rename';

  printHeader('DICOM Rename');

  const config = loadConfig();
  const pattern = options.pattern || config.renamePattern;
  const inputDir = path.resolve(dir);

  if (!fs.existsSync(inputDir)) {
    printError(`Directory not found: ${inputDir}`);
    return {
      success: false,
      totalProcessed: 0,
      successCount: 0,
      failCount: 0,
      failures: [{ filePath: inputDir, error: 'Directory not found' }],
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      command,
    };
  }

  const allFiles = walkDir(inputDir);
  const dicomFiles = allFiles.filter(f => isDicomFile(f));

  if (dicomFiles.length === 0) {
    printWarning('No DICOM files found in the directory.');
    return {
      success: true,
      totalProcessed: 0,
      successCount: 0,
      failCount: 0,
      failures: [],
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      command,
    };
  }

  if (options.dryRun) {
    printWarning('DRY RUN MODE - No files will be renamed\n');
  }

  const bar = createProgressBar(dicomFiles.length, 'Renaming');
  let successCount = 0;
  let failCount = 0;
  let autoSuffixCount = 0;
  const failures: { filePath: string; error: string }[] = [];
  const operations: UndoRecord['operations'] = [];
  const usedNames = new Map<string, number>();

  for (const filePath of dicomFiles) {
    try {
      const fileInfo = parseDicomFile(filePath);
      if (!fileInfo.isValid) {
        bar.increment();
        failCount++;
        failures.push({ filePath, error: 'Invalid DICOM file' });
        continue;
      }

      const tags: Record<string, string> = {
        patientId: fileInfo.patientId,
        patientName: fileInfo.patientName,
        studyDate: fileInfo.studyDate,
        studyDescription: fileInfo.studyDescription,
        accessionNumber: fileInfo.accessionNumber,
        seriesNumber: fileInfo.seriesNumber,
        seriesDescription: fileInfo.seriesDescription,
        modality: fileInfo.modality,
        instanceNumber: fileInfo.instanceNumber,
        studyId: fileInfo.studyId,
        institutionName: fileInfo.institutionName,
      };

      const baseName = buildFileName(pattern, tags);
      const ext = getFileExtension(filePath);
      const dirPath = path.dirname(filePath);

      const { newPath, addedSuffix } = resolveUniqueRenameName(dirPath, baseName, ext, filePath, usedNames);

      if (newPath.toLowerCase() === filePath.toLowerCase()) {
        bar.increment();
        successCount++;
        continue;
      }

      if (fs.existsSync(newPath) && newPath.toLowerCase() !== filePath.toLowerCase()) {
        bar.increment();
        failCount++;
        const msg = `目标文件已存在且非自身，已自动避让失败: ${path.basename(newPath)}`;
        failures.push({ filePath, error: msg });
        printWarning(`${path.basename(filePath)} -> ${msg}`);
        continue;
      }

      if (options.dryRun) {
        let suffixNote = '';
        if (addedSuffix) {
          suffixNote = chalk.yellow(' [自动加后缀避免冲突]');
          autoSuffixCount++;
        }
        console.log(`  ${path.basename(filePath)} -> ${path.basename(newPath)}${suffixNote}`);
        successCount++;
      } else {
        if (addedSuffix) {
          autoSuffixCount++;
          printWarning(`${path.basename(filePath)} 目标重名，自动改名: ${path.basename(newPath)}`);
        }
        fs.renameSync(filePath, newPath);
        operations.push({
          type: 'rename',
          from: filePath,
          to: newPath,
        });
        successCount++;
      }

      bar.increment();
    } catch (err: any) {
      bar.increment();
      failCount++;
      failures.push({ filePath, error: err.message || 'Unknown error' });
    }
  }

  bar.stop();

  if (!options.dryRun && operations.length > 0) {
    const undoRecord: UndoRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      command,
      operations,
    };
    saveUndoRecord(undoRecord);
  }

  const result: ProcessResult = {
    success: failCount === 0,
    totalProcessed: dicomFiles.length,
    successCount,
    failCount,
    failures,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    command,
  };

  writeLog(command, result);

  printReport(result);

  if (autoSuffixCount > 0) {
    console.log(`  自动加后缀避免冲突: ${autoSuffixCount} 个文件`);
  }

  if (result.success) {
    printSuccess(`Renamed ${successCount} file(s) successfully.`);
  } else {
    printError(`Rename completed with ${failCount} failure(s).`);
  }

  return result;
}
