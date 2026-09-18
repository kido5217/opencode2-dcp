import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse } from "jsonc-parser/lib/esm/main.js";
import Ajv, { type ErrorObject } from "ajv";

export type Permission = "ask" | "allow" | "deny";
export type CompressMode = "range" | "message";
export type LimitValue = number | `${number}%`;

export interface Deduplication {
  enabled: boolean;
  protectedTools: string[];
}

export interface CompressConfig {
  mode: CompressMode;
  permission: Permission;
  showCompression: boolean;
  summaryBuffer: boolean;
  maxContextLimit: LimitValue;
  minContextLimit: LimitValue;
  modelMaxLimits?: Record<string, LimitValue>;
  modelMinLimits?: Record<string, LimitValue>;
  nudgeFrequency: number;
  iterationNudgeThreshold: number;
  nudgeForce: "strong" | "soft";
  protectedTools: string[];
  protectTags: boolean;
  protectUserMessages: boolean;
}

export interface Commands {
  enabled: boolean;
  protectedTools: string[];
}

export interface ManualModeConfig {
  enabled: boolean;
  automaticStrategies: boolean;
}

export interface PurgeErrors {
  enabled: boolean;
  turns: number;
  protectedTools: string[];
}

export interface TurnProtection {
  enabled: boolean;
  turns: number;
}

export interface ExperimentalConfig {
  allowSubAgents: boolean;
  customPrompts: boolean;
}

export interface DcpConfig {
  enabled: boolean;
  debug: boolean;
  pruneNotification: "off" | "minimal" | "detailed";
  pruneNotificationType: "chat" | "toast";
  commands: Commands;
  manualMode: ManualModeConfig;
  turnProtection: TurnProtection;
  experimental: ExperimentalConfig;
  protectedFilePatterns: string[];
  compress: CompressConfig;
  strategies: {
    deduplication: Deduplication;
    purgeErrors: PurgeErrors;
  };
}

const DEFAULT_PROTECTED_TOOLS = [
  "task",
  "skill",
  "todowrite",
  "todoread",
  "compress",
  "batch",
  "plan_enter",
  "plan_exit",
  "write",
  "edit",
];

const COMPRESS_DEFAULT_PROTECTED_TOOLS = ["task", "skill", "todowrite", "todoread"];

const defaultConfig: DcpConfig = {
  enabled: true,
  debug: false,
  pruneNotification: "detailed",
  pruneNotificationType: "chat",
  commands: {
    enabled: true,
    protectedTools: [...DEFAULT_PROTECTED_TOOLS],
  },
  manualMode: {
    enabled: false,
    automaticStrategies: true,
  },
  turnProtection: {
    enabled: false,
    turns: 4,
  },
  experimental: {
    allowSubAgents: false,
    customPrompts: false,
  },
  protectedFilePatterns: [],
  compress: {
    mode: "range",
    permission: "allow",
    showCompression: false,
    summaryBuffer: true,
    maxContextLimit: 100000,
    minContextLimit: 50000,
    nudgeFrequency: 5,
    iterationNudgeThreshold: 15,
    nudgeForce: "soft",
    protectedTools: [...COMPRESS_DEFAULT_PROTECTED_TOOLS],
    protectTags: false,
    protectUserMessages: false,
  },
  strategies: {
    deduplication: {
      enabled: true,
      protectedTools: [],
    },
    purgeErrors: {
      enabled: true,
      turns: 4,
      protectedTools: [],
    },
  },
};

export const CONFIG_FILE_JSONC = "opencode-dcp.jsonc";
export const CONFIG_FILE_JSON = "opencode-dcp.json";
export const SCHEMA_URL =
  "https://raw.githubusercontent.com/kido5217/opencode2-dcp/port/opencode-dcp.schema.json";

export interface ConfigInput {
  /** Directory holding the global config file. Default: `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. */
  globalDir?: string;
  /** Extra config directory layer (v1: `$OPENCODE_CONFIG_DIR`). Default: `process.env.OPENCODE_CONFIG_DIR`. */
  configDir?: string;
  /** Project walk-up start directory (v1: `ctx.directory`). Default: `process.cwd()`. */
  startDir?: string;
  /** Write the default global config file when none exists. Default: true. */
  writeDefault?: boolean;
}

export interface ConfigLayer {
  name: string;
  path: string | null;
  present: boolean;
  parseError?: string;
}

export interface ResolvedConfig {
  config: DcpConfig;
  layers: ConfigLayer[];
  warnings: string[];
  debugLines: string[];
}

let schemaCache: Record<string, unknown> | null = null;

