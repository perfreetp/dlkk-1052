import * as fs from 'fs-extra';
import * as path from 'path';
import { isDicomFile, parseDicomFile, getPixelData, getImageDimensions, getWindowSettings } from '../core/parser';
import { ProcessResult } from '../core/types';
import { loadConfig } from '../core/config';
import { writeLog } from '../core/logger';
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

function readPixelValues(pixelBuffer: Buffer, rows: number, columns: number): number[] {
  const totalPixels = rows * columns;
  const is16Bit = pixelBuffer.length >= totalPixels * 2;
  const values: number[] = [];

  if (is16Bit) {
    for (let i = 0; i < totalPixels; i++) {
      values.push(pixelBuffer.readUInt16LE(i * 2));
    }
  } else {
    for (let i = 0; i < totalPixels; i++) {
      values.push(pixelBuffer[i]);
    }
  }

  return values;
}

function applyWindowLevel(values: number[], center: number, width: number): number[] {
  const lower = center - width / 2;
  const upper = center + width / 2;
  return values.map(v => {
    if (v <= lower) return 0;
    if (v >= upper) return 255;
    return Math.round(((v - lower) / width) * 255);
  });
}

function applyMinMaxScaling(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min || 1;
  return values.map(v => Math.round(((v - min) / range) * 255));
}

function downsample(values: number[], srcRows: number, srcCols: number, dstRows: number, dstCols: number): number[] {
  const result: number[] = new Array(dstRows * dstCols);
  const rowRatio = srcRows / dstRows;
  const colRatio = srcCols / dstCols;
  const blockH = Math.ceil(rowRatio);
  const blockW = Math.ceil(colRatio);

  for (let dy = 0; dy < dstRows; dy++) {
    for (let dx = 0; dx < dstCols; dx++) {
      const srcYStart = Math.floor(dy * rowRatio);
      const srcXStart = Math.floor(dx * colRatio);
      let sum = 0;
      let count = 0;

      for (let by = 0; by < blockH; by++) {
        const srcY = srcYStart + by;
        if (srcY >= srcRows) break;
        for (let bx = 0; bx < blockW; bx++) {
          const srcX = srcXStart + bx;
          if (srcX >= srcCols) break;
          sum += values[srcY * srcCols + srcX];
          count++;
        }
      }

      result[dy * dstCols + dx] = count > 0 ? Math.round(sum / count) : 0;
    }
  }

  return result;
}

function writePgm(filePath: string, width: number, height: number, values: number[]): void {
  const header = `P5\n${width} ${height}\n255\n`;
  const headerBuf = Buffer.from(header, 'ascii');
  const dataBuf = Buffer.alloc(values.length);
  for (let i = 0; i < values.length; i++) {
    dataBuf[i] = Math.max(0, Math.min(255, values[i]));
  }
  const combined = Buffer.concat([headerBuf, dataBuf]);
  fs.writeFileSync(filePath, combined);
}

export async function previewCommand(
  dir: string,
  options: { output?: string; width?: number; height?: number; format?: 'png' | 'jpg' }
): Promise<ProcessResult> {
  const startTime = Date.now();
  const config = loadConfig();
  const thumbWidth = options.width ?? config.previewSize.width;
  const thumbHeight = options.height ?? config.previewSize.height;
  const outputDir = options.output ?? path.join(dir, 'previews');

  const result: ProcessResult = {
    success: true,
    totalProcessed: 0,
    successCount: 0,
    failCount: 0,
    failures: [],
    duration: 0,
    timestamp: new Date().toISOString(),
    command: 'preview',
  };

  if (!fs.existsSync(dir)) {
    printError(`Directory not found: ${dir}`);
    result.success = false;
    return result;
  }

  printHeader('DICOM Preview');

  const allFiles = walkDir(dir);
  const dicomFiles: string[] = [];

  for (const filePath of allFiles) {
    if (isDicomFile(filePath)) {
      dicomFiles.push(filePath);
    }
  }

  if (dicomFiles.length === 0) {
    printError('No DICOM files found');
    result.success = false;
    return result;
  }

  fs.ensureDirSync(outputDir);
  result.totalProcessed = dicomFiles.length;

  const bar = createProgressBar(dicomFiles.length, 'Generating previews');

  for (const filePath of dicomFiles) {
    try {
      const fileInfo = parseDicomFile(filePath);
      const pixelBuffer = getPixelData(filePath);
      const dimensions = getImageDimensions(filePath);

      if (!pixelBuffer || !dimensions) {
        result.failCount++;
        result.failures.push({ filePath, error: 'No pixel data or dimensions available' });
        bar.increment();
        continue;
      }

      const { rows, columns } = dimensions;
      const values = readPixelValues(pixelBuffer, rows, columns);

      const windowSettings = getWindowSettings(filePath);
      const scaled = windowSettings
        ? applyWindowLevel(values, windowSettings.center, windowSettings.width)
        : applyMinMaxScaling(values);

      const thumbValues = downsample(scaled, rows, columns, thumbHeight, thumbWidth);

      const patientId = fileInfo.patientId || 'unknown';
      const studyDate = fileInfo.studyDate || 'nodate';
      const seriesNumber = fileInfo.seriesNumber || '0';
      const instanceNumber = fileInfo.instanceNumber || '0';
      const outputName = `${patientId}_${studyDate}_${seriesNumber}_${instanceNumber}.pgm`;
      const outputPath = path.join(outputDir, outputName);

      writePgm(outputPath, thumbWidth, thumbHeight, thumbValues);

      result.successCount++;
      printSuccess(`Generated: ${outputName}`);
    } catch (err: any) {
      result.failCount++;
      result.failures.push({ filePath, error: err.message || 'Unknown error' });
      printError(`Failed: ${path.basename(filePath)}`);
    }

    bar.increment();
  }

  bar.stop();

  result.duration = Date.now() - startTime;

  printReport(result);

  if (result.successCount > 0) {
    printSuccess(`Thumbnails saved to: ${outputDir}`);
  }

  writeLog('preview', result);

  return result;
}
