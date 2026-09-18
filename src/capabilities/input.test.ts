import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCapabilityInput } from "./input.js";
import type { JsonSchema } from "./types.js";

const schema: JsonSchema = {
  type: "object",
  properties: {
    branch: {
      type: "string",
      minLength: 1,
      maxLength: 40,
    },
    retries: { type: "integer", minimum: 0, maximum: 3 },
    dryRun: { type: "boolean" },
    tags: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
      maxItems: 2,
    },
    options: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
      additionalProperties: false,
      minProperties: 1,
      maxProperties: 1,
    },
  },
  required: ["branch", "retries", "dryRun", "tags", "options"],
  additionalProperties: false,
};

describe("capability input schema", () => {
  it("accepts a value that satisfies required fields and nested bounds", () => {
    assert.equal(
      validateCapabilityInput(schema, {
        branch: "main",
        retries: 2,
        dryRun: false,
        tags: ["release"],
        options: { target: "staging" },
      }),
      true,
    );
  });

  it("rejects missing fields, primitive mismatches, and violated bounds", () => {
    assert.equal(validateCapabilityInput(schema, {}), false);
    assert.equal(
      validateCapabilityInput(schema, {
        branch: "Main",
        retries: 4,
        dryRun: "false",
        tags: [],
        options: { target: "staging" },
      }),
      false,
    );
  });

  it("rejects additional object properties when the declared schema forbids them", () => {
    assert.equal(
      validateCapabilityInput(schema, {
        branch: "main",
        retries: 0,
        dryRun: true,
        tags: ["release"],
        options: { target: "staging" },
        unexpected: true,
      }),
      false,
    );
    assert.equal(
      validateCapabilityInput(schema, {
        branch: "main",
        retries: 0,
        dryRun: true,
        tags: ["release"],
        options: { target: "staging", unexpected: true },
      }),
      false,
    );
  });

  it("fails closed for malformed or unsupported runtime schema values", () => {
    assert.equal(
      validateCapabilityInput(
        {
          type: "object",
          properties: { branch: { type: "string", format: "uri" } },
        } as unknown as JsonSchema,
        { branch: "main" },
      ),
      false,
    );
    assert.equal(
      validateCapabilityInput(
        {
          type: "object",
          additionalProperties: "yes",
        } as unknown as JsonSchema,
        {},
      ),
      false,
    );
  });

  it("rejects runtime schemas that declare patterns", () => {
    for (const pattern of ["^(a+)+$", "^[a-z0-9._-]+$"]) {
      assert.equal(
        validateCapabilityInput(
          {
            type: "object",
            properties: {
              value: { type: "string", maxLength: 32, pattern },
            },
          } as unknown as JsonSchema,
          { value: "release-2026.09" },
        ),
        false,
      );
    }
  });
});
