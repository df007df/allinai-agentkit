export const CAPABILITY_CONTEXT_KEYS = [
  "execution",
  "workspace",
  "projectConfig",
] as const;

export type CapabilityContextKey = (typeof CAPABILITY_CONTEXT_KEYS)[number];

export const CAPABILITY_PERMISSIONS = ["workspace:write", "network"] as const;

export type CapabilityPermission = (typeof CAPABILITY_PERMISSIONS)[number];

type JsonSchemaDescription = { description?: string };

export type JsonSchema = JsonSchemaDescription & {
  type: "object";
  properties?: Record<string, JsonSchemaValue>;
  required?: string[];
  additionalProperties?: boolean;
  minProperties?: number;
  maxProperties?: number;
};

export type JsonSchemaValue =
  | JsonSchema
  | (JsonSchemaDescription & {
      type: "array";
      items: JsonSchemaValue;
      minItems?: number;
      maxItems?: number;
    })
  | (JsonSchemaDescription & {
      type: "string";
      minLength?: number;
      maxLength?: number;
    })
  | (JsonSchemaDescription & {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
    })
  | (JsonSchemaDescription & { type: "boolean" | "null" });

/** A fixed plugin entrypoint. Hub input is JSON only; it is never a command. */
export type ShellCapability = {
  id: string;
  entry: string;
  inputSchema: JsonSchema;
  contextKeys: CapabilityContextKey[];
  permissions: CapabilityPermission[];
  timeoutSeconds: number;
};

export type PolicyDecision = {
  mode: "auto" | "approval" | "deny";
  reason: string;
};
