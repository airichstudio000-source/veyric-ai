export interface ProtectionConfig {
  trustProxyHops: number;
  rateLimit: {
    userRpm: number;
    ipRpm: number;
    userDaily: number;
    ipDaily: number;
    followupRpm: number;
  };
  concurrency: {
    maxPerUser: number;
    maxGeminiGlobal: number;
  };
  uploads: {
    maxFileSizeBytes: number;
    maxFilesPerRequest: number;
    maxTotalUploadBytes: number;
    maxFormFieldBytes: number;
  };
  limits: {
    maxPromptChars: number;
    maxHistoryTurns: number;
    maxHistoryTurnChars: number;
    maxHistoryTotalChars: number;
  };
  staging: {
    enabled: boolean;
    allowedUids: readonly string[];
  };
  timeouts: {
    chatMs: number;
    fileUploadMs: number;
    followupMs: number;
  };
}

interface IntEnvSpec {
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}

const ENV_SPECS = {
  TRUST_PROXY_HOPS: {
    name: 'TRUST_PROXY_HOPS',
    defaultValue: 1,
    min: 0,
    max: 10,
  },
  RATE_LIMIT_USER_RPM: {
    name: 'RATE_LIMIT_USER_RPM',
    defaultValue: 12,
    min: 1,
    max: 120,
  },
  RATE_LIMIT_IP_RPM: {
    name: 'RATE_LIMIT_IP_RPM',
    defaultValue: 24,
    min: 1,
    max: 300,
  },
  RATE_LIMIT_USER_DAILY: {
    name: 'RATE_LIMIT_USER_DAILY',
    defaultValue: 100,
    min: 1,
    max: 2000,
  },
  RATE_LIMIT_IP_DAILY: {
    name: 'RATE_LIMIT_IP_DAILY',
    defaultValue: 250,
    min: 1,
    max: 5000,
  },
  RATE_LIMIT_FOLLOWUP_RPM: {
    name: 'RATE_LIMIT_FOLLOWUP_RPM',
    defaultValue: 10,
    min: 1,
    max: 120,
  },
  MAX_CONCURRENT_PER_USER: {
    name: 'MAX_CONCURRENT_PER_USER',
    defaultValue: 2,
    min: 1,
    max: 10,
  },
  MAX_CONCURRENT_GEMINI: {
    name: 'MAX_CONCURRENT_GEMINI',
    defaultValue: 12,
    min: 1,
    max: 100,
  },
  MAX_FILE_SIZE_BYTES: {
    name: 'MAX_FILE_SIZE_BYTES',
    defaultValue: 26_214_400, // 25 MiB
    min: 1024,
    max: 31_457_280, // 30 MiB
  },
  MAX_FILES_PER_REQUEST: {
    name: 'MAX_FILES_PER_REQUEST',
    defaultValue: 5,
    min: 1,
    max: 10,
  },
  MAX_TOTAL_UPLOAD_BYTES: {
    name: 'MAX_TOTAL_UPLOAD_BYTES',
    defaultValue: 26_214_400, // 25 MiB
    min: 1024,
    max: 31_457_280, // 30 MiB
  },
  MAX_PROMPT_CHARS: {
    name: 'MAX_PROMPT_CHARS',
    defaultValue: 8000,
    min: 100,
    max: 50_000,
  },
  MAX_HISTORY_TURNS: {
    name: 'MAX_HISTORY_TURNS',
    defaultValue: 28,
    min: 1,
    max: 100,
  },
  MAX_HISTORY_TURN_CHARS: {
    name: 'MAX_HISTORY_TURN_CHARS',
    defaultValue: 8000,
    min: 100,
    max: 50_000,
  },
  MAX_HISTORY_TOTAL_CHARS: {
    name: 'MAX_HISTORY_TOTAL_CHARS',
    defaultValue: 48_000,
    min: 100,
    max: 200_000,
  },
  MAX_FORM_FIELD_BYTES: {
    name: 'MAX_FORM_FIELD_BYTES',
    defaultValue: 262_144, // 256 KiB
    min: 4096,
    max: 2_097_152, // 2 MiB
  },
  GEMINI_CHAT_TIMEOUT_MS: {
    name: 'GEMINI_CHAT_TIMEOUT_MS',
    defaultValue: 120_000, // 2 minutes
    min: 5_000,
    max: 300_000, // 5 minutes
  },
  GEMINI_FILE_UPLOAD_TIMEOUT_MS: {
    name: 'GEMINI_FILE_UPLOAD_TIMEOUT_MS',
    defaultValue: 60_000, // 1 minute
    min: 5_000,
    max: 300_000, // 5 minutes
  },
  GEMINI_FOLLOWUP_TIMEOUT_MS: {
    name: 'GEMINI_FOLLOWUP_TIMEOUT_MS',
    defaultValue: 15_000, // 15 seconds
    min: 1_000,
    max: 60_000, // 1 minute
  },
} as const satisfies Record<string, IntEnvSpec>;

