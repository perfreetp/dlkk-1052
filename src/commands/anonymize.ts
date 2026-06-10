import { isDicomFile, parseDicomFile } from '../core/parser';
import { AnonymizeRule, ProcessResult, UndoRecord } from '../core/types';
import { getAnonymizeRules } from '../core/config';
import { writeLog, saveUndoRecord } from '../core/logger';
import { createProgressBar, printSuccess, printError, printReport, printHeader, printWarning } from '../utils/display';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as crypto from 'crypto';
import * as dicomParser from 'dicom-parser';

const PAD_WITH_SPACE_VRS = new Set(['CS', 'DA', 'DT', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);

function tagToElementKey(tag: string): string {
  const cleaned = tag.replace(/[(),\s]/g, '');
  return `x${cleaned.toLowerCase()}`;
}

function padValue(value: string, length: number, vr: string): Buffer {
  const buf = Buffer.alloc(length, PAD_WITH_SPACE_VRS.has(vr) ? 0x20 : 0x00);
  const valueBuf = Buffer.from(value, 'utf8');
  const copyLen = Math.min(valueBuf.length, length);
  valueBuf.copy(buf, 0, 0, copyLen);
  return buf;
}

function applyRuleToBuffer(
  buffer: Buffer,
  element: any,
  rule: AnonymizeRule,
  originalValue: string
): { modified: boolean; changeDesc: string } {
  if (rule.action === 'keep') {
    return { modified: false, changeDesc: '' };
  }

  const dataOffset = element.dataOffset;
  const dataLength = element.length;
  const vr = element.vr || 'UN';

  if (dataOffset === undefined || dataLength === undefined || dataLength <= 0) {
    return { modified: false, changeDesc: '' };
  }

  let newValue: string;
  let changeDesc: string;

  switch (rule.action) {
    case 'replace':
      newValue = rule.replaceWith || '';
      changeDesc = `"${originalValue}" -> "${newValue}" (replace)`;
      break;
    case 'remove':
      newValue = '';
      changeDesc = `"${originalValue}" -> "" (remove)`;
      break;
    case 'hash': {
      const hash = crypto.createHash('sha256').update(originalValue).digest('hex');
      newValue = hash;
      changeDesc = `"${originalValue}" -> "${hash.substring(0, 16)}..." (hash)`;
      break;
    }
    default:
      return { modified: false, changeDesc: '' };
  }

  const padded = padValue(newValue, dataLength, vr);
  padded.copy(buffer, dataOffset);

  return { modified: true, changeDesc };
}

export async function anonymizeCommand(
  dir: string,
  options: { output?: string; rules?: string; dryRun?: boolean }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const command = 'anonymize';

  printHeader('DICOM Anonymize');

  let rules: AnonymizeRule[];
  if (options.rules) {
    try {
      const rulesContent = fs.readFileSync(path.resolve(options.rules), 'utf8');
      rules = JSON.parse(rulesContent);
    } catch (err: any) {
      printError(`Failed to load rules file: ${err.message}`);
      return {
        success: false,
        totalProcessed: 0,
        successCount: 0,
        failCount: 0,
        failures: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        command,
      };
    }
  } else {
    rules = getAnonymizeRules();
  }

  const ruleMap = new Map<string, AnonymizeRule>();
  for (const rule of rules) {
    ruleMap.set(rule.tag, rule);
  }

  const inputDir = path.resolve(dir);
  const outputDir = options.output ? path.resolve(options.output) : inputDir;

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

  const allFiles = await getAllFiles(inputDir);
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
    printWarning('DRY RUN MODE - No files will be modified\n');
  }

  const bar = createProgressBar(dicomFiles.length, 'Anonymizing');
  let successCount = 0;
  let failCount = 0;
  const failures: { filePath: string; error: string }[] = [];
  const operations: UndoRecord['operations'] = [];

  for (const filePath of dicomFiles) {
    try {
      const fileInfo = parseDicomFile(filePath);
      if (!fileInfo.isValid) {
        bar.increment();
        failCount++;
        failures.push({ filePath, error: 'Invalid DICOM file' });
        continue;
      }

      const rawBuffer = fs.readFileSync(filePath);
      const dataSet = dicomParser.parseDicom(rawBuffer);
      let modified = false;
      const changes: string[] = [];

      for (const [tag, rule] of ruleMap) {
        const elementKey = tagToElementKey(tag);
        const element = dataSet.elements[elementKey];
        if (!element || element.length <= 0) continue;

        const originalValue = (dataSet.string(elementKey) || '').trim();

        if (options.dryRun) {
          if (rule.action === 'keep') continue;

          let preview: string;
          switch (rule.action) {
            case 'replace':
              preview = `"${originalValue}" -> "${rule.replaceWith || ''}" (replace)`;
              break;
            case 'remove':
              preview = `"${originalValue}" -> "" (remove)`;
              break;
            case 'hash': {
              const hash = crypto.createHash('sha256').update(originalValue).digest('hex');
              preview = `"${originalValue}" -> "${hash.substring(0, 16)}..." (hash)`;
              break;
            }
            default:
              continue;
          }
          changes.push(`  ${tag} ${preview}`);
          modified = true;
        } else {
          const originalValueFull = dataSet.string(elementKey) || '';
          const result = applyRuleToBuffer(rawBuffer, element, rule, originalValueFull.trim());
          if (result.modified) {
            modified = true;
            changes.push(`  ${tag} ${result.changeDesc}`);
          }
        }
      }

      if (options.dryRun) {
        if (changes.length > 0) {
          console.log(`\n${filePath}`);
          changes.forEach(c => console.log(c));
        }
        successCount++;
      } else if (modified) {
        const relativePath = path.relative(inputDir, filePath);
        const outputPath = path.join(outputDir, relativePath);

        fs.ensureDirSync(path.dirname(outputPath));
        fs.writeFileSync(outputPath, rawBuffer);

        const opType = inputDir === outputDir ? 'modify' : 'copy';
        operations.push({
          type: opType,
          from: filePath,
          to: outputPath,
        });

        successCount++;
      } else {
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

  if (result.success) {
    printSuccess(`Anonymized ${successCount} file(s) successfully.`);
  } else {
    printError(`Anonymization completed with ${failCount} failure(s).`);
  }

  return result;
}

async function getAllFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath);
      files.push(...subFiles);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}
