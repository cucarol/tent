import * as z from "zod/v4";
import { isNodeId } from "./id.js";
import { repositoryMaterialSchema } from "./repository-material.js";

const version = z.string().regex(/^[a-f0-9]{64}$/);
const materialBasisSchema = z.looseObject({
  identity: z.string(),
  version: version.optional(),
  fingerprintVersion: z.literal(2).optional(),
  repository: repositoryMaterialSchema.optional(),
});
export const nodeBasisRecordSchema = z
  .looseObject({
    v: z.literal(1),
    materials: z.array(materialBasisSchema),
    goals: z
      .array(
        z.looseObject({
          nodeId: z.string().refine(isNodeId),
          version,
          fingerprintVersion: z.literal(2),
          materials: z.array(materialBasisSchema),
        }),
      )
      .optional(),
  })
  .superRefine((record, context) => {
    for (const [index, material] of record.materials.entries())
      if (material.version && material.fingerprintVersion !== 2)
        context.addIssue({
          code: "custom",
          path: ["materials", index],
          message: "Versioned material requires fingerprintVersion 2",
        });
    for (const [index, goal] of (record.goals ?? []).entries())
      for (const [materialIndex, material] of goal.materials.entries())
        if (material.version && material.fingerprintVersion !== 2)
          context.addIssue({
            code: "custom",
            path: ["goals", index, "materials", materialIndex],
            message: "Versioned material requires fingerprintVersion 2",
          });
  });
export type NodeBasisRecord = z.infer<typeof nodeBasisRecordSchema>;