export interface ConfigValidationWarning {
  variable: string;
  reason: string;
  fallbackValue: number;
}

function parseBoundedIntegerEnv(
  env: Record<string, string | undefined>,
  spec: IntEnvSpec,
  warnings: ConfigValidationWarning[]
): number {
  const raw = env[spec.name];
  if (raw === undefined || raw.trim() === '') {
    return spec.defaultValue;
  }

  const trimmed = raw.trim();

  // Reject floats, NaN, Infinity, scientific notation, and trailing garbage
  if (!/^[+-]?\d+$/.test(trimmed)) {
    warnings.push({
      variable: spec.name,
      reason: 'Value is not a valid base-10 integer',
      fallbackValue: spec.defaultValue,
    });
    return spec.defaultValue;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    warnings.push({
      variable: spec.name,
      reason: 'Value is outside the safe integer range',
      fallbackValue: spec.defaultValue,
    });
    return spec.defaultValue;
  }

  if (parsed < spec.min || parsed > spec.max) {
    warnings.push({
      variable: spec.name,
      reason: `Value must be between ${spec.min} and ${spec.max}`,
      fallbackValue: spec.defaultValue,
    });
    return spec.defaultValue;
  }

  return parsed;
}

export function isStagingEnvironmentEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  const nodeEnv = env.NODE_ENV?.trim().toLowerCase();
  const appEnv = env.APP_ENV?.trim().toLowerCase();
  const flag = env.STAGING_ALLOWLIST_ENABLED?.trim().toLowerCase();

  if (nodeEnv === 'staging' || appEnv === 'staging') {
    return true;
  }
  return flag === 'true' || flag === '1';
}

