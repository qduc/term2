export type JsonSchemaDefinitionEntry = Record<string, any>;

export type JsonObjectSchema = {
  type: 'object';
  properties: Record<string, JsonSchemaDefinitionEntry>;
  required: string[];
  additionalProperties: boolean;
  description?: string;
};

/** Application-owned JSON schema shape for structured model output. */
export type JsonSchemaDefinition = {
  type: 'json_schema';
  name: string;
  strict: boolean;
  schema: JsonObjectSchema;
};
