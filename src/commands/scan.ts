import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { ScanResult, DicomFileInfo } from '../core/types';
import { writeLog } from '../core/logger';
import {
  createProgressBar,
  printSuccess,
  printError,
  printWarning,
  printReport,
  formatFileSize,
  printHeader,
  printSection,
} from '../utils/display';

function walkDir(dir: string, recursive: boolean): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile()) {
      files.push(fullPath);
    } else if (entry.isDirectory() && recursive) {
      files.push(...walkDir(fullPath, recursive));
    }
  }
  return files;
}

export async function scanCommand(
  dir: string,
  options: { recursive?: boolean; quick?: boolean }
): Promise<ScanResult> {
  const recursive = options.recursive !== false;
  const quick = options.quick ?? false;

  const result: ScanResult = {
    totalFiles: 0,
    dicomFiles: 0,
    invalidFiles: 0,
    files: [],
    errors: [],
  };

  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    return result;
  }

  printHeader('DICOM Scan');
  printSection('Scanning directory');

  const allFiles = walkDir(dir, recursive);
  result.totalFiles = allFiles.length;

  if (allFiles.length === 0) {
    printWarning('No files found in directory');
    return result;
  }

  const bar = createProgressBar(allFiles.length, 'Scanning');

  for (const filePath of allFiles) {
    try {
      const isDicom = isDicomFile(filePath);

      if (!isDicom) {
        bar.increment();
        continue;
      }

      if (quick) {
        const stat = fs.statSync(filePath);
        const fileInfo: DicomFileInfo = {
          filePath,
          fileName: path.basename(filePath),
          fileSize: stat.size,
          patientId: '',
          patientName: '',
          patientBirthDate: '',
          patientSex: '',
          studyInstanceUid: '',
          studyDate: '',
          studyDescription: '',
          studyId: '',
          accessionNumber: '',
          seriesInstanceUid: '',
          seriesNumber: '',
          seriesDescription: '',
          modality: '',
          sopInstanceUid: '',
          instanceNumber: '',
          institutionName: '',
          manufacturer: '',
          isValid: true,
          errors: [],
          tags: new Map(),
        };
        result.files.push(fileInfo);
        result.dicomFiles++;
      } else {
        const fileInfo = parseDicomFile(filePath);
        result.files.push(fileInfo);
        if (fileInfo.isValid) {
          result.dicomFiles++;
        } else {
          result.invalidFiles++;
          fileInfo.errors.forEach(err => {
            result.errors.push({ filePath, error: err });
          });
        }
      }
    } catch (err: any) {
      result.errors.push({ filePath, error: err.message || 'Unknown error' });
      result.invalidFiles++;
    }

    bar.increment();
  }

  bar.stop();

  printSection('Scan Summary');

  const totalSize = result.files.reduce((sum, f) => sum + f.fileSize, 0);
  const modalities = new Set(result.files.filter(f => f.modality).map(f => f.modality));
  const patients = new Set(result.files.filter(f => f.patientId).map(f => f.patientId));

  console.log(`  Total files scanned : ${result.totalFiles}`);
  console.log(`  DICOM files found   : ${result.dicomFiles}`);
  console.log(`  Invalid files       : ${result.invalidFiles}`);
  console.log(`  Total DICOM size    : ${formatFileSize(totalSize)}`);
  console.log(`  Unique modalities   : ${modalities.size}`);
  console.log(`  Unique patients     : ${patients.size}`);

  if (result.errors.length > 0) {
    printSection('Errors');
    result.errors.forEach(e => {
      printError(`${e.filePath}: ${e.error}`);
    });
  }

  if (result.dicomFiles > 0) {
    printSuccess(`Found ${result.dicomFiles} DICOM file(s)`);
  } else {
    printWarning('No DICOM files found');
  }

  writeLog('scan', {
    success: true,
    totalProcessed: result.totalFiles,
    successCount: result.dicomFiles,
    failCount: result.invalidFiles,
    failures: result.errors,
    duration: 0,
    timestamp: new Date().toISOString(),
    command: 'scan',
  });

  return result;
}
