export interface DicomTag {
  group: number;
  element: number;
  vr: string;
  value: string | number | Buffer | undefined;
  tag: string;
  name: string;
}

export interface DicomFileInfo {
  filePath: string;
  fileName: string;
  fileSize: number;
  patientId: string;
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  studyInstanceUid: string;
  studyDate: string;
  studyDescription: string;
  studyId: string;
  accessionNumber: string;
  seriesInstanceUid: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  sopInstanceUid: string;
  instanceNumber: string;
  institutionName: string;
  manufacturer: string;
  isValid: boolean;
  errors: string[];
  tags: Map<string, DicomTag>;
}

export interface ScanResult {
  totalFiles: number;
  dicomFiles: number;
  invalidFiles: number;
  files: DicomFileInfo[];
  errors: { filePath: string; error: string }[];
}

export interface PatientSummary {
  patientId: string;
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  studies: StudySummary[];
}

export interface StudySummary {
  studyInstanceUid: string;
  studyDate: string;
  studyDescription: string;
  accessionNumber: string;
  studyId: string;
  institutionName: string;
  series: SeriesSummary[];
}

export interface SeriesSummary {
  seriesInstanceUid: string;
  seriesNumber: string;
  seriesDescription: string;
  modality: string;
  instanceCount: number;
  files: string[];
}

export interface AnonymizeRule {
  tag: string;
  action: 'replace' | 'remove' | 'hash' | 'keep';
  replaceWith?: string;
}

export interface ValidateRule {
  tag: string;
  name: string;
  required: boolean;
  format?: string;
}

export interface ProcessResult {
  success: boolean;
  totalProcessed: number;
  successCount: number;
  failCount: number;
  failures: { filePath: string; error: string }[];
  duration: number;
  timestamp: string;
  command: string;
}

export interface UndoRecord {
  id: string;
  timestamp: string;
  command: string;
  operations: {
    type: 'rename' | 'copy' | 'modify' | 'delete';
    from: string;
    to: string;
    backupPath?: string;
  }[];
}

export interface AppConfig {
  anonymizeRules: AnonymizeRule[];
  validateRules: ValidateRule[];
  renamePattern: string;
  logDir: string;
  undoDir: string;
  previewSize: { width: number; height: number };
}

export interface CompareResult {
  onlyInA: string[];
  onlyInB: string[];
  common: string[];
  differences: {
    filePath: string;
    tagDifferences: { tag: string; valueA: string; valueB: string }[];
  }[];
}

export interface FilterCriteria {
  modality?: string[];
  dateFrom?: string;
  dateTo?: string;
  patientId?: string;
  studyDescription?: string;
}

export interface ExportFormat {
  type: 'csv' | 'json' | 'xlsx';
  fields: string[];
}
