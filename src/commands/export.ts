import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { DicomFileInfo, ProcessResult } from '../core/types';
import { writeLog } from '../core/logger';
import { createProgressBar, printSuccess, printError, printReport, printHeader } from '../utils/display';

const DEFAULT_FIELDS = [
  'patientId',
  'patientName',
  'patientBirthDate',
  'patientSex',
  'studyDate',
  'studyDescription',
  'accessionNumber',
  'modality',
  'seriesDescription',
  'seriesNumber',
  'instanceNumber',
  'institutionName',
  'filePath',
];

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

function escapeCsvField(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(records: Record<string, string>[], fields: string[]): string {
  const header = fields.map(escapeCsvField).join(',');
  const rows = records.map(record =>
    fields.map(field => escapeCsvField(record[field] ?? '')).join(',')
  );
  return [header, ...rows].join('\n');
}

export async function exportCommand(
  dir: string,
  options: { format?: 'csv' | 'json'; output?: string; fields?: string }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const format = options.format ?? 'csv';
  const fields = options.fields
    ? options.fields.split(',').map(f => f.trim()).filter(Boolean)
    : DEFAULT_FIELDS;

  const defaultOutput = format === 'csv' ? './dicom-manifest.csv' : './dicom-manifest.json';
  const outputPath = options.output ?? defaultOutput;

  printHeader('DICOM Export');

  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    const errResult: ProcessResult = {
      success: false, totalProcessed: 0, successCount: 0, failCount: 0,
      failures: [{ filePath: dir, error: 'Directory not found' }],
      duration: Date.now() - startTime, timestamp: new Date().toISOString(), command: 'export',
    };
    writeLog('export', errResult);
    return errResult;
  }

  const allFiles = walkDir(dir);

  if (allFiles.length === 0) {
    printError('No files found in directory');
    const emptyResult: ProcessResult = {
      success: false, totalProcessed: 0, successCount: 0, failCount: 0,
      failures: [], duration: Date.now() - startTime, timestamp: new Date().toISOString(), command: 'export',
    };
    writeLog('export', emptyResult);
    return emptyResult;
  }

  const bar = createProgressBar(allFiles.length, 'Scanning');
  const records: Record<string, string>[] = [];
  let successCount = 0;
  let failCount = 0;
  const failures: { filePath: string; error: string }[] = [];

  for (const filePath of allFiles) {
    try {
      if (!isDicomFile(filePath)) {
        bar.increment();
        continue;
      }

      const fileInfo = parseDicomFile(filePath);

      if (!fileInfo.isValid) {
        failCount++;
        fileInfo.errors.forEach(err => {
          failures.push({ filePath, error: err });
        });
        bar.increment();
        continue;
      }

      const record: Record<string, string> = {};
      for (const field of fields) {
        record[field] = String((fileInfo as any)[field] ?? '');
      }
      records.push(record);
      successCount++;
    } catch (err: any) {
      failCount++;
      failures.push({ filePath, error: err.message || 'Unknown error' });
    }

    bar.increment();
  }

  bar.stop();

  if (records.length === 0) {
    printError('No DICOM files found to export');
    const noDataResult: ProcessResult = {
      success: false, totalProcessed: allFiles.length, successCount: 0, failCount,
      failures, duration: Date.now() - startTime, timestamp: new Date().toISOString(), command: 'export',
    };
    writeLog('export', noDataResult);
    return noDataResult;
  }

  const resolvedOutput = path.resolve(outputPath);
  fs.ensureDirSync(path.dirname(resolvedOutput));

  if (format === 'csv') {
    const csv = toCsv(records, fields);
    fs.writeFileSync(resolvedOutput, csv, 'utf-8');
  } else {
    fs.writeJsonSync(resolvedOutput, records, { spaces: 2 });
  }

  printSuccess(`Exported ${records.length} record(s) to ${resolvedOutput}`);

  printReport({
    successCount,
    failCount,
    failures,
    duration: Date.now() - startTime,
  });

  writeLog('export', {
    success: true,
    totalProcessed: allFiles.length,
    successCount,
    failCount,
    failures,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    command: 'export',
  });

  return {
    success: true,
    totalProcessed: allFiles.length,
    successCount,
    failCount,
    failures,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    command: 'export',
  };
}