export function loadConfigSchema(): Record<string, unknown> {
  if (schemaCache) return schemaCache;
  const schemaPath = new URL("../opencode-dcp.schema.json", import.meta.url);
  schemaCache = JSON.parse(readFileSync(schemaPath, "utf-8")) as Record<string, unknown>;
  return schemaCache;
}

let ajvInstance: Ajv | null = null;

function getAjv(): Ajv {
  if (!ajvInstance) {
    ajvInstance = new Ajv({ strict: false, allErrors: true });
  }
  return ajvInstance;
}

const LIMIT_KEY_RE =
  /(^|\.)((?:modelMaxLimits|modelMinLimits)\.[^.]+|(?:maxContextLimit|minContextLimit))$/;
const LIMIT_FORMAT = 'number | "${number}%"';

function keyFromInstancePath(instancePath: string): string {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function resolveInstancePath(data: unknown, instancePath: string): unknown {
  if (instancePath === "") return data;
  let value: unknown = data;
  for (const rawSegment of instancePath.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function formatAjvError(error: ErrorObject, data: unknown): string {
  const key = keyFromInstancePath(error.instancePath) || "(root)";

  const value =
    error.data !== undefined ? error.data : resolveInstancePath(data, error.instancePath);
  let expected: string;
  if (error.keyword === "type") {
    expected = String((error.params as { type?: string }).type);
  } else if (error.keyword === "enum") {
    expected =
      (error.params as { allowedValues?: unknown[] }).allowedValues
        ?.map((v) => JSON.stringify(v))
        .join(" | ") ?? "enum value";
  } else if (error.keyword === "oneOf" && LIMIT_KEY_RE.test(key)) {
    expected = LIMIT_FORMAT;
  } else if (error.keyword === "minimum") {
    return `${key}: expected number >= ${String((error.params as { limit?: number }).limit)}, got ${JSON.stringify(value)}`;
  } else {
    expected = error.message ?? "match the schema";
  }
  return `${key}: expected ${expected}, got ${JSON.stringify(value)}`;
}

function validateConfigTypes(data: Record<string, unknown>): string[] {
  let valid: boolean;
  let errors: ErrorObject[] | null | undefined;
  try {
    const validate = getAjv().compile(loadConfigSchema());
    valid = validate(data);
    errors = validate.errors;
  } catch (error) {
    // Schema loading/compilation must never fail config resolution.
    return [`schema validation unavailable: ${String(error)}`];
  }
  if (valid) return [];
  const allErrors = errors ?? [];
  const oneOfLimitPaths = allErrors
    .filter(
      (error) =>
        error.keyword === "oneOf" && LIMIT_KEY_RE.test(keyFromInstancePath(error.instancePath)),
    )
    .map((error) => error.schemaPath);
  const messages: string[] = [];
  const unknownMessages: string[] = [];
  const unknownByLocation = new Map<string, string[]>();
  for (const error of allErrors) {
    const isOneOfSubError =
      error.keyword !== "oneOf" &&
      oneOfLimitPaths.some((oneOfPath) => error.schemaPath.startsWith(oneOfPath + "/"));
    if (isOneOfSubError) continue;
    if (error.keyword === "additionalProperties") {
      const location = keyFromInstancePath(error.instancePath);
      const prop = (error.params as { additionalProperty?: string }).additionalProperty ?? "";
      const fullKey = location ? `${location}.${prop}` : prop;
      const keys = unknownByLocation.get(location) ?? [];
      keys.push(fullKey);
      unknownByLocation.set(location, keys);
      continue;
    }
    messages.push(formatAjvError(error, data));
  }
  for (const keys of unknownByLocation.values()) {
    const keyList = keys.slice(0, 3).join(", ");
    const suffix = keys.length > 3 ? ` (+${keys.length - 3} more)` : "";
    unknownMessages.push(`Unknown keys: ${keyList}${suffix}`);
  }
  return [...unknownMessages, ...messages];
}

function findOpencodeDir(startDir: string): string | null {
  let current = startDir;
  while (current !== "/") {
    const candidate = join(current, ".opencode");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

function firstExisting(...paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

export function defaultGlobalConfigDir(): string {
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, "opencode")
    : join(homedir(), ".config", "opencode");
}

export function getConfigPaths(input: ConfigInput): {
  globalDir: string;
  configDir: string | null;
  startDir: string;
} {
  return {
    globalDir: input.globalDir ?? defaultGlobalConfigDir(),
    configDir: input.configDir ?? process.env.OPENCODE_CONFIG_DIR ?? null,
    startDir: input.startDir ?? process.cwd(),
  };
}

export function findConfigFiles(input: ConfigInput): ConfigLayer[] {
  const { globalDir, configDir, startDir } = getConfigPaths(input);

  const global = firstExisting(
    join(globalDir, CONFIG_FILE_JSONC),
    join(globalDir, CONFIG_FILE_JSON),
  );

  let configDirFile: string | null = null;
  if (configDir) {
    configDirFile = firstExisting(
      join(configDir, CONFIG_FILE_JSONC),
      join(configDir, CONFIG_FILE_JSON),
    );
  }

  let projectFile: string | null = null;
  const opencodeDir = findOpencodeDir(startDir);
  if (opencodeDir) {
    projectFile = firstExisting(
      join(opencodeDir, CONFIG_FILE_JSONC),
      join(opencodeDir, CONFIG_FILE_JSON),
    );
  }

  return [
    { name: "config", path: global, present: global !== null },
    { name: "configDir config", path: configDirFile, present: configDirFile !== null },
    { name: "project config", path: projectFile, present: projectFile !== null },
  ];
}

interface ConfigLoadResult {
  data: Record<string, any> | null;
  parseError?: string;
}

function loadConfigFile(configPath: string): ConfigLoadResult {
  let fileContent = "";
  try {
    fileContent = readFileSync(configPath, "utf-8");
  } catch {
    return { data: null };
  }

  try {
    const parsed = parse(fileContent, undefined, { allowTrailingComma: true });
    if (parsed === undefined || parsed === null) {
      return { data: null, parseError: "Config file is empty or invalid" };
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: null, parseError: "Config file must be a JSON object" };
    }
    return { data: parsed };
  } catch (error: any) {
    return { data: null, parseError: error.message || "Failed to parse config" };
  }
}

export function ensureDefaultGlobalConfig(globalDir: string): string | null {
  const existing = firstExisting(
    join(globalDir, CONFIG_FILE_JSONC),
    join(globalDir, CONFIG_FILE_JSON),
  );
  if (existing) return null;

  if (!existsSync(globalDir)) {
    mkdirSync(globalDir, { recursive: true });
  }
  const configPath = join(globalDir, CONFIG_FILE_JSONC);
  writeFileSync(configPath, `{\n  "$schema": "${SCHEMA_URL}"\n}\n`, "utf-8");
  return configPath;
}

type CompressOverride = Partial<CompressConfig>;

function mergeStrategies(
  base: DcpConfig["strategies"],
  override?: Partial<DcpConfig["strategies"]>,
): DcpConfig["strategies"] {
  if (!override) {
    return base;
  }

  return {
    deduplication: {
      enabled: override.deduplication?.enabled ?? base.deduplication.enabled,
      protectedTools: [
        ...new Set([
          ...base.deduplication.protectedTools,
          ...(override.deduplication?.protectedTools ?? []),
        ]),
      ],
    },
    purgeErrors: {
      enabled: override.purgeErrors?.enabled ?? base.purgeErrors.enabled,
      turns: override.purgeErrors?.turns ?? base.purgeErrors.turns,
      protectedTools: [
        ...new Set([
          ...base.purgeErrors.protectedTools,
          ...(override.purgeErrors?.protectedTools ?? []),
        ]),
      ],
    },
  };
}

function mergeCompress(
  base: DcpConfig["compress"],
  override?: CompressOverride,
): DcpConfig["compress"] {
  if (!override) {
    return base;
  }

  return {
    mode: override.mode ?? base.mode,
    permission: override.permission ?? base.permission,
    showCompression: override.showCompression ?? base.showCompression,
    summaryBuffer: override.summaryBuffer ?? base.summaryBuffer,
    maxContextLimit: override.maxContextLimit ?? base.maxContextLimit,
    minContextLimit: override.minContextLimit ?? base.minContextLimit,
    modelMaxLimits: override.modelMaxLimits ?? base.modelMaxLimits,
    modelMinLimits: override.modelMinLimits ?? base.modelMinLimits,
    nudgeFrequency: override.nudgeFrequency ?? base.nudgeFrequency,
    iterationNudgeThreshold: override.iterationNudgeThreshold ?? base.iterationNudgeThreshold,
    nudgeForce: override.nudgeForce ?? base.nudgeForce,
    protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
    protectTags: override.protectTags ?? base.protectTags,
    protectUserMessages: override.protectUserMessages ?? base.protectUserMessages,
  };
}

function mergeCommands(
  base: DcpConfig["commands"],
  override?: Partial<DcpConfig["commands"]>,
): DcpConfig["commands"] {
  if (!override) {
    return base;
  }

  return {
    enabled: override.enabled ?? base.enabled,
    protectedTools: [...new Set([...base.protectedTools, ...(override.protectedTools ?? [])])],
  };
}

function mergeManualMode(
  base: DcpConfig["manualMode"],
  override?: Partial<DcpConfig["manualMode"]>,
): DcpConfig["manualMode"] {
  if (override === undefined) return base;

  return {
    enabled: override.enabled ?? base.enabled,
    automaticStrategies: override.automaticStrategies ?? base.automaticStrategies,
  };
}

function mergeExperimental(
  base: DcpConfig["experimental"],
  override?: Partial<DcpConfig["experimental"]>,
): DcpConfig["experimental"] {
  if (override === undefined) return base;

  return {
    allowSubAgents: override.allowSubAgents ?? base.allowSubAgents,
    customPrompts: override.customPrompts ?? base.customPrompts,
  };
}

function deepCloneConfig(config: DcpConfig): DcpConfig {
  return {
    ...config,
    commands: {
      enabled: config.commands.enabled,
      protectedTools: [...config.commands.protectedTools],
    },
    manualMode: {
      enabled: config.manualMode.enabled,
      automaticStrategies: config.manualMode.automaticStrategies,
    },
    turnProtection: { ...config.turnProtection },
    experimental: { ...config.experimental },
    protectedFilePatterns: [...config.protectedFilePatterns],
    compress: {
      ...config.compress,
      modelMaxLimits: config.compress.modelMaxLimits
        ? { ...config.compress.modelMaxLimits }
        : undefined,
      modelMinLimits: config.compress.modelMinLimits
        ? { ...config.compress.modelMinLimits }
        : undefined,
      protectedTools: [...config.compress.protectedTools],
    },
    strategies: {
      deduplication: {
        ...config.strategies.deduplication,
        protectedTools: [...config.strategies.deduplication.protectedTools],
      },
      purgeErrors: {
        ...config.strategies.purgeErrors,
        protectedTools: [...config.strategies.purgeErrors.protectedTools],
      },
    },
  };
}

function mergeLayer(config: DcpConfig, data: Record<string, any>): DcpConfig {
  return {
    enabled: data.enabled ?? config.enabled,
    debug: data.debug ?? config.debug,
    pruneNotification: data.pruneNotification ?? config.pruneNotification,
    pruneNotificationType: data.pruneNotificationType ?? config.pruneNotificationType,
    commands: mergeCommands(config.commands, data.commands as Partial<Commands>),
    manualMode: mergeManualMode(config.manualMode, data.manualMode as Partial<ManualModeConfig>),
    turnProtection: {
      enabled: data.turnProtection?.enabled ?? config.turnProtection.enabled,
      turns: data.turnProtection?.turns ?? config.turnProtection.turns,
    },
    experimental: mergeExperimental(
      config.experimental,
      data.experimental as Partial<ExperimentalConfig>,
    ),
    protectedFilePatterns: [
      ...new Set([...config.protectedFilePatterns, ...(data.protectedFilePatterns ?? [])]),
    ],
    compress: mergeCompress(config.compress, data.compress as CompressOverride),
    strategies: mergeStrategies(
      config.strategies,
      data.strategies as Partial<DcpConfig["strategies"]>,
    ),
  };
}

/**
 * Resolve the DCP config from the global, `$OPENCODE_CONFIG_DIR`, and project
 * `.opencode/` layers (each level overrides the previous; arrays are
 * union-merged), validate every layer against `opencode-dcp.schema.json`, and
 * return the merged config with per-layer parse/validation warnings and the
 * debug log lines describing the resolution.
 */
export function resolveDcpConfig(input: ConfigInput = {}): ResolvedConfig {
  const { globalDir } = getConfigPaths(input);

  if (input.writeDefault !== false) {
    ensureDefaultGlobalConfig(globalDir);
  }

  const layers = findConfigFiles(input);
  let config = deepCloneConfig(defaultConfig);
  const warnings: string[] = [];

  for (const layer of layers) {
    if (!layer.path) {
      continue;
    }

    const result = loadConfigFile(layer.path);
    if (result.parseError) {
      layer.parseError = result.parseError;
      warnings.push(
        `Invalid ${layer.name}: ${layer.path}\n${result.parseError}\nUsing previous/default values`,
      );
      continue;
    }

    if (!result.data) {
      continue;
    }

    const typeErrors = validateConfigTypes(result.data);
    for (const message of typeErrors) {
      warnings.push(`${layer.name} (${layer.path}): ${message}`);
    }
    config = mergeLayer(config, result.data);
  }

  const debugLines: string[] = [];
  debugLines.push(
    `config layers: ${layers
      .map(
        (l) =>
          `${l.name}=${l.path ?? "(absent)"}${l.parseError ? ` (parse error: ${l.parseError})` : ""}`,
      )
      .join(" ")}`,
  );
  debugLines.push(`config resolved: ${JSON.stringify(config)}`);
  for (const warning of warnings) {
    debugLines.push(`config warning: ${warning.replace(/\n/g, " | ")}`);
  }

  return { config, layers, warnings, debugLines };
}
