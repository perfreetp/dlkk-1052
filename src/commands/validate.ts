import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile } from '../core/parser';
import { DicomFileInfo, ValidateRule } from '../core/types';
import { getValidateRules } from '../core/config';
import { writeLog } from '../core/logger';
import { createProgressBar, printSuccess, printError, printWarning, printReport, printHeader, printSection } from '../utils/display';

interface FileValidation {
  filePath: string;
  fileName: string;
  passed: boolean;
  isCorrupted: boolean;
  missingRequiredTags: { tag: string; name: string }[];
  formatViolations: { tag: string; name: string; value: string; expectedFormat: string }[];
  warnings: string[];
}

function loadCustomRules(rulesPath: string): ValidateRule[] {
  const resolved = path.resolve(rulesPath);
  if (!fs.existsSync(resolved)) {
    printError(`Rules file not found: ${resolved}`);
    process.exit(1);
  }
  try {
    const data = fs.readJsonSync(resolved);
    if (!Array.isArray(data)) {
      printError('Rules file must contain an array of validate rules');
      process.exit(1);
    }
    return data as ValidateRule[];
  } catch {
    printError(`Failed to parse rules file: ${resolved}`);
    process.exit(1);
  }
}

function matchesFormat(value: string, format: string): boolean {
  if (format.includes('|')) {
    const allowed = format.split('|');
    return allowed.includes(value);
  }
  if (format === 'YYYYMMDD') {
    return /^\d{8}$/.test(value) && isValidDate(value);
  }
  if (format === 'YYYY') {
    return /^\d{4}$/.test(value);
  }
  if (format === 'YYYYMM') {
    return /^\d{6}$/.test(value);
  }
  if (format === 'HHMMSS') {
    return /^\d{6}$/.test(value);
  }
  return true;
}

function isValidDate(dateStr: string): boolean {
  const year = parseInt(dateStr.substring(0, 4), 10);
  const month = parseInt(dateStr.substring(4, 6), 10);
  const day = parseInt(dateStr.substring(6, 8), 10);
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

function validateAgainstRules(fileInfo: DicomFileInfo, rules: ValidateRule[]): FileValidation {
  const result: FileValidation = {
    filePath: fileInfo.filePath,
    fileName: fileInfo.fileName,
    passed: true,
    isCorrupted: false,
    missingRequiredTags: [],
    formatViolations: [],
    warnings: [],
  };

  if (!fileInfo.isValid) {
    result.isCorrupted = true;
    result.passed = false;
    fileInfo.errors.forEach(e => result.warnings.push(e));
    return result;
  }

  for (const rule of rules) {
    const tagValue = fileInfo.tags.get(rule.tag);
    const hasTag = tagValue !== undefined && tagValue.value !== undefined && String(tagValue.value).trim() !== '';

    if (rule.required && !hasTag) {
      result.missingRequiredTags.push({ tag: rule.tag, name: rule.name });
      result.passed = false;
      continue;
    }

    if (hasTag && rule.format) {
      const valueStr = String(tagValue!.value!).trim();
      if (!matchesFormat(valueStr, rule.format)) {
        result.formatViolations.push({
          tag: rule.tag,
          name: rule.name,
          value: valueStr,
          expectedFormat: rule.format,
        });
        result.passed = false;
      }
    }

    if (!rule.required && !hasTag) {
      result.warnings.push(`Optional tag missing: ${rule.tag} (${rule.name})`);
    }
  }

  return result;
}

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function validateCommand(dir: string, options: { strict?: boolean; rules?: string }): Promise<void> {
  const startTime = Date.now();
  const resolvedDir = path.resolve(dir);

  printHeader('DICOM Validate');

  const rules = options.rules ? loadCustomRules(options.rules) : getValidateRules();
  printSection(`Using ${options.rules ? 'custom' : 'default'} rules (${rules.length} rules)`);

  const allFiles = collectFiles(resolvedDir);
  if (allFiles.length === 0) {
    printWarning('No files found in directory');
    return;
  }

  const dicomFiles = allFiles.filter(f => isDicomFile(f));
  if (dicomFiles.length === 0) {
    printWarning('No DICOM files found');
    return;
  }

  printSection(`Scanning ${dicomFiles.length} DICOM files`);
  const bar = createProgressBar(dicomFiles.length, 'Validating');

  const results: FileValidation[] = [];
  for (const filePath of dicomFiles) {
    const fileInfo = parseDicomFile(filePath);
    const validation = validateAgainstRules(fileInfo, rules);
    results.push(validation);
    bar.increment();
  }
  bar.stop();

  let passCount = 0;
  let failCount = 0;
  let warningCount = 0;
  const failures: { filePath: string; error: string }[] = [];

  printSection('Validation Results');

  for (const result of results) {
    const hasWarnings = result.warnings.length > 0 && !result.isCorrupted && result.missingRequiredTags.length === 0 && result.formatViolations.length === 0;

    if (result.isCorrupted) {
      printError(`${result.fileName} - CORRUPTED`);
      result.warnings.forEach(w => printError(`  ${w}`));
      failCount++;
      failures.push({ filePath: result.filePath, error: 'Corrupted file' });
      continue;
    }

    if (result.missingRequiredTags.length > 0) {
      printError(`${result.fileName} - FAIL`);
      result.missingRequiredTags.forEach(t => {
        printError(`  Missing required: ${t.tag} (${t.name})`);
      });
      result.formatViolations.forEach(v => {
        printError(`  Format violation: ${v.tag} (${v.name}) = "${v.value}", expected: ${v.expectedFormat}`);
      });
      failCount++;
      const errors = [
        ...result.missingRequiredTags.map(t => `Missing: ${t.tag} (${t.name})`),
        ...result.formatViolations.map(v => `Format: ${v.tag} (${v.name})`),
      ].join('; ');
      failures.push({ filePath: result.filePath, error: errors });
      continue;
    }

    if (result.formatViolations.length > 0) {
      printError(`${result.fileName} - FAIL`);
      result.formatViolations.forEach(v => {
        printError(`  Format violation: ${v.tag} (${v.name}) = "${v.value}", expected: ${v.expectedFormat}`);
      });
      failCount++;
      const errors = result.formatViolations.map(v => `Format: ${v.tag} (${v.name})`).join('; ');
      failures.push({ filePath: result.filePath, error: errors });
      continue;
    }

    if (hasWarnings) {
      if (options.strict) {
        printError(`${result.fileName} - FAIL (strict mode)`);
        result.warnings.forEach(w => printError(`  ${w}`));
        failCount++;
        failures.push({ filePath: result.filePath, error: result.warnings.join('; ') });
      } else {
        printWarning(`${result.fileName} - PASS (with warnings)`);
        result.warnings.forEach(w => printWarning(`  ${w}`));
        passCount++;
        warningCount++;
      }
      continue;
    }

    printSuccess(`${result.fileName} - PASS`);
    passCount++;
  }

  printSection('Summary');
  console.log(`  Total files:   ${dicomFiles.length}`);
  console.log(`  Passed:        ${passCount}`);
  console.log(`  Failed:        ${failCount}`);
  if (warningCount > 0) {
    console.log(`  Warnings:      ${warningCount}`);
  }
  console.log(`  Duration:      ${Date.now() - startTime}ms`);

  const processResult = {
    success: failCount === 0,
    totalProcessed: dicomFiles.length,
    successCount: passCount,
    failCount,
    failures,
    duration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    command: `validate ${dir}${options.strict ? ' --strict' : ''}${options.rules ? ` --rules ${options.rules}` : ''}`,
  };

  printReport(processResult);
  writeLog('validate', processResult);
}
