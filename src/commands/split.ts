import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { ProcessResult, DicomFileInfo, UndoRecord } from '../core/types';
import { writeLog, saveUndoRecord } from '../core/logger';
import { createProgressBar, printSuccess, printError, printReport, printHeader } from '../utils/display';

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

function sanitizeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || 'UNKNOWN';
}

export async function splitCommand(
  dir: string,
  options: { by: 'patient' | 'series'; output?: string }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const outputDir = path.resolve(options.output || './split-output');

  const result: ProcessResult = {
    success: false,
    totalProcessed: 0,
    successCount: 0,
    failCount: 0,
    failures: [],
    duration: 0,
    timestamp: new Date().toISOString(),
    command: `split --by ${options.by}`,
  };

  const undoRecord: UndoRecord = {
    id: `split-${Date.now()}`,
    timestamp: new Date().toISOString(),
    command: `split --by ${options.by}`,
    operations: [],
  };

  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    result.failures.push({ filePath: dir, error: 'Directory not found' });
    result.duration = Date.now() - startTime;
    writeLog('split', result);
    return result;
  }

  printHeader('DICOM Split');

  const allFiles = walkDir(dir);
  const dicomFiles: DicomFileInfo[] = [];

  const scanBar = createProgressBar(allFiles.length, 'Scanning');
  for (const filePath of allFiles) {
    try {
      if (isDicomFile(filePath)) {
        const info = parseDicomFile(filePath);
        if (info.isValid) {
          dicomFiles.push(info);
        }
      }
    } catch (err: any) {
      result.failures.push({ filePath, error: err.message || 'Parse error' });
    }
    scanBar.increment();
  }
  scanBar.stop();

  result.totalProcessed = dicomFiles.length;

  if (dicomFiles.length === 0) {
    printError('No valid DICOM files found');
    result.duration = Date.now() - startTime;
    writeLog('split', result);
    return result;
  }

  const groups: Map<string, { files: DicomFileInfo[]; subPath: string }> = new Map();

  if (options.by === 'patient') {
    for (const info of dicomFiles) {
      const patientId = info.patientId || 'UNKNOWN';
      const patientName = sanitizeDirName(info.patientName || 'UNKNOWN');
      const dirName = `${patientId}_${patientName}`;
      if (!groups.has(patientId)) {
        groups.set(patientId, { files: [], subPath: dirName });
      }
      groups.get(patientId)!.files.push(info);
    }
  } else {
    for (const info of dicomFiles) {
      const seriesUid = info.seriesInstanceUid || 'UNKNOWN';
      const patientPart = sanitizeDirName(info.patientId || 'UNKNOWN');
      const studyPart = sanitizeDirName(info.studyInstanceUid || 'UNKNOWN');
      const seriesPart = sanitizeDirName(seriesUid);
      const subPath = path.join(patientPart, studyPart, seriesPart);
      if (!groups.has(seriesUid)) {
        groups.set(seriesUid, { files: [], subPath });
      }
      groups.get(seriesUid)!.files.push(info);
    }
  }

  fs.ensureDirSync(outputDir);

  const copyBar = createProgressBar(dicomFiles.length, 'Copying');
  for (const [, group] of groups) {
    const groupDir = path.join(outputDir, group.subPath);
    fs.ensureDirSync(groupDir);

    for (const info of group.files) {
      try {
        const destPath = path.join(groupDir, info.fileName);
        let finalDestPath = destPath;
        let counter = 1;
        while (fs.existsSync(finalDestPath)) {
          const ext = path.extname(info.fileName);
          const base = path.basename(info.fileName, ext);
          finalDestPath = path.join(groupDir, `${base}_${counter}${ext}`);
          counter++;
        }

        fs.copyFileSync(info.filePath, finalDestPath);
        undoRecord.operations.push({ type: 'copy', from: info.filePath, to: finalDestPath });
        result.successCount++;
      } catch (err: any) {
        result.failures.push({ filePath: info.filePath, error: err.message || 'Copy error' });
        result.failCount++;
      }
      copyBar.increment();
    }
  }
  copyBar.stop();

  result.success = result.failCount === 0;
  result.duration = Date.now() - startTime;

  saveUndoRecord(undoRecord);
  writeLog('split', result);

  console.log('\n');
  console.log(`  Output directory : ${outputDir}`);
  console.log(`  Groups created   : ${groups.size}`);
  console.log(`  Criterion        : ${options.by}`);
  console.log();

  let idx = 1;
  for (const [key, group] of groups) {
    const label = options.by === 'patient' ? key : key.substring(0, 30) + (key.length > 30 ? '...' : '');
    console.log(`  Group ${idx}: ${label} (${group.files.length} file(s))`);
    idx++;
  }

  printReport(result);

  if (result.success) {
    printSuccess(`Split ${result.successCount} file(s) into ${groups.size} group(s)`);
  } else {
    printError(`Split completed with ${result.failCount} failure(s)`);
  }

  return result;
}
