import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { FilterCriteria, ProcessResult, DicomFileInfo, UndoRecord } from '../core/types';
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

function matchesFilter(info: DicomFileInfo, criteria: FilterCriteria): boolean {
  if (criteria.modality && criteria.modality.length > 0) {
    if (!criteria.modality.includes(info.modality)) {
      return false;
    }
  }

  if (criteria.dateFrom) {
    if (!info.studyDate || info.studyDate < criteria.dateFrom) {
      return false;
    }
  }

  if (criteria.dateTo) {
    if (!info.studyDate || info.studyDate > criteria.dateTo) {
      return false;
    }
  }

  if (criteria.patientId) {
    if (info.patientId !== criteria.patientId) {
      return false;
    }
  }

  return true;
}

export async function filterCommand(
  dir: string,
  options: { modality?: string; dateFrom?: string; dateTo?: string; patientId?: string; output?: string }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const outputDir = path.resolve(options.output || './filtered-output');

  const criteria: FilterCriteria = {};
  if (options.modality) {
    criteria.modality = options.modality.split(',').map(m => m.trim()).filter(Boolean);
  }
  if (options.dateFrom) {
    criteria.dateFrom = options.dateFrom;
  }
  if (options.dateTo) {
    criteria.dateTo = options.dateTo;
  }
  if (options.patientId) {
    criteria.patientId = options.patientId;
  }

  const result: ProcessResult = {
    success: false,
    totalProcessed: 0,
    successCount: 0,
    failCount: 0,
    failures: [],
    duration: 0,
    timestamp: new Date().toISOString(),
    command: 'filter',
  };

  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    result.failures.push({ filePath: dir, error: 'Directory not found' });
    result.duration = Date.now() - startTime;
    writeLog('filter', result);
    return result;
  }

  printHeader('DICOM Filter');

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
    writeLog('filter', result);
    return result;
  }

  const matched: DicomFileInfo[] = [];
  const unmatched: DicomFileInfo[] = [];

  for (const info of dicomFiles) {
    if (matchesFilter(info, criteria)) {
      matched.push(info);
    } else {
      unmatched.push(info);
    }
  }

  fs.ensureDirSync(outputDir);

  const operations: UndoRecord['operations'] = [];
  const copyBar = createProgressBar(matched.length, 'Copying');

  for (const info of matched) {
    try {
      const relativePath = path.relative(dir, path.dirname(info.filePath));
      const destDir = path.join(outputDir, relativePath);
      fs.ensureDirSync(destDir);

      const destPath = path.join(destDir, info.fileName);
      let finalDestPath = destPath;
      let counter = 1;
      while (fs.existsSync(finalDestPath)) {
        const ext = path.extname(info.fileName);
        const base = path.basename(info.fileName, ext);
        finalDestPath = path.join(destDir, `${base}_${counter}${ext}`);
        counter++;
      }

      fs.copyFileSync(info.filePath, finalDestPath);
      operations.push({ type: 'copy', from: info.filePath, to: finalDestPath });
      result.successCount++;
    } catch (err: any) {
      result.failures.push({ filePath: info.filePath, error: err.message || 'Copy error' });
      result.failCount++;
    }
    copyBar.increment();
  }
  copyBar.stop();

  result.success = result.failCount === 0;
  result.duration = Date.now() - startTime;

  const modalitiesFound = new Set(dicomFiles.filter(f => f.modality).map(f => f.modality));
  const dates = dicomFiles.filter(f => f.studyDate).map(f => f.studyDate).sort();
  const dateRange = dates.length > 0 ? `${dates[0]} - ${dates[dates.length - 1]}` : 'N/A';

  console.log('\n');
  console.log(`  Output directory : ${outputDir}`);
  console.log(`  Matched files    : ${matched.length}`);
  console.log(`  Unmatched files  : ${unmatched.length}`);
  console.log(`  Modalities found : ${Array.from(modalitiesFound).join(', ') || 'None'}`);
  console.log(`  Date range       : ${dateRange}`);
  console.log();

  const undoRecord: UndoRecord = {
    id: `filter-${Date.now()}`,
    timestamp: new Date().toISOString(),
    command: 'filter',
    operations,
  };
  saveUndoRecord(undoRecord);

  writeLog('filter', result);

  printReport(result);

  if (result.success) {
    printSuccess(`Filtered ${matched.length} file(s) to ${outputDir}`);
  } else {
    printError(`Filter completed with ${result.failCount} failure(s)`);
  }

  return result;
}