export function parseStagingAllowedUids(
  rawValue: string | undefined,
  warnings?: ConfigValidationWarning[]
): readonly string[] {
  if (!rawValue || rawValue.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  let rejectedTokenCount = 0;

  for (const part of rawValue.split(',')) {
    const uid = part.trim();
    if (!uid) continue;

    // Firebase UIDs do not contain whitespace or control characters and fit <= 128 chars
    if (/\s/.test(uid) || uid.length > 128) {
      rejectedTokenCount += 1;
      continue;
    }

    seen.add(uid);
  }

  if (rejectedTokenCount > 0 && warnings) {
    warnings.push({
      variable: 'STAGING_ALLOWED_UIDS',
      reason: `Ignored ${rejectedTokenCount} malformed UID token(s)`,
      fallbackValue: seen.size,
    });
  }

  return Array.from(seen);
}

export function resolveProtectionConfig(
  env: Record<string, string | undefined> = process.env
): { config: ProtectionConfig; warnings: ConfigValidationWarning[] } {
  const warnings: ConfigValidationWarning[] = [];

  const trustProxyHops = parseBoundedIntegerEnv(env, ENV_SPECS.TRUST_PROXY_HOPS, warnings);
  const userRpm = parseBoundedIntegerEnv(env, ENV_SPECS.RATE_LIMIT_USER_RPM, warnings);
  const ipRpm = parseBoundedIntegerEnv(env, ENV_SPECS.RATE_LIMIT_IP_RPM, warnings);
  const userDaily = parseBoundedIntegerEnv(env, ENV_SPECS.RATE_LIMIT_USER_DAILY, warnings);
  const ipDaily = parseBoundedIntegerEnv(env, ENV_SPECS.RATE_LIMIT_IP_DAILY, warnings);
  const followupRpm = parseBoundedIntegerEnv(env, ENV_SPECS.RATE_LIMIT_FOLLOWUP_RPM, warnings);

  const maxPerUser = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_CONCURRENT_PER_USER, warnings);
  let maxGeminiGlobal = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_CONCURRENT_GEMINI, warnings);
  if (maxGeminiGlobal < maxPerUser) {
    maxGeminiGlobal = Math.max(maxPerUser, ENV_SPECS.MAX_CONCURRENT_GEMINI.defaultValue);
    warnings.push({
      variable: ENV_SPECS.MAX_CONCURRENT_GEMINI.name,
      reason: 'Value cannot be lower than MAX_CONCURRENT_PER_USER',
      fallbackValue: maxGeminiGlobal,
    });
  }

  const maxFileSizeBytes = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_FILE_SIZE_BYTES, warnings);
  const maxFilesPerRequest = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_FILES_PER_REQUEST, warnings);
  let maxTotalUploadBytes = parseBoundedIntegerEnv(
    env,
    ENV_SPECS.MAX_TOTAL_UPLOAD_BYTES,
    warnings
  );
  if (maxTotalUploadBytes < maxFileSizeBytes) {
    maxTotalUploadBytes = Math.min(
      Math.max(maxFileSizeBytes, ENV_SPECS.MAX_TOTAL_UPLOAD_BYTES.defaultValue),
      ENV_SPECS.MAX_TOTAL_UPLOAD_BYTES.max
    );
    warnings.push({
      variable: ENV_SPECS.MAX_TOTAL_UPLOAD_BYTES.name,
      reason: 'Value cannot be lower than MAX_FILE_SIZE_BYTES',
      fallbackValue: maxTotalUploadBytes,
    });
  }

  const maxFormFieldBytes = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_FORM_FIELD_BYTES, warnings);
  const maxPromptChars = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_PROMPT_CHARS, warnings);
  const maxHistoryTurns = parseBoundedIntegerEnv(env, ENV_SPECS.MAX_HISTORY_TURNS, warnings);
  const maxHistoryTurnChars = parseBoundedIntegerEnv(
    env,
    ENV_SPECS.MAX_HISTORY_TURN_CHARS,
    warnings
  );
  let maxHistoryTotalChars = parseBoundedIntegerEnv(
    env,
    ENV_SPECS.MAX_HISTORY_TOTAL_CHARS,
    warnings
  );
  if (maxHistoryTotalChars < maxHistoryTurnChars) {
    maxHistoryTotalChars = Math.min(
      Math.max(maxHistoryTurnChars, ENV_SPECS.MAX_HISTORY_TOTAL_CHARS.defaultValue),
      ENV_SPECS.MAX_HISTORY_TOTAL_CHARS.max
    );
    warnings.push({
      variable: ENV_SPECS.MAX_HISTORY_TOTAL_CHARS.name,
      reason: 'Value cannot be lower than MAX_HISTORY_TURN_CHARS',
      fallbackValue: maxHistoryTotalChars,
    });
  }

  const stagingEnabled = isStagingEnvironmentEnabled(env);
  const stagingAllowedUids = parseStagingAllowedUids(env.STAGING_ALLOWED_UIDS, warnings);

  const chatTimeoutMs = parseBoundedIntegerEnv(env, ENV_SPECS.GEMINI_CHAT_TIMEOUT_MS, warnings);
  const fileUploadTimeoutMs = parseBoundedIntegerEnv(
    env,
    ENV_SPECS.GEMINI_FILE_UPLOAD_TIMEOUT_MS,
    warnings
  );
  const followupTimeoutMs = parseBoundedIntegerEnv(
    env,
    ENV_SPECS.GEMINI_FOLLOWUP_TIMEOUT_MS,
    warnings
  );

  const config: ProtectionConfig = {
    trustProxyHops,
    rateLimit: {
      userRpm,
      ipRpm,
      userDaily,
      ipDaily,
      followupRpm,
    },
    concurrency: {
      maxPerUser,
      maxGeminiGlobal,
    },
    uploads: {
      maxFileSizeBytes,
      maxFilesPerRequest,
      maxTotalUploadBytes,
      maxFormFieldBytes,
    },
    limits: {
      maxPromptChars,
      maxHistoryTurns,
      maxHistoryTurnChars,
      maxHistoryTotalChars,
    },
    staging: {
      enabled: stagingEnabled,
      allowedUids: stagingAllowedUids,
    },
    timeouts: {
      chatMs: chatTimeoutMs,
      fileUploadMs: fileUploadTimeoutMs,
      followupMs: followupTimeoutMs,
    },
  };

  return { config, warnings };
}

export function loadProtectionConfig(
  env: Record<string, string | undefined> = process.env
): ProtectionConfig {
  const { config, warnings } = resolveProtectionConfig(env);
  for (const warning of warnings) {
    console.warn(
      `[VEYRIC Config] Rejected invalid ${warning.variable} (${warning.reason}). Using safe fallback value.`
    );
  }
  return config;
}

const resolved = loadProtectionConfig();

export const protectionConfig: ProtectionConfig = Object.freeze({
  ...resolved,
  rateLimit: Object.freeze({ ...resolved.rateLimit }),
  concurrency: Object.freeze({ ...resolved.concurrency }),
  uploads: Object.freeze({ ...resolved.uploads }),
  limits: Object.freeze({ ...resolved.limits }),
  staging: Object.freeze({
    enabled: resolved.staging.enabled,
    allowedUids: Object.freeze([...resolved.staging.allowedUids]),
  }),
  timeouts: Object.freeze({ ...resolved.timeouts }),
});
