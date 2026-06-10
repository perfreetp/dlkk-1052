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

function writeBmp(filePath: string, width: number, height: number, values: number[]): void {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelDataSize = rowSize * height;
  const fileSize = 54 + pixelDataSize;

  const buf = Buffer.alloc(fileSize);
  let offset = 0;

  buf.write('BM', offset, 2); offset += 2;
  buf.writeUInt32LE(fileSize, offset); offset += 4;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt16LE(0, offset); offset += 2;
  buf.writeUInt32LE(54, offset); offset += 4;

  buf.writeUInt32LE(40, offset); offset += 4;
  buf.writeInt32LE(width, offset); offset += 4;
  buf.writeInt32LE(height, offset); offset += 4;
  buf.writeUInt16LE(1, offset); offset += 2;
  buf.writeUInt16LE(24, offset); offset += 2;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(pixelDataSize, offset); offset += 4;
  buf.writeInt32LE(2835, offset); offset += 4;
  buf.writeInt32LE(2835, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;
  buf.writeUInt32LE(0, offset); offset += 4;

  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const val = Math.max(0, Math.min(255, values[y * width + x]));
      buf.writeUInt8(val, offset++);
      buf.writeUInt8(val, offset++);
      buf.writeUInt8(val, offset++);
    }
    const padding = rowSize - width * 3;
    for (let p = 0; p < padding; p++) {
      buf.writeUInt8(0, offset++);
    }
  }

  fs.writeFileSync(filePath, buf);
}

export async function previewCommand(
  dir: string,
  options: { output?: string; width?: number; height?: number }
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
    result.duration = Date.now() - startTime;
    writeLog('preview', result);
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
    result.duration = Date.now() - startTime;
    writeLog('preview', result);
    return result;
  }

  fs.ensureDirSync(outputDir);
  result.totalProcessed = dicomFiles.length;

  const bar = createProgressBar(dicomFiles.length, 'Generating previews');
  const usedNames = new Map<string, number>();

  for (const filePath of dicomFiles) {
    try {
      const fileInfo = parseDicomFile(filePath);
      const pixelBuffer = getPixelData(filePath);
      const dimensions = getImageDimensions(filePath);

      if (!pixelBuffer || !dimensions) {
        result.failCount++;
        const msg = 'No image pixel data or dimensions available';
        result.failures.push({ filePath, error: msg });
        printError(`${path.basename(filePath)}: ${msg}`);
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

      const patientId = (fileInfo.patientId || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const studyDate = fileInfo.studyDate || 'nodate';
      const seriesNumber = fileInfo.seriesNumber || '0';
      const instanceNumber = fileInfo.instanceNumber || '0';
      let outputName = `${patientId}_${studyDate}_${seriesNumber}_${instanceNumber}.bmp`;

      const nameKey = outputName.toLowerCase();
      if (usedNames.has(nameKey)) {
        const cnt = usedNames.get(nameKey)! + 1;
        usedNames.set(nameKey, cnt);
        outputName = `${patientId}_${studyDate}_${seriesNumber}_${instanceNumber}_${cnt}.bmp`;
      } else {
        usedNames.set(nameKey, 0);
      }

      const outputPath = path.join(outputDir, outputName);
      writeBmp(outputPath, thumbWidth, thumbHeight, thumbValues);

      result.successCount++;
      printSuccess(`Generated: ${outputName}`);
    } catch (err: any) {
      result.failCount++;
      result.failures.push({ filePath, error: err.message || 'Unknown error' });
      printError(`Failed: ${path.basename(filePath)} - ${err.message || 'Unknown error'}`);
    }

    bar.increment();
  }

  bar.stop();

  result.duration = Date.now() - startTime;
  result.success = result.failCount === 0;

  printReport(result);

  if (result.successCount > 0) {
    printSuccess(`Thumbnails saved to: ${outputDir}`);
  }

  writeLog('preview', result);

  return result;
}
