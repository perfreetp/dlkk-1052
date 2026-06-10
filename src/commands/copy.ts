import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { ProcessResult, UndoRecord } from '../core/types';
import { writeLog, saveUndoRecord } from '../core/logger';
import {
  createProgressBar,
  printSuccess,
  printError,
  printReport,
  printHeader,
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

function computeSha256(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function copyCommand(
  source: string,
  dest: string,
  options: { verify?: boolean; structure?: 'flat' | 'tree' }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const command = 'copy';
  const structure = options.structure || 'tree';
  const verify = options.verify ?? false;

  printHeader('DICOM Safe Copy');

  const sourceDir = path.resolve(source);
  const destDir = path.resolve(dest);

  if (!fs.existsSync(sourceDir)) {
    printError(`Source directory not found: ${sourceDir}`);
    return {
      success: false,
      totalProcessed: 0,
      successCount: 0,
      failCount: 0,
      failures: [{ filePath: sourceDir, error: 'Source directory not found' }],
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      command,
    };
  }

  fs.ensureDirSync(destDir);

  const allFiles = walkDir(sourceDir);
  const dicomFiles = allFiles.filter(f => isDicomFile(f));

  if (dicomFiles.length === 0) {
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

  const bar = createProgressBar(dicomFiles.length, 'Copying');
  let successCount = 0;
  let failCount = 0;
  const failures: { filePath: string; error: string }[] = [];
  const operations: UndoRecord['operations'] = [];
  const usedNames = new Map<string, number>();
  const verifyFailures: { filePath: string; error: string }[] = [];

  for (const filePath of dicomFiles) {
    try {
      let destPath: string;

      if (structure === 'flat') {
        const baseName = path.basename(filePath);
        let name = baseName;
        if (usedNames.has(baseName)) {
          const count = usedNames.get(baseName)! + 1;
          usedNames.set(baseName, count);
          const ext = path.extname(baseName);
          const stem = path.basename(baseName, ext);
          name = `${stem}_${count}${ext}`;
        } else {
          usedNames.set(baseName, 0);
        }
        destPath = path.join(destDir, name);
      } else {
        const relativePath = path.relative(sourceDir, filePath);
        destPath = path.join(destDir, relativePath);
        fs.ensureDirSync(path.dirname(destPath));
      }

      fs.copySync(filePath, destPath);

      operations.push({
        type: 'copy',
        from: filePath,
        to: destPath,
      });

      if (verify) {
        const srcHash = computeSha256(filePath);
        const destHash = computeSha256(destPath);
        if (srcHash !== destHash) {
          verifyFailures.push({
            filePath,
            error: 'SHA256 checksum mismatch after copy',
          });
          fs.removeSync(destPath);
          failCount++;
          bar.increment();
          continue;
        }
      }

      successCount++;
      bar.increment();
    } catch (err: any) {
      failCount++;
      failures.push({ filePath, error: err.message || 'Unknown error' });
      bar.increment();
    }
  }

  bar.stop();

  if (operations.length > 0) {
    const undoRecord: UndoRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      command,
      operations,
    };
    saveUndoRecord(undoRecord);
  }

  const allFailures = [...failures, ...verifyFailures];

  const result: ProcessResult = {
    success: failCount === 0,
    totalProcessed: dicomFiles.length,
    successCount,
    failCount,
    failures: allFailures,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    command,
  };

  writeLog(command, result);

  printReport(result);

  if (verify) {
    if (verifyFailures.length === 0) {
      printSuccess(`All ${successCount} file(s) verified successfully (SHA256 checksums match).`);
    } else {
      printError(`${verifyFailures.length} file(s) failed SHA256 verification.`);
    }
  }

  if (result.success) {
    printSuccess(`Copied ${successCount} DICOM file(s) to ${destDir}.`);
  } else {
    printError(`Copy completed with ${failCount} failure(s).`);
  }

  return result;
}
