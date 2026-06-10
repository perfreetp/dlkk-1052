import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { CompareResult, DicomFileInfo } from '../core/types';
import { writeLog } from '../core/logger';
import { createProgressBar, printSuccess, printError, printReport, printHeader, printSection } from '../utils/display';
import chalk from 'chalk';

const KEY_TAGS: { field: keyof DicomFileInfo; tag: string; label: string }[] = [
  { field: 'patientId', tag: '(0010,0020)', label: 'PatientID' },
  { field: 'patientName', tag: '(0010,0010)', label: 'PatientName' },
  { field: 'studyInstanceUid', tag: '(0020,000D)', label: 'StudyInstanceUID' },
  { field: 'seriesInstanceUid', tag: '(0020,000E)', label: 'SeriesInstanceUID' },
  { field: 'modality', tag: '(0008,0060)', label: 'Modality' },
  { field: 'studyDate', tag: '(0008,0020)', label: 'StudyDate' },
  { field: 'seriesDescription', tag: '(0008,103E)', label: 'SeriesDescription' },
  { field: 'instanceNumber', tag: '(0020,0013)', label: 'InstanceNumber' },
];

function collectDicomFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDicomFiles(fullPath));
    } else if (entry.isFile() && isDicomFile(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

function parseFiles(filePaths: string[], label: string): Map<string, DicomFileInfo> {
  const map = new Map<string, DicomFileInfo>();
  if (filePaths.length === 0) return map;

  const bar = createProgressBar(filePaths.length, label);
  for (const filePath of filePaths) {
    const info = parseDicomFile(filePath);
    if (info.isValid) {
      map.set(filePath, info);
    }
    bar.increment();
  }
  bar.stop();
  return map;
}

function buildKeyMap(
  files: Map<string, DicomFileInfo>,
  baseDir: string,
  byUid: boolean
): Map<string, DicomFileInfo> {
  const map = new Map<string, DicomFileInfo>();
  for (const [filePath, info] of files) {
    const key = byUid ? info.sopInstanceUid : path.relative(baseDir, filePath);
    if (key) {
      map.set(key, info);
    }
  }
  return map;
}

export async function compareCommand(
  dirA: string,
  dirB: string,
  options: { byUid?: boolean }
): Promise<CompareResult> {
  const startTime = Date.now();
  const byUid = options.byUid !== false;
  const resolvedA = path.resolve(dirA);
  const resolvedB = path.resolve(dirB);

  printHeader('DICOM Compare');
  printSection(`Mode: ${byUid ? 'SOPInstanceUID' : 'Relative Path'}`);

  if (!fs.existsSync(resolvedA)) {
    printError(`Directory A not found: ${resolvedA}`);
    return { onlyInA: [], onlyInB: [], common: [], differences: [] };
  }
  if (!fs.existsSync(resolvedB)) {
    printError(`Directory B not found: ${resolvedB}`);
    return { onlyInA: [], onlyInB: [], common: [], differences: [] };
  }

  printSection('Scanning directories');
  const filesA = collectDicomFiles(resolvedA);
  const filesB = collectDicomFiles(resolvedB);

  console.log(`  Directory A: ${filesA.length} DICOM file(s)`);
  console.log(`  Directory B: ${filesB.length} DICOM file(s)`);

  if (filesA.length === 0 && filesB.length === 0) {
    printError('No DICOM files found in either directory');
    return { onlyInA: [], onlyInB: [], common: [], differences: [] };
  }

  printSection('Parsing files');
  const parsedA = parseFiles(filesA, 'Parsing A');
  const parsedB = parseFiles(filesB, 'Parsing B');

  const keyMapA = buildKeyMap(parsedA, resolvedA, byUid);
  const keyMapB = buildKeyMap(parsedB, resolvedB, byUid);

  const keysA = new Set(keyMapA.keys());
  const keysB = new Set(keyMapB.keys());

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  const common: string[] = [];

  for (const key of keysA) {
    if (keysB.has(key)) {
      common.push(key);
    } else {
      onlyInA.push(key);
    }
  }
  for (const key of keysB) {
    if (!keysA.has(key)) {
      onlyInB.push(key);
    }
  }

  const differences: CompareResult['differences'] = [];

  for (const key of common) {
    const infoA = keyMapA.get(key)!;
    const infoB = keyMapB.get(key)!;
    const tagDiffs: CompareResult['differences'][number]['tagDifferences'] = [];

    for (const { field, label } of KEY_TAGS) {
      const valA = String(infoA[field] ?? '');
      const valB = String(infoB[field] ?? '');
      if (valA !== valB) {
        tagDiffs.push({ tag: label, valueA: valA, valueB: valB });
      }
    }

    if (tagDiffs.length > 0) {
      differences.push({
        filePath: byUid ? key : infoA.filePath,
        tagDifferences: tagDiffs,
      });
    }
  }

  printSection('Compare Results');

  console.log(`  Files only in A : ${chalk.red(String(onlyInA.length))}`);
  console.log(`  Files only in B : ${chalk.green(String(onlyInB.length))}`);
  console.log(`  Common files    : ${common.length}`);
  console.log(`  With differences: ${differences.length}`);

  if (onlyInA.length > 0) {
    printSection('Only in A');
    for (const key of onlyInA) {
      const info = keyMapA.get(key);
      const display = info ? `${key} (${info.fileName})` : key;
      console.log(`  ${chalk.red('−')} ${display}`);
    }
  }

  if (onlyInB.length > 0) {
    printSection('Only in B');
    for (const key of onlyInB) {
      const info = keyMapB.get(key);
      const display = info ? `${key} (${info.fileName})` : key;
      console.log(`  ${chalk.green('+')} ${display}`);
    }
  }

  if (differences.length > 0) {
    printSection('Tag Differences');
    for (const diff of differences) {
      console.log(`  ${chalk.bold.white(diff.filePath)}`);
      for (const td of diff.tagDifferences) {
        console.log(`    ${chalk.yellow(td.tag)}:`);
        console.log(`      A: ${chalk.red(td.valueA)}`);
        console.log(`      B: ${chalk.green(td.valueB)}`);
      }
    }
  }

  const identicalCount = common.length - differences.length;
  if (identicalCount > 0) {
    printSuccess(`${identicalCount} file(s) are identical`);
  }
  if (differences.length > 0) {
    printError(`${differences.length} file(s) have differences`);
  }

  const duration = Date.now() - startTime;
  const processResult = {
    success: differences.length === 0 && onlyInA.length === 0 && onlyInB.length === 0,
    totalProcessed: common.length + onlyInA.length + onlyInB.length,
    successCount: identicalCount,
    failCount: differences.length + onlyInA.length + onlyInB.length,
    failures: [
      ...onlyInA.map(k => ({ filePath: k, error: 'Only in A' })),
      ...onlyInB.map(k => ({ filePath: k, error: 'Only in B' })),
      ...differences.map(d => ({ filePath: d.filePath, error: `${d.tagDifferences.length} tag difference(s)` })),
    ],
    duration,
    timestamp: new Date().toISOString(),
    command: `compare ${resolvedA} ${resolvedB}${byUid ? '' : ' --no-byUid'}`,
  };

  printReport(processResult);
  writeLog('compare', processResult);

  return { onlyInA, onlyInB, common, differences };
}
