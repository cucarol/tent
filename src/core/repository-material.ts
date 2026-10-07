import * as z from "zod/v4";
import path from "node:path";

/** Local repository location retained with a material's observed content basis. */
export const repositoryMaterialSchema = z.looseObject({
  commonDir: z
    .string()
    .min(1)
    .refine((value) => !path.isAbsolute(value) && !/^[a-z]:[\\/]/i.test(value))
    .refine((value) => !value.startsWith("\\\\") && !value.startsWith("//")),
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !/[\\:\x00-\x1f\x7f]/.test(value) &&
        value
          .split("/")
          .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git"),
    ),
  blob: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
});
export type RepositoryMaterial = z.infer<typeof repositoryMaterialSchema>;
