import { z } from "zod";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_INSTRUCTIONS_LENGTH, MAX_SKILL_NAME_LENGTH } from "@/lib/types";

// Request validation for skill routes. Lengths mirror the database checks.

const fields = {
  name: z.string().trim().min(1, "Give it a name.").max(MAX_SKILL_NAME_LENGTH),
  description: z.string().trim().max(MAX_SKILL_DESCRIPTION_LENGTH),
  instructions: z.string().trim().min(1, "Write the instructions.").max(MAX_SKILL_INSTRUCTIONS_LENGTH),
};

export const createSkillBody = z.union([
  z.object({ catalogId: z.string().min(1).max(80) }),
  z.object({ ...fields, description: fields.description.default("") }),
]);

export const patchSkillBody = z
  .object(fields)
  .partial()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change.");
