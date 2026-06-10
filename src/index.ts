#!/usr/bin/env node

import { Command } from 'commander';
import { scanCommand } from './commands/scan';
import { infoCommand } from './commands/info';
import { validateCommand } from './commands/validate';
import { anonymizeCommand } from './commands/anonymize';
import { renameCommand } from './commands/rename';
import { splitCommand } from './commands/split';
import { mergeCommand } from './commands/merge';
import { previewCommand } from './commands/preview';
import { exportCommand } from './commands/export';
import { compareCommand } from './commands/compare';
import { filterCommand } from './commands/filter';
import { copyCommand } from './commands/copy';
import { undoCommand } from './commands/undo';
import { logCommand } from './commands/log';
import { configCommand } from './commands/config';
import { batchCommand } from './commands/batch';

const program = new Command();

program
  .name('dicom-tools')
  .description('DICOM 文件批处理命令行工具 - 影像科工程师交接、脱敏和归档前使用')
  .version('1.0.0');

program
  .command('scan')
  .description('扫描目录中的 DICOM 文件')
  .argument('<dir>', '目标目录')
  .option('-r, --no-recursive', '不递归扫描子目录')
  .option('-q, --quick', '快速模式：仅检测 DICOM 魔数，不完整解析')
  .action(async (dir: string, options: any) => {
    try {
      await scanCommand(dir, { recursive: options.recursive !== false, quick: options.quick });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('info')
  .description('查看患者与序列摘要')
  .argument('<dir>', '目标目录')
  .option('-d, --detail', '显示所有 DICOM 标签详情')
  .option('-t, --tag <tagStr>', '查看指定标签值，如 (0010,0010)')
  .action(async (dir: string, options: any) => {
    try {
      await infoCommand(dir, { detail: options.detail, tag: options.tag });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('检查缺失标签和损坏文件')
  .argument('<dir>', '目标目录')
  .option('--strict', '严格模式：警告视为错误')
  .option('--rules <file>', '自定义校验规则文件 (JSON)')
  .action(async (dir: string, options: any) => {
    try {
      await validateCommand(dir, { strict: options.strict, rules: options.rules });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('anonymize')
  .description('按规则脱敏 DICOM 文件')
  .argument('<dir>', '目标目录')
  .option('-o, --output <dir>', '输出目录（默认原地修改）')
  .option('--rules <file>', '自定义脱敏规则文件 (JSON)')
  .option('--dry-run', '仅预览变更，不实际修改文件')
  .action(async (dir: string, options: any) => {
    try {
      await anonymizeCommand(dir, { output: options.output, rules: options.rules, dryRun: options.dryRun });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('rename')
  .description('按检查号重命名 DICOM 文件')
  .argument('<dir>', '目标目录')
  .option('-p, --pattern <pattern>', '重命名模板，如 {accessionNumber}_{patientId}')
  .option('--dry-run', '仅预览变更，不实际重命名')
  .action(async (dir: string, options: any) => {
    try {
      await renameCommand(dir, { pattern: options.pattern, dryRun: options.dryRun });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('split')
  .description('按患者或序列拆分 DICOM 文件')
  .argument('<dir>', '目标目录')
  .option('--by <mode>', '拆分方式: patient 或 series', 'patient')
  .option('-o, --output <dir>', '输出目录')
  .action(async (dir: string, options: any) => {
    try {
      await splitCommand(dir, { by: options.by, output: options.output });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('merge')
  .description('合并同次检查的 DICOM 文件')
  .argument('<dirs...>', '源目录列表')
  .option('-o, --output <dir>', '输出目录（必填）')
  .option('--by-study', '按 StudyInstanceUID 分组合并')
  .action(async (dirs: string[], options: any) => {
    if (!options.output) {
      console.error('错误: 必须指定输出目录 -o/--output');
      process.exit(1);
    }
    try {
      await mergeCommand(dirs, { output: options.output, byStudy: options.byStudy });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('preview')
  .description('导出 DICOM 文件缩略图（BMP 格式）及索引清单')
  .argument('<dir>', '目标目录')
  .option('-o, --output <dir>', '输出目录')
  .option('--width <pixels>', '缩略图宽度', '256')
  .option('--height <pixels>', '缩略图高度', '256')
  .option('--index-format <format>', '索引清单格式: json 或 csv', 'json')
  .option('--no-index', '不生成缩略图索引清单')
  .action(async (dir: string, options: any) => {
    try {
      await previewCommand(dir, {
        output: options.output,
        width: parseInt(options.width, 10),
        height: parseInt(options.height, 10),
        indexFormat: options.indexFormat,
        noIndex: options.index === false,
      });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('export')
  .description('生成 DICOM 文件清单')
  .argument('<dir>', '目标目录')
  .option('-f, --format <format>', '输出格式: csv 或 json', 'csv')
  .option('-o, --output <file>', '输出文件路径')
  .option('--fields <fields>', '导出字段（逗号分隔）')
  .action(async (dir: string, options: any) => {
    try {
      await exportCommand(dir, { format: options.format, output: options.output, fields: options.fields });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('compare')
  .description('对比两批 DICOM 文件差异')
  .argument('<dirA>', '目录 A')
  .argument('<dirB>', '目录 B')
  .option('--by-uid', '按 SOPInstanceUID 匹配（默认）')
  .option('--by-path', '按相对路径匹配')
  .action(async (dirA: string, dirB: string, options: any) => {
    try {
      await compareCommand(dirA, dirB, { byUid: !options.byPath });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('filter')
  .description('按模态和日期筛选 DICOM 文件')
  .argument('<dir>', '目标目录')
  .option('-m, --modality <modalities>', '模态筛选（逗号分隔，如 CT,MR）')
  .option('--date-from <date>', '起始日期 (YYYYMMDD)')
  .option('--date-to <date>', '截止日期 (YYYYMMDD)')
  .option('--patient-id <id>', '患者 ID')
  .option('-o, --output <dir>', '输出目录')
  .action(async (dir: string, options: any) => {
    try {
      await filterCommand(dir, {
        modality: options.modality,
        dateFrom: options.dateFrom,
        dateTo: options.dateTo,
        patientId: options.patientId,
        output: options.output,
      });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('copy')
  .description('安全复制 DICOM 文件')
  .argument('<source>', '源目录')
  .argument('<dest>', '目标目录')
  .option('--verify', '复制后校验 SHA256')
  .option('--structure <mode>', '目录结构: flat 或 tree', 'tree')
  .action(async (source: string, dest: string, options: any) => {
    try {
      await copyCommand(source, dest, { verify: options.verify, structure: options.structure });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('undo')
  .description('回滚上次处理操作')
  .option('--list', '查看所有可回滚记录')
  .option('--id <id>', '回滚指定记录')
  .option('--dry-run', '预览将要还原/删除的文件，再确认执行')
  .action(async (options: any) => {
    try {
      await undoCommand({ list: options.list, id: options.id, dryRun: options.dryRun });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('log')
  .description('查看处理记录')
  .option('-n, --limit <number>', '显示条数', '10')
  .option('-c, --command <name>', '按命令名称筛选')
  .option('-d, --detail', '显示详细信息')
  .option('--batch-id <id>', '按批量任务 ID 查看整条链路')
  .action(async (options: any) => {
    try {
      await logCommand({ limit: parseInt(options.limit, 10), command: options.command, detail: options.detail, batchId: options.batchId });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('config')
  .description('管理配置与规则')
  .argument('<action>', '操作: show | reset | path | get | set | rules | import | export')
  .option('-k, --key <key>', '配置键名')
  .option('-v, --value <value>', '配置值')
  .option('-f, --file <file>', '规则文件路径')
  .action(async (action: string, options: any) => {
    try {
      await configCommand(action, { key: options.key, value: options.value, file: options.file });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program
  .command('batch')
  .description('按配置文件批量执行 scan/validate/anonymize/rename/preview/export')
  .argument('<configFile>', '批量任务配置文件 (JSON)')
  .option('--continue-on-failure', '某步失败后继续后续步骤')
  .option('--dry-run', '预览各步骤执行，不实际修改文件')
  .option('--resume <batchId>', '按批次 ID 从失败步骤继续执行')
  .option('--from-step <number>', '从指定步骤编号开始（从 0 开始）')
  .action(async (configFile: string, options: any) => {
    try {
      await batchCommand(configFile, {
        continueOnFailure: options.continueOnFailure,
        dryRun: options.dryRun,
        resume: options.resume,
        fromStep: options.fromStep !== undefined ? parseInt(options.fromStep, 10) : undefined,
      });
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
