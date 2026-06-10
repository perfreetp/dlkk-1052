import * as fs from 'fs-extra';
import * as path from 'path';
import { AppConfig, AnonymizeRule, ValidateRule } from './types';

const DEFAULT_ANONYMIZE_RULES: AnonymizeRule[] = [
  { tag: '(0010,0010)', action: 'replace', replaceWith: 'ANONYMOUS' },
  { tag: '(0010,0020)', action: 'hash' },
  { tag: '(0010,0030)', action: 'replace', replaceWith: '19000101' },
  { tag: '(0010,0040)', action: 'keep' },
  { tag: '(0008,0050)', action: 'hash' },
  { tag: '(0008,0080)', action: 'replace', replaceWith: 'ANONYMOUS_INSTITUTION' },
  { tag: '(0010,1001)', action: 'remove' },
  { tag: '(0010,1002)', action: 'remove' },
  { tag: '(0010,1005)', action: 'remove' },
  { tag: '(0010,1040)', action: 'remove' },
  { tag: '(0010,2154)', action: 'remove' },
  { tag: '(0038,0500)', action: 'remove' },
  { tag: '(0040,0280)', action: 'remove' },
  { tag: '(0008,009C)', action: 'replace', replaceWith: 'ANONYMOUS' },
  { tag: '(0008,009D)', action: 'replace', replaceWith: 'ANONYMOUS' },
  { tag: '(0008,0090)', action: 'replace', replaceWith: 'ANONYMOUS' },
  { tag: '(0008,1070)', action: 'remove' },
  { tag: '(0008,0081)', action: 'remove' },
];

const DEFAULT_VALIDATE_RULES: ValidateRule[] = [
  { tag: '(0010,0010)', name: 'PatientName', required: true },
  { tag: '(0010,0020)', name: 'PatientID', required: true },
  { tag: '(0008,0060)', name: 'Modality', required: true },
  { tag: '(0008,0020)', name: 'StudyDate', required: true },
  { tag: '(0020,000D)', name: 'StudyInstanceUID', required: true },
  { tag: '(0020,000E)', name: 'SeriesInstanceUID', required: true },
  { tag: '(0008,0018)', name: 'SOPInstanceUID', required: true },
  { tag: '(0008,0016)', name: 'SOPClassUID', required: true },
  { tag: '(0020,0011)', name: 'SeriesNumber', required: false },
  { tag: '(0020,0013)', name: 'InstanceNumber', required: false },
  { tag: '(0008,0050)', name: 'AccessionNumber', required: false },
  { tag: '(0010,0040)', name: 'PatientSex', required: false, format: 'M|F|O' },
  { tag: '(0010,0030)', name: 'PatientBirthDate', required: false, format: 'YYYYMMDD' },
];

const DEFAULT_CONFIG: AppConfig = {
  anonymizeRules: DEFAULT_ANONYMIZE_RULES,
  validateRules: DEFAULT_VALIDATE_RULES,
  renamePattern: '{accessionNumber}_{patientId}_{studyDate}_{seriesNumber}_{instanceNumber}',
  logDir: './dicom-tools-logs',
  undoDir: './dicom-tools-undo',
  previewSize: { width: 256, height: 256 },
  previewFormat: 'png',
};

let configCache: AppConfig | null = null;

export function getConfigDir(): string {
  const homeDir = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(homeDir, '.dicom-tools');
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.json');
}

export function loadConfig(): AppConfig {
  if (configCache) return configCache;

  const configPath = getConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const data = fs.readJsonSync(configPath);
      configCache = { ...DEFAULT_CONFIG, ...data };
      return configCache!;
    } catch {
      configCache = { ...DEFAULT_CONFIG };
      return configCache!;
    }
  }

  configCache = { ...DEFAULT_CONFIG };
  return configCache;
}

export function saveConfig(config: AppConfig): void {
  const configDir = getConfigDir();
  fs.ensureDirSync(configDir);
  fs.writeJsonSync(getConfigPath(), config, { spaces: 2 });
  configCache = config;
}

export function getDefaultConfig(): AppConfig {
  return { ...DEFAULT_CONFIG };
}

export function resetConfig(): void {
  saveConfig({ ...DEFAULT_CONFIG });
}

export function getAnonymizeRules(): AnonymizeRule[] {
  return loadConfig().anonymizeRules;
}

export function setAnonymizeRules(rules: AnonymizeRule[]): void {
  const config = loadConfig();
  config.anonymizeRules = rules;
  saveConfig(config);
}

export function getValidateRules(): ValidateRule[] {
  return loadConfig().validateRules;
}

export function setValidateRules(rules: ValidateRule[]): void {
  const config = loadConfig();
  config.validateRules = rules;
  saveConfig(config);
}
