import * as z from "zod/v4";
import { nodeActorSchema } from "./node-provenance.js";

/** One observed Node revision, one descriptor edit. */
export const nodeWriteInputSchema = z
  .strictObject({
    baseEtag: z.string().trim().min(1),
    body: z.string().optional(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
    confirm: z.boolean().optional(),
    by: nodeActorSchema.optional(),
    readBack: z.boolean().optional(),
  })
  .refine(
    (p) =>
      p.body !== undefined ||
      p.confirm === true ||
      (p.frontmatter !== undefined && Object.keys(p.frontmatter).length > 0),
    "Supply body or frontmatter to write",
  );
