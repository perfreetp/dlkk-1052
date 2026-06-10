import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { ProcessResult, UndoRecord } from '../core/types';
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

export async function mergeCommand(
  sources: string[],
  options: { output: string; byStudy?: boolean }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const result: ProcessResult = {
    success: true,
    totalProcessed: 0,
    successCount: 0,
    failCount: 0,
    failures: [],
    duration: 0,
    timestamp: new Date().toISOString(),
    command: 'merge',
  };

  const operations: UndoRecord['operations'] = [];
  const seenSopUids = new Set<string>();
  let duplicatesSkipped = 0;

  printHeader('DICOM Merge');

  for (const source of sources) {
    if (!fs.existsSync(source)) {
      printError(`Source directory not found: ${source}`);
      result.failures.push({ filePath: source, error: 'Directory not found' });
      continue;
    }
  }

  const allDicomFiles: { filePath: string; sourceDir: string }[] = [];

  for (const source of sources) {
    if (!fs.existsSync(source)) continue;
    const files = walkDir(source);
    for (const filePath of files) {
      if (isDicomFile(filePath)) {
        allDicomFiles.push({ filePath, sourceDir: source });
      }
    }
  }

  if (allDicomFiles.length === 0) {
    printWarning('No DICOM files found in source directories');
    result.duration = Date.now() - startTime;
    writeLog('merge', result);
    return result;
  }

  const bar = createProgressBar(allDicomFiles.length, 'Merging');

  for (const { filePath, sourceDir } of allDicomFiles) {
    try {
      const fileInfo = parseDicomFile(filePath);

      if (!fileInfo.isValid) {
        result.failCount++;
        result.failures.push({ filePath, error: 'Invalid DICOM file' });
        bar.increment();
        continue;
      }

      if (fileInfo.sopInstanceUid && seenSopUids.has(fileInfo.sopInstanceUid)) {
        duplicatesSkipped++;
        printWarning(`Duplicate SOPInstanceUID skipped: ${fileInfo.sopInstanceUid}`);
        bar.increment();
        continue;
      }

      if (fileInfo.sopInstanceUid) {
        seenSopUids.add(fileInfo.sopInstanceUid);
      }

      let destDir: string;
      if (options.byStudy && fileInfo.studyInstanceUid) {
        destDir = path.join(options.output, fileInfo.studyInstanceUid);
      } else {
        const relativePath = path.relative(sourceDir, path.dirname(filePath));
        destDir = path.join(options.output, relativePath);
      }

      await fs.ensureDir(destDir);

      const destPath = path.join(destDir, path.basename(filePath));
      await fs.copy(filePath, destPath, { overwrite: false });

      operations.push({ type: 'copy', from: filePath, to: destPath });
      result.successCount++;
    } catch (err: any) {
      result.failCount++;
      result.failures.push({ filePath, error: err.message || 'Unknown error' });
    }

    result.totalProcessed++;
    bar.increment();
  }

  bar.stop();

  const undoRecord: UndoRecord = {
    id: `merge-${Date.now()}`,
    timestamp: new Date().toISOString(),
    command: 'merge',
    operations,
  };
  saveUndoRecord(undoRecord);

  result.duration = Date.now() - startTime;
  result.success = result.failCount === 0;

  printReport(result);

  console.log(`  Duplicates skipped: ${duplicatesSkipped}`);

  if (options.byStudy) {
    const studyDirs = new Set(operations.map(op => path.dirname(op.to)));
    console.log(`  Study directories created: ${studyDirs.size}`);
  }

  if (result.successCount > 0) {
    printSuccess(`Merged ${result.successCount} file(s) into ${options.output}`);
  }

  writeLog('merge', result);

  return result;
}
