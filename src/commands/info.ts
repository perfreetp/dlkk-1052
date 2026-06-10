import * as fs from 'fs-extra';
import * as path from 'path';
import { glob } from 'glob';
import chalk from 'chalk';
import { parseDicomFile } from '../core/parser';
import { DicomFileInfo, PatientSummary, StudySummary, SeriesSummary } from '../core/types';
import { printHeader, printSection, printSuccess, formatDicomDate, truncate } from '../utils/display';

export async function infoCommand(dir: string, options: { detail?: boolean; tag?: string }): Promise<void> {
  const resolvedDir = path.resolve(dir);

  if (!fs.existsSync(resolvedDir)) {
    console.log(chalk.red(`Directory not found: ${resolvedDir}`));
    return;
  }

  const pattern = '**/*';
  const files = await glob(pattern, { cwd: resolvedDir, absolute: true, nodir: true });

  if (files.length === 0) {
    console.log(chalk.yellow('No files found in directory.'));
    return;
  }

  const parsedFiles: DicomFileInfo[] = [];
  for (const file of files) {
    const info = parseDicomFile(file);
    if (info.isValid) {
      parsedFiles.push(info);
    }
  }

  if (parsedFiles.length === 0) {
    console.log(chalk.yellow('No valid DICOM files found.'));
    return;
  }

  printHeader('DICOM Info');

  if (options.tag) {
    printTagValues(parsedFiles, options.tag);
    return;
  }

  const patients = groupByPatient(parsedFiles);

  for (const patient of patients) {
    printSection(`Patient: ${truncate(patient.patientName || 'Unknown')}`);
    console.log(`  ${chalk.gray('ID:')}         ${chalk.white(patient.patientId || 'N/A')}`);
    console.log(`  ${chalk.gray('Name:')}       ${chalk.white(patient.patientName || 'N/A')}`);
    console.log(`  ${chalk.gray('BirthDate:')}  ${chalk.white(formatDicomDate(patient.patientBirthDate) || 'N/A')}`);
    console.log(`  ${chalk.gray('Sex:')}        ${chalk.white(patient.patientSex || 'N/A')}`);

    for (const study of patient.studies) {
      console.log('');
      console.log(`  ${chalk.cyan('Study:')} ${truncate(study.studyDescription || 'Unknown Study')}`);
      console.log(`    ${chalk.gray('Date:')}       ${chalk.white(formatDicomDate(study.studyDate) || 'N/A')}`);
      console.log(`    ${chalk.gray('Accession:')} ${chalk.white(study.accessionNumber || 'N/A')}`);

      for (const series of study.series) {
        console.log('');
        console.log(`    ${chalk.magenta('Series:')} ${truncate(series.seriesDescription || 'Unknown Series')}`);
        console.log(`      ${chalk.gray('Modality:')}  ${chalk.white(series.modality || 'N/A')}`);
        console.log(`      ${chalk.gray('Number:')}    ${chalk.white(series.seriesNumber || 'N/A')}`);
        console.log(`      ${chalk.gray('Instances:')} ${chalk.white(String(series.instanceCount))}`);
      }
    }
  }

  if (options.detail) {
    printDetail(parsedFiles);
  }

  printSuccess(`Processed ${parsedFiles.length} DICOM file(s) from ${files.length} total file(s).`);
}

function groupByPatient(files: DicomFileInfo[]): PatientSummary[] {
  const patientMap = new Map<string, PatientSummary>();

  for (const file of files) {
    const key = file.patientId || '__unknown__';
    if (!patientMap.has(key)) {
      patientMap.set(key, {
        patientId: file.patientId,
        patientName: file.patientName,
        patientBirthDate: file.patientBirthDate,
        patientSex: file.patientSex,
        studies: [],
      });
    }
    const patient = patientMap.get(key)!;

    const studyKey = file.studyInstanceUid || '__unknown__';
    let study = patient.studies.find(s => s.studyInstanceUid === studyKey);
    if (!study) {
      study = {
        studyInstanceUid: file.studyInstanceUid,
        studyDate: file.studyDate,
        studyDescription: file.studyDescription,
        accessionNumber: file.accessionNumber,
        studyId: file.studyId,
        institutionName: file.institutionName,
        series: [],
      };
      patient.studies.push(study);
    }

    const seriesKey = file.seriesInstanceUid || '__unknown__';
    let series = study.series.find(s => s.seriesInstanceUid === seriesKey);
    if (!series) {
      series = {
        seriesInstanceUid: file.seriesInstanceUid,
        seriesNumber: file.seriesNumber,
        seriesDescription: file.seriesDescription,
        modality: file.modality,
        instanceCount: 0,
        files: [],
      };
      study.series.push(series);
    }
    series.instanceCount++;
    series.files.push(file.filePath);
  }

  return Array.from(patientMap.values());
}

function printTagValues(files: DicomFileInfo[], tagStr: string): void {
  const normalizedTag = tagStr.replace(/\s/g, '').toUpperCase();
  printSection(`Tag: ${normalizedTag}`);

  let found = false;
  for (const file of files) {
    const tag = file.tags.get(normalizedTag);
    if (tag) {
      found = true;
      const value = tag.value !== undefined ? String(tag.value) : '';
      console.log(`  ${chalk.gray(path.basename(file.filePath))}: ${chalk.white(truncate(value, 60))}`);
    }
  }

  if (!found) {
    console.log(chalk.yellow(`  Tag ${normalizedTag} not found in any file.`));
  }
}

function printDetail(files: DicomFileInfo[]): void {
  for (const file of files) {
    printSection(`File: ${path.basename(file.filePath)}`);
    console.log(`  ${chalk.gray('Path:')} ${file.filePath}`);
    console.log(`  ${chalk.gray('Size:')} ${file.fileSize} bytes`);
    console.log('');

    const sortedTags = Array.from(file.tags.keys()).sort();
    for (const tagKey of sortedTags) {
      const tag = file.tags.get(tagKey)!;
      const value = tag.value !== undefined ? String(tag.value) : '';
      console.log(`  ${chalk.cyan(tagKey.padEnd(14))} ${chalk.gray(tag.name.padEnd(24))} ${chalk.white(truncate(value, 50))}`);
    }
  }
}
