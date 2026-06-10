import * as dicomParser from 'dicom-parser';
import * as fs from 'fs-extra';
import * as path from 'path';
import { DicomFileInfo, DicomTag } from './types';

const DICOM_MAGIC = Buffer.from([0x44, 0x49, 0x43, 0x4D]);

export function isDicomFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(132);
    fs.readSync(fd, header, 0, 132, 0);
    fs.closeSync(fd);
    return header.slice(128, 132).equals(DICOM_MAGIC);
  } catch {
    return false;
  }
}

export function parseDicomFile(filePath: string): DicomFileInfo {
  const result: DicomFileInfo = createEmptyDicomFileInfo(filePath);
  try {
    const stat = fs.statSync(filePath);
    result.fileSize = stat.size;
    result.fileName = path.basename(filePath);

    const buffer = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(buffer);

    result.isValid = true;
    result.tags = new Map();

    const tagReaders: [string, string, (ds: any) => string][] = [
      ['patientId', '(0010,0020)', ds => ds.string('x00100020') || ''],
      ['patientName', '(0010,0010)', ds => ds.string('x00100010') || ''],
      ['patientBirthDate', '(0010,0030)', ds => ds.string('x00100030') || ''],
      ['patientSex', '(0010,0040)', ds => ds.string('x00100040') || ''],
      ['studyInstanceUid', '(0020,000D)', ds => ds.string('x0020000d') || ''],
      ['studyDate', '(0008,0020)', ds => ds.string('x00080020') || ''],
      ['studyDescription', '(0008,1030)', ds => ds.string('x00081030') || ''],
      ['studyId', '(0020,0010)', ds => ds.string('x00200010') || ''],
      ['accessionNumber', '(0008,0050)', ds => ds.string('x00080050') || ''],
      ['seriesInstanceUid', '(0020,000E)', ds => ds.string('x0020000e') || ''],
      ['seriesNumber', '(0020,0011)', ds => ds.string('x00200011') || ''],
      ['seriesDescription', '(0008,103E)', ds => ds.string('x0008103e') || ''],
      ['modality', '(0008,0060)', ds => ds.string('x00080060') || ''],
      ['sopInstanceUid', '(0008,0018)', ds => ds.string('x00080018') || ''],
      ['instanceNumber', '(0020,0013)', ds => ds.string('x00200013') || ''],
      ['institutionName', '(0008,0080)', ds => ds.string('x00080080') || ''],
      ['manufacturer', '(0008,0070)', ds => ds.string('x00080070') || ''],
    ];

    for (const [field, tagStr, reader] of tagReaders) {
      try {
        (result as any)[field] = reader(dataSet);
      } catch {
        (result as any)[field] = '';
      }
    }

    const elementIter = dataSet.elements;
    if (elementIter) {
      for (const tagKey of Object.keys(elementIter)) {
        try {
          const element = elementIter[tagKey];
          const group = element.tag?.substring(1, 5) || '';
          const elem = element.tag?.substring(5, 9) || '';
          const tagDisplay = `(${group.toUpperCase()},${elem.toUpperCase()})`;
          const tag: DicomTag = {
            group: parseInt(group, 16),
            element: parseInt(elem, 16),
            vr: element.vr || '',
            value: element.length > 0 ? safeGetString(dataSet, element) : undefined,
            tag: tagDisplay,
            name: getTagName(tagDisplay),
          };
          result.tags.set(tagDisplay, tag);
        } catch {}
      }
    }
  } catch (err: any) {
    result.isValid = false;
    result.errors.push(err.message || 'Unknown parsing error');
  }
  return result;
}

function safeGetString(dataSet: any, element: any): string {
  try {
    if (element.length > 1024) return `[Binary Data: ${element.length} bytes]`;
    const str = dataSet.string(element.tag);
    return str || '';
  } catch {
    return '';
  }
}

function createEmptyDicomFileInfo(filePath: string): DicomFileInfo {
  return {
    filePath,
    fileName: path.basename(filePath),
    fileSize: 0,
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
    isValid: false,
    errors: [],
    tags: new Map(),
  };
}

const TAG_NAMES: Record<string, string> = {
  '(0008,0005)': 'SpecificCharacterSet',
  '(0008,0008)': 'ImageType',
  '(0008,0016)': 'SOPClassUID',
  '(0008,0018)': 'SOPInstanceUID',
  '(0008,0020)': 'StudyDate',
  '(0008,0021)': 'SeriesDate',
  '(0008,0030)': 'StudyTime',
  '(0008,0050)': 'AccessionNumber',
  '(0008,0060)': 'Modality',
  '(0008,0070)': 'Manufacturer',
  '(0008,0080)': 'InstitutionName',
  '(0008,1030)': 'StudyDescription',
  '(0008,103E)': 'SeriesDescription',
  '(0010,0010)': 'PatientName',
  '(0010,0020)': 'PatientID',
  '(0010,0030)': 'PatientBirthDate',
  '(0010,0040)': 'PatientSex',
  '(0020,000D)': 'StudyInstanceUID',
  '(0020,000E)': 'SeriesInstanceUID',
  '(0020,0010)': 'StudyID',
  '(0020,0011)': 'SeriesNumber',
  '(0020,0013)': 'InstanceNumber',
  '(0028,0010)': 'Rows',
  '(0028,0011)': 'Columns',
  '(0028,0100)': 'BitsAllocated',
  '(0028,0101)': 'BitsStored',
  '(0028,1050)': 'WindowCenter',
  '(0028,1051)': 'WindowWidth',
};

function getTagName(tag: string): string {
  return TAG_NAMES[tag] || 'Unknown';
}

export function getPixelData(filePath: string): Buffer | null {
  try {
    const buffer = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(buffer);
    const pixelDataElement = dataSet.elements.x7fe00010;
    if (!pixelDataElement) return null;
    return Buffer.from(buffer.buffer, pixelDataElement.dataOffset, pixelDataElement.length);
  } catch {
    return null;
  }
}

export function getWindowSettings(filePath: string): { center: number; width: number } | null {
  try {
    const buffer = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(buffer);
    const center = parseFloat(dataSet.string('x00281050') || '0');
    const width = parseFloat(dataSet.string('x00281051') || '0');
    if (width > 0) return { center, width };
    return null;
  } catch {
    return null;
  }
}

export function getImageDimensions(filePath: string): { rows: number; columns: number } | null {
  try {
    const buffer = fs.readFileSync(filePath);
    const dataSet = dicomParser.parseDicom(buffer);
    const rows = dataSet.uint16('x00280010') || 0;
    const columns = dataSet.uint16('x00280011') || 0;
    if (rows > 0 && columns > 0) return { rows, columns };
    return null;
  } catch {
    return null;
  }
}
