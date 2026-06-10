import {
  loadConfig,
  saveConfig,
  resetConfig,
  getDefaultConfig,
  getAnonymizeRules,
  setAnonymizeRules,
  getValidateRules,
  setValidateRules,
  getConfigPath,
} from '../core/config';
import { printHeader, printSection, printSuccess, printError, printTable } from '../utils/display';
import * as fs from 'fs-extra';
import chalk from 'chalk';

function parseValue(value: string): string | number | boolean | object {
  if (value === 'true') return true;
  if (value === 'false') return false;

  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;

  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch {}

  return value;
}

function setNestedValue(obj: Record<string, unknown>, keyPath: string, value: unknown): boolean {
  const keys = keyPath.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    if (current[keys[i]] === undefined || typeof current[keys[i]] !== 'object') {
      return false;
    }
    current = current[keys[i]] as Record<string, unknown>;
  }

  const lastKey = keys[keys.length - 1];
  if (!(lastKey in current)) return false;

  current[lastKey] = value;
  return true;
}

function getNestedValue(obj: Record<string, unknown>, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

export async function configCommand(
  action: string,
  options: { key?: string; value?: string; file?: string }
): Promise<void> {
  switch (action) {
    case 'show': {
      printHeader('Current Configuration');
      const config = loadConfig();
      const rows = Object.entries(config).map(([key, val]) => {
        if (Array.isArray(val)) {
          return [key, `[${val.length} item(s)]`];
        }
        return [key, typeof val === 'object' ? JSON.stringify(val) : String(val)];
      });
      printTable(['Key', 'Value'], rows as string[][]);
      break;
    }

    case 'reset': {
      resetConfig();
      printSuccess('Configuration reset to defaults.');
      break;
    }

    case 'path': {
      const configPath = getConfigPath();
      console.log(configPath);
      break;
    }

    case 'get': {
      if (!options.key) {
        printError('Missing --key option. Usage: config get --key <key>');
        return;
      }
      const config = loadConfig();
      const val = getNestedValue(config as unknown as Record<string, unknown>, options.key);
      if (val === undefined) {
        printError(`Key "${options.key}" not found in configuration.`);
        return;
      }
      if (typeof val === 'object' && val !== null) {
        console.log(JSON.stringify(val, null, 2));
      } else {
        console.log(String(val));
      }
      break;
    }

    case 'set': {
      if (!options.key) {
        printError('Missing --key option. Usage: config set --key <key> --value <value>');
        return;
      }
      if (options.value === undefined) {
        printError('Missing --value option. Usage: config set --key <key> --value <value>');
        return;
      }
      const config = loadConfig();
      const parsedValue = parseValue(options.value);
      const success = setNestedValue(
        config as unknown as Record<string, unknown>,
        options.key,
        parsedValue
      );
      if (!success) {
        printError(`Key "${options.key}" does not exist in configuration.`);
        return;
      }
      saveConfig(config);
      printSuccess(`Set ${chalk.cyan(options.key)} = ${chalk.yellow(JSON.stringify(parsedValue))}`);
      break;
    }

    case 'rules': {
      printHeader('Configuration Rules');

      printSection('Anonymize Rules');
      const anonRules = getAnonymizeRules();
      printTable(
        ['Tag', 'Action', 'Replace With'],
        anonRules.map(r => [r.tag, r.action, r.replaceWith || '-'])
      );

      printSection('Validate Rules');
      const valRules = getValidateRules();
      printTable(
        ['Tag', 'Name', 'Required', 'Format'],
        valRules.map(r => [r.tag, r.name, r.required ? 'Yes' : 'No', r.format || '-'])
      );
      break;
    }

    case 'import': {
      if (!options.file) {
        printError('Missing --file option. Usage: config import --file <path>');
        return;
      }
      try {
        const data = fs.readJsonSync(options.file);
        if (data.anonymizeRules) {
          setAnonymizeRules(data.anonymizeRules);
          printSuccess(`Imported ${data.anonymizeRules.length} anonymize rule(s).`);
        }
        if (data.validateRules) {
          setValidateRules(data.validateRules);
          printSuccess(`Imported ${data.validateRules.length} validate rule(s).`);
        }
        if (!data.anonymizeRules && !data.validateRules) {
          printError('No valid rules found in the file. Expected "anonymizeRules" and/or "validateRules".');
        }
      } catch (err: any) {
        printError(`Failed to import rules: ${err.message}`);
      }
      break;
    }

    case 'export': {
      if (!options.file) {
        printError('Missing --file option. Usage: config export --file <path>');
        return;
      }
      try {
        const rules = {
          anonymizeRules: getAnonymizeRules(),
          validateRules: getValidateRules(),
        };
        fs.writeJsonSync(options.file, rules, { spaces: 2 });
        printSuccess(`Rules exported to ${chalk.cyan(options.file)}`);
      } catch (err: any) {
        printError(`Failed to export rules: ${err.message}`);
      }
      break;
    }

    default: {
      printError(`Unknown action "${action}". Valid actions: show, reset, path, get, set, rules, import, export`);
      break;
    }
  }
}
